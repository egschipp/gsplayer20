import { getDb } from "@/lib/db/client";
import { playlists, userPlaylists, syncState } from "@/lib/db/schema";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { encodeCursor, tryDecodeCursor } from "@/lib/spotify/cursor";
import {
  jsonError,
  rateLimitResponse,
  requireAppUser,
  jsonPrivateCache,
  jsonNoStore,
} from "@/lib/api/guards";
import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { incCounter } from "@/lib/observability/metrics";
import {
  buildDataSourceMeta,
  computeStaleSec,
  getSpotifyResourcePolicy,
} from "@/lib/spotify/cachePolicy";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { session, response } = await requireAppUser();
  if (response) return response;
  const rl = await rateLimitResponse({
    key: `playlists:${session.appUserId}`,
    limit: 600,
    windowMs: 60_000,
  });
  if (rl) return rl;

  const { searchParams } = new URL(req.url);
  const limitValue = Number(searchParams.get("limit") ?? "50");
  const limit =
    Number.isFinite(limitValue) && limitValue > 0
      ? Math.min(Math.floor(limitValue), 50)
      : 50;
  const cursor = searchParams.get("cursor");
  const live = searchParams.get("live") === "1";
  const policy = getSpotifyResourcePolicy("playlists");
  let liveFallbackReason: string | null = null;

  if (live) {
    const parsedOffset = Number(cursor ?? "0");
    const offset =
      Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0;
    try {
      const liveData = await spotifyFetch<{
        items?: Array<{
          id?: string;
          name?: string;
          owner?: { id?: string; display_name?: string };
          description?: string | null;
          images?: Array<{ url?: string | null }>;
          public?: boolean;
          collaborative?: boolean;
          snapshot_id?: string;
          tracks?: { total?: number };
        }>;
        next?: string | null;
      }>({
        url: `https://api.spotify.com/v1/me/playlists?limit=${limit}&offset=${offset}`,
        userLevel: true,
        priority: "default",
        cacheTtlMs: policy.cacheTtlMs,
        dedupeWindowMs: policy.dedupeWindowMs,
      });
      const now = Date.now();
      const liveItems = Array.isArray(liveData?.items)
        ? liveData.items
            .map((item) => {
              const playlistId = String(item?.id ?? "").trim();
              if (!playlistId) return null;
              return {
                playlistId,
                name: item?.name ?? "Untitled playlist",
                ownerSpotifyUserId: item?.owner?.id ?? null,
                ownerDisplayName: item?.owner?.display_name ?? null,
                description: item?.description ?? null,
                imageUrl:
                  item?.images?.find((image) => typeof image?.url === "string")?.url ??
                  null,
                isPublic: typeof item?.public === "boolean" ? item.public : null,
                collaborative:
                  typeof item?.collaborative === "boolean" ? item.collaborative : null,
                snapshotId: item?.snapshot_id ?? null,
                tracksTotal:
                  typeof item?.tracks?.total === "number" ? item.tracks.total : null,
                lastSeenAt: now,
              };
            })
            .filter(
              (
                item
              ): item is {
                playlistId: string;
                name: string;
                ownerSpotifyUserId: string | null;
                ownerDisplayName: string | null;
                description: string | null;
                imageUrl: string | null;
                isPublic: boolean | null;
                collaborative: boolean | null;
                snapshotId: string | null;
                tracksTotal: number | null;
                lastSeenAt: number;
              } => Boolean(item)
            )
        : [];

      return jsonNoStore({
        items: liveItems,
        nextCursor: liveData?.next ? String(offset + liveItems.length) : null,
        asOf: now,
        sync: {
          status: "live",
          lastSuccessfulAt: now,
          lagSec: 0,
        },
        meta: buildDataSourceMeta({
          resource: "playlists",
          source: "live",
          asOf: now,
          staleSec: 0,
          degraded: false,
          liveRequested: true,
        }),
      });
    } catch (error) {
      if (error instanceof SpotifyFetchError) {
        if (error.status === 401) return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
        if (error.status === 403) return jsonNoStore({ error: "FORBIDDEN" }, 403);
        if (error.status === 429) {
          liveFallbackReason = "live_rate_limited";
        } else {
          liveFallbackReason = "live_spotify_upstream";
        }
      } else if (String(error).includes("UserNotAuthenticated")) {
        return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
      }
    }
  }

  const db = getDb();
  const baseWhere = eq(userPlaylists.userId, session.appUserId as string);
  let whereClause = baseWhere;
  const dbCursor = live && liveFallbackReason ? null : cursor;

  if (dbCursor) {
    const decoded = tryDecodeCursor(dbCursor);
    if (!decoded) {
      return jsonError("INVALID_CURSOR", 400);
    }
    const cursorWhere = and(
      baseWhere,
      or(
        lt(userPlaylists.lastSeenAt, decoded.addedAt),
        and(
          eq(userPlaylists.lastSeenAt, decoded.addedAt),
          lt(userPlaylists.playlistId, decoded.id)
        )
      )
    );
    if (!cursorWhere) {
      return jsonError("INVALID_CURSOR", 400);
    }
    whereClause = cursorWhere;
  }

  const rows = await db
    .select({
      playlistId: playlists.playlistId,
      name: playlists.name,
      ownerSpotifyUserId: playlists.ownerSpotifyUserId,
      ownerDisplayName: playlists.ownerDisplayName,
      description: playlists.description,
      imageUrl: playlists.imageUrl,
      isPublic: playlists.isPublic,
      collaborative: playlists.collaborative,
      snapshotId: playlists.snapshotId,
      tracksTotal: playlists.tracksTotal,
      lastSeenAt: userPlaylists.lastSeenAt,
    })
    .from(userPlaylists)
    .innerJoin(playlists, eq(playlists.playlistId, userPlaylists.playlistId))
    .where(whereClause)
    .orderBy(desc(userPlaylists.lastSeenAt), desc(userPlaylists.playlistId))
    .limit(limit);

  if (!rows.length && !dbCursor) {
    try {
      const liveBootstrap = await spotifyFetch<{
        items?: Array<{
          id?: string;
          name?: string;
          owner?: { id?: string; display_name?: string };
          description?: string | null;
          images?: Array<{ url?: string | null }>;
          public?: boolean;
          collaborative?: boolean;
          snapshot_id?: string;
          tracks?: { total?: number };
        }>;
      }>({
        url: `https://api.spotify.com/v1/me/playlists?limit=${limit}&offset=0`,
        userLevel: true,
        priority: "default",
        cacheTtlMs: policy.cacheTtlMs,
        dedupeWindowMs: policy.dedupeWindowMs,
      });
      const now = Date.now();
      const liveItems = Array.isArray(liveBootstrap?.items)
        ? liveBootstrap.items
            .map((item) => {
              const playlistId = String(item?.id ?? "").trim();
              if (!playlistId) return null;
              return {
                playlistId,
                name: item?.name ?? "Untitled playlist",
                ownerSpotifyUserId: item?.owner?.id ?? null,
                ownerDisplayName: item?.owner?.display_name ?? null,
                description: item?.description ?? null,
                imageUrl:
                  item?.images?.find((image) => typeof image?.url === "string")?.url ??
                  null,
                isPublic: typeof item?.public === "boolean" ? item.public : null,
                collaborative:
                  typeof item?.collaborative === "boolean"
                    ? item.collaborative
                    : null,
                snapshotId: item?.snapshot_id ?? null,
                tracksTotal:
                  typeof item?.tracks?.total === "number" ? item.tracks.total : null,
                lastSeenAt: now,
              };
            })
            .filter(
              (
                item
              ): item is {
                playlistId: string;
                name: string;
                ownerSpotifyUserId: string | null;
                ownerDisplayName: string | null;
                description: string | null;
                imageUrl: string | null;
                isPublic: boolean | null;
                collaborative: boolean | null;
                snapshotId: string | null;
                tracksTotal: number | null;
                lastSeenAt: number;
              } => Boolean(item)
            )
        : [];

      return jsonNoStore({
        items: liveItems,
        nextCursor: null,
        asOf: now,
        sync: {
          status: "live",
          lastSuccessfulAt: now,
          lagSec: 0,
        },
        meta: buildDataSourceMeta({
          resource: "playlists",
          source: "live",
          asOf: now,
          staleSec: 0,
          degraded: false,
          liveRequested: live,
        }),
      });
    } catch (error) {
      if (error instanceof SpotifyFetchError) {
        if (error.status === 401) return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
        if (error.status === 403) return jsonNoStore({ error: "FORBIDDEN" }, 403);
        if (error.status === 429) {
          liveFallbackReason = "bootstrap_live_rate_limited";
        } else {
          liveFallbackReason = "bootstrap_live_spotify_upstream";
        }
      }
      if (String(error).includes("UserNotAuthenticated")) {
        return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
      }
    }
  }

  const last = rows[rows.length - 1];
  const nextCursor = last
    ? encodeCursor(last.lastSeenAt, last.playlistId)
    : null;

  const sync = await db
    .select()
    .from(syncState)
    .where(
      and(
        eq(syncState.userId, session.appUserId as string),
        eq(syncState.resource, "playlists")
      )
    )
    .get();

  const lastSuccessfulAt = sync?.lastSuccessfulAt ?? null;
  const lagSec = lastSuccessfulAt
    ? Math.floor((Date.now() - lastSuccessfulAt) / 1000)
    : null;
  const now = Date.now();
  const staleSec = computeStaleSec(lastSuccessfulAt, now);
  if (live && liveFallbackReason) {
    incCounter("spotify_route_degraded_total", {
      route: "me_playlists",
      reason: liveFallbackReason,
    });
  }

  return jsonPrivateCache({
    items: rows,
    nextCursor,
    asOf: now,
    sync: {
      status: sync?.status ?? "idle",
      lastSuccessfulAt,
      lagSec,
    },
    meta: buildDataSourceMeta({
      resource: "playlists",
      source: "db",
      asOf: now,
      staleSec,
      degraded: Boolean(live && liveFallbackReason),
      degradeReason: liveFallbackReason,
      liveRequested: live,
    }),
  }, 200, policy.privateMaxAgeSec);
}
