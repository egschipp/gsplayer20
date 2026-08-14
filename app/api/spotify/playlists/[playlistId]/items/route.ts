import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  playlistItems,
  tracks,
  userPlaylists,
  userSavedTracks,
  syncState,
  trackArtists,
  artists,
  playlists,
} from "@/lib/db/schema";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { encodeCursor, tryDecodeCursor } from "@/lib/spotify/cursor";
import {
  jsonError,
  jsonNoStore,
  jsonPrivateCache,
  rateLimitResponse,
  requireAppUser,
  requireSameOrigin,
} from "@/lib/api/guards";
import { spotifyFetch } from "@/lib/spotify/client";
import { incCounter, observeHistogram } from "@/lib/observability/metrics";
import {
  mapLivePlaylistItems,
  normalizeSpotifyTotal,
  normalizeTrackId,
  type SpotifyPlaylistItemsResponse,
} from "@/lib/spotify/playlistItems";
import { mapSpotifyRouteError } from "@/lib/spotify/routeError";

export const runtime = "nodejs";

function createMutationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `mut_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function playlistItemErrorResponse(error: unknown) {
  const mapped = mapSpotifyRouteError(error, {
    notFoundCode: "PLAYLIST_NOT_FOUND",
  });
  return jsonError(mapped.code, mapped.status);
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ playlistId: string }> }
) {
  const { session, response } = await requireAppUser();
  if (response) return response;
  const rl = await rateLimitResponse({
    key: `playlist-items:${session.appUserId}`,
    limit: 600,
    windowMs: 60_000,
  });
  if (rl) return rl;

  const { playlistId } = await ctx.params;
  if (!playlistId) {
    return jsonPrivateCache({ error: "MISSING_PLAYLIST" }, 400);
  }

  const { searchParams } = new URL(req.url);
  const limitValue = Number(searchParams.get("limit") ?? "100");
  const limit =
    Number.isFinite(limitValue) && limitValue > 0
      ? Math.min(Math.floor(limitValue), 100)
      : 100;
  const cursor = searchParams.get("cursor");
  const live = searchParams.get("live") === "1";
  const trackIdParam = searchParams.get("trackId");
  const targetTrackId = normalizeTrackId(trackIdParam);
  if (trackIdParam && !targetTrackId) {
    return jsonError("INVALID_TRACK_ID", 400);
  }

  const db = getDb();
  const baseWhere = and(
    eq(userPlaylists.userId, session.appUserId as string),
    eq(playlistItems.playlistId, playlistId)
  );
  if (!baseWhere) {
    return jsonError("INVALID_PLAYLIST", 400);
  }
  let whereClause = baseWhere;

  if (cursor && !live) {
    const decoded = tryDecodeCursor(cursor);
    if (!decoded) {
      return jsonError("INVALID_CURSOR", 400);
    }
    const cursorWhere = and(
      baseWhere,
      or(
        gt(playlistItems.position, decoded.addedAt),
        and(
          eq(playlistItems.position, decoded.addedAt),
          gt(playlistItems.itemId, decoded.id)
        )
      )
    );
    if (!cursorWhere) {
      return jsonError("INVALID_CURSOR", 400);
    }
    whereClause = cursorWhere;
  }

  let target:
    | {
        trackId: string;
        found: boolean;
        position: number | null;
      }
    | undefined;
  if (targetTrackId) {
    const lookupStartedAt = Date.now();
    const directWhere = and(baseWhere, eq(playlistItems.trackId, targetTrackId));
    const targetRow = await db
      .select({
        position: playlistItems.position,
      })
      .from(playlistItems)
      .innerJoin(userPlaylists, eq(userPlaylists.playlistId, playlistItems.playlistId))
      .leftJoin(tracks, eq(tracks.trackId, playlistItems.trackId))
      .where(directWhere)
      .orderBy(asc(playlistItems.position), asc(playlistItems.itemId))
      .limit(1)
      .get();
    const found = Boolean(targetRow && typeof targetRow.position === "number");
    target = {
      trackId: targetTrackId,
      found,
      position:
        targetRow && typeof targetRow.position === "number"
          ? Math.max(0, Math.floor(targetRow.position))
          : null,
    };
    incCounter("playlist_items_target_lookup_total", {
      found: found ? "1" : "0",
    });
    observeHistogram(
      "playlist_items_target_lookup_latency_ms",
      Date.now() - lookupStartedAt,
      {
        found: found ? "1" : "0",
      }
    );
  }

  const rows = await db
    .select({
      itemId: playlistItems.itemId,
      playlistId: playlistItems.playlistId,
      trackId: tracks.trackId,
      name: tracks.name,
      albumId: tracks.albumId,
      albumName: tracks.albumName,
      albumReleaseDate: tracks.albumReleaseDate,
      releaseYear: tracks.albumReleaseYear,
      albumImageUrl: tracks.albumImageUrl,
      durationMs: tracks.durationMs,
      explicit: tracks.explicit,
      isLocal: tracks.isLocal,
      linkedFromTrackId: tracks.linkedFromTrackId,
      restrictionsReason: tracks.restrictionsReason,
      popularity: tracks.popularity,
      hasCover: sql<number>`(${tracks.albumImageBlob} IS NOT NULL)`,
      artists: sql<
        string | null
      >`replace(group_concat(DISTINCT ${artists.name}), ',', ', ')`,
      saved: sql<number>`max(${userSavedTracks.trackId} IS NOT NULL)`,
      addedAt: playlistItems.addedAt,
      addedBySpotifyUserId: playlistItems.addedBySpotifyUserId,
      position: playlistItems.position,
      snapshotIdAtSync: playlistItems.snapshotIdAtSync,
      syncRunId: playlistItems.syncRunId,
    })
    .from(playlistItems)
    .innerJoin(userPlaylists, eq(userPlaylists.playlistId, playlistItems.playlistId))
    .leftJoin(tracks, eq(tracks.trackId, playlistItems.trackId))
    .leftJoin(trackArtists, eq(trackArtists.trackId, tracks.trackId))
    .leftJoin(artists, eq(artists.artistId, trackArtists.artistId))
    .leftJoin(
      userSavedTracks,
      and(
        eq(userSavedTracks.trackId, tracks.trackId),
        eq(userSavedTracks.userId, session.appUserId as string)
      )
    )
    .where(whereClause)
    .groupBy(
      playlistItems.itemId,
      playlistItems.playlistId,
      playlistItems.addedAt,
      playlistItems.position,
      tracks.trackId
    )
    .orderBy(asc(playlistItems.position), asc(playlistItems.itemId))
    .limit(limit);

  if (live || (!rows.length && !cursor)) {
    const parsedOffset = Number(cursor ?? "0");
    const offset =
      Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0;
    try {
      const liveResponse = await spotifyFetch<SpotifyPlaylistItemsResponse>({
        url: `https://api.spotify.com/v1/playlists/${encodeURIComponent(
          playlistId
        )}/items?limit=${limit}&offset=${offset}`,
        userLevel: true,
      });

      const now = Date.now();
      const mapped = mapLivePlaylistItems(liveResponse?.items, playlistId, offset);

      return jsonNoStore({
        items: mapped,
        nextCursor: liveResponse?.next ? String(offset + mapped.length) : null,
        totalCount: normalizeSpotifyTotal(liveResponse?.total),
        asOf: now,
        sync: {
          status: "live",
          lastSuccessfulAt: now,
          lagSec: 0,
        },
        target:
          target ??
          (targetTrackId
            ? {
                trackId: targetTrackId,
                found: false,
                position: null,
              }
            : undefined),
      });
    } catch (error) {
      return playlistItemErrorResponse(error);
    }
  }

  const trackIds = rows
    .map((row) => row.trackId)
    .filter((id): id is string => Boolean(id));
  const playlistRows = trackIds.length
    ? await db
        .select({
          trackId: playlistItems.trackId,
          playlistId: playlists.playlistId,
          playlistName: playlists.name,
        })
        .from(playlistItems)
        .innerJoin(playlists, eq(playlists.playlistId, playlistItems.playlistId))
        .innerJoin(
          userPlaylists,
          and(
            eq(userPlaylists.playlistId, playlists.playlistId),
            eq(userPlaylists.userId, session.appUserId as string)
          )
        )
        .where(inArray(playlistItems.trackId, trackIds))
    : [];

  const playlistsByTrack = new Map<string, { id: string; name: string }[]>();
  for (const row of playlistRows) {
    if (!row.trackId || !row.playlistId) continue;
    const list = playlistsByTrack.get(row.trackId) ?? [];
    if (!list.find((item) => item.id === row.playlistId)) {
      list.push({ id: row.playlistId, name: row.playlistName ?? "" });
      playlistsByTrack.set(row.trackId, list);
    }
  }

  const last = rows[rows.length - 1];
  const nextCursor = last ? encodeCursor(last.position ?? 0, last.itemId) : null;
  const totalRow = await db
    .select({
      count: sql<number>`count(*)`,
    })
    .from(playlistItems)
    .innerJoin(userPlaylists, eq(userPlaylists.playlistId, playlistItems.playlistId))
    .where(baseWhere)
    .get();
  const totalCount =
    typeof totalRow?.count === "number" && Number.isFinite(totalRow.count)
      ? Math.max(0, Math.floor(totalRow.count))
      : null;

  const sync = await db
    .select()
    .from(syncState)
    .where(
      and(
        eq(syncState.userId, session.appUserId as string),
        eq(syncState.resource, `playlist_items:${playlistId}`)
      )
    )
    .get();

  const lastSuccessfulAt = sync?.lastSuccessfulAt ?? null;
  const lagSec = lastSuccessfulAt
    ? Math.floor((Date.now() - lastSuccessfulAt) / 1000)
    : null;

  return jsonPrivateCache({
    items: rows.map((row) => ({
      ...row,
      coverUrl: row.hasCover ? `/api/spotify/cover/${row.trackId}` : row.albumImageUrl,
      playlists: [
        ...(row.saved
          ? [
              {
                id: "liked",
                name: "Liked Songs",
                spotifyUrl: "https://open.spotify.com/collection/tracks",
              },
            ]
          : []),
        ...((row.trackId ? playlistsByTrack.get(row.trackId) : null) ?? []).map((pl) => ({
          ...pl,
          spotifyUrl: `https://open.spotify.com/playlist/${pl.id}`,
        })),
      ],
    })),
    nextCursor,
    totalCount,
    asOf: Date.now(),
    sync: {
      status: sync?.status ?? "idle",
      lastSuccessfulAt,
      lagSec,
    },
    target,
  });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ playlistId: string }> }
) {
  const originCheck = requireSameOrigin(req);
  if (originCheck) return originCheck;

  const { session, response } = await requireAppUser();
  if (response) return response;

  const rl = await rateLimitResponse({
    key: `playlist-items:add:${session.appUserId}`,
    limit: 120,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rl) return rl;

  const { playlistId } = await ctx.params;
  if (!playlistId) return jsonError("MISSING_PLAYLIST", 400);

  const body = await req.json().catch(() => ({}));
  const trackId = normalizeTrackId(body?.trackId);
  if (!trackId) return jsonError("INVALID_TRACK_ID", 400);

  try {
    await spotifyFetch({
      url: `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items`,
      method: "POST",
      body: { uris: [`spotify:track:${trackId}`] },
      userLevel: true,
      activity: "playlist_items_add_track",
    });
    try {
      const db = getDb();
      const maxPosRow = await db
        .select({ maxPosition: sql<number>`max(${playlistItems.position})` })
        .from(playlistItems)
        .where(eq(playlistItems.playlistId, playlistId))
        .get();
      const nextPosition =
        typeof maxPosRow?.maxPosition === "number" &&
        Number.isFinite(maxPosRow.maxPosition)
          ? Math.max(0, Math.floor(maxPosRow.maxPosition) + 1)
          : 0;
      await db.insert(playlistItems).values({
        playlistId,
        itemId: `manual:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`,
        trackId,
        addedAt: Date.now(),
        position: nextPosition,
        addedBySpotifyUserId: null,
        snapshotIdAtSync: null,
        syncRunId: "manual",
      });
    } catch {
      // ignore local db write errors; Spotify mutation already succeeded
    }
    return jsonNoStore({
      playlistId,
      trackId,
      added: true,
      mutationId: createMutationId(),
      localSync: "best_effort",
      mutatedAt: Date.now(),
    });
  } catch (error) {
    return playlistItemErrorResponse(error);
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ playlistId: string }> }
) {
  const originCheck = requireSameOrigin(req);
  if (originCheck) return originCheck;

  const { session, response } = await requireAppUser();
  if (response) return response;

  const rl = await rateLimitResponse({
    key: `playlist-items:remove:${session.appUserId}`,
    limit: 120,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rl) return rl;

  const { playlistId } = await ctx.params;
  if (!playlistId) return jsonError("MISSING_PLAYLIST", 400);

  const body = await req.json().catch(() => ({}));
  const trackId = normalizeTrackId(body?.trackId);
  if (!trackId) return jsonError("INVALID_TRACK_ID", 400);

  try {
    await spotifyFetch({
      url: `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items`,
      method: "DELETE",
      body: { items: [{ uri: `spotify:track:${trackId}` }] },
      userLevel: true,
      activity: "playlist_items_remove_track",
    });
    try {
      const db = getDb();
      await db
        .delete(playlistItems)
        .where(
          and(
            eq(playlistItems.playlistId, playlistId),
            eq(playlistItems.trackId, trackId)
          )
        );
    } catch {
      // ignore local db write errors; Spotify mutation already succeeded
    }
    return jsonNoStore({
      playlistId,
      trackId,
      removed: true,
      mutationId: createMutationId(),
      localSync: "best_effort",
      mutatedAt: Date.now(),
    });
  } catch (error) {
    return playlistItemErrorResponse(error);
  }
}
