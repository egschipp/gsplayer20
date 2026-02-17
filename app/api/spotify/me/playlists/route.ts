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

  const db = getDb();
  const baseWhere = eq(userPlaylists.userId, session.appUserId as string);
  let whereClause = baseWhere;

  if (cursor) {
    const decoded = tryDecodeCursor(cursor);
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

  if (!rows.length && !cursor) {
    try {
      const live = await spotifyFetch<{
        items?: Array<{
          id?: string;
          name?: string;
          owner?: { id?: string };
          public?: boolean;
          collaborative?: boolean;
          snapshot_id?: string;
          tracks?: { total?: number };
        }>;
      }>({
        url: `https://api.spotify.com/v1/me/playlists?limit=${limit}&offset=0`,
        userLevel: true,
      });
      const now = Date.now();
      const liveItems = Array.isArray(live?.items)
        ? live.items
            .map((item) => {
              const playlistId = String(item?.id ?? "").trim();
              if (!playlistId) return null;
              return {
                playlistId,
                name: item?.name ?? "Untitled playlist",
                ownerSpotifyUserId: item?.owner?.id ?? null,
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
      });
    } catch (error) {
      if (error instanceof SpotifyFetchError) {
        if (error.status === 401) return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
        if (error.status === 403) return jsonNoStore({ error: "FORBIDDEN" }, 403);
        if (error.status === 429) return jsonNoStore({ error: "SPOTIFY_RATE_LIMIT" }, 429);
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

  return jsonPrivateCache({
    items: rows,
    nextCursor,
    asOf: Date.now(),
    sync: {
      status: sync?.status ?? "idle",
      lastSuccessfulAt,
      lagSec,
    },
  });
}
