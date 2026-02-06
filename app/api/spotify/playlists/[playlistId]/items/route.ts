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
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { decodeCursor, encodeCursor } from "@/lib/spotify/cursor";
import { rateLimitResponse, requireAppUser, jsonPrivateCache } from "@/lib/api/guards";

export const runtime = "nodejs";

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
  const limit = Math.min(Number(searchParams.get("limit") ?? "50"), 50);
  const cursor = searchParams.get("cursor");

  const db = getDb();
  const whereClause = cursor
    ? (() => {
        const decoded = decodeCursor(cursor);
        return and(
          eq(userPlaylists.userId, session.appUserId as string),
          eq(playlistItems.playlistId, playlistId),
          or(
            lt(playlistItems.position, decoded.addedAt),
            and(
              eq(playlistItems.position, decoded.addedAt),
              lt(playlistItems.itemId, decoded.id)
            )
          )
        );
      })()
    : and(
        eq(userPlaylists.userId, session.appUserId as string),
        eq(playlistItems.playlistId, playlistId)
      );

  const rows = await db
    .select({
      itemId: playlistItems.itemId,
      playlistId: playlistItems.playlistId,
      trackId: tracks.trackId,
      name: tracks.name,
      albumId: tracks.albumId,
      albumName: tracks.albumName,
      albumImageUrl: tracks.albumImageUrl,
      durationMs: tracks.durationMs,
      explicit: tracks.explicit,
      popularity: tracks.popularity,
      hasCover: sql<number>`(${tracks.albumImageBlob} IS NOT NULL)`,
      artists: sql<string | null>`replace(group_concat(DISTINCT ${artists.name}), ',', ', ')`,
      saved: sql<number>`max(${userSavedTracks.trackId} IS NOT NULL)`,
      addedAt: playlistItems.addedAt,
      addedBySpotifyUserId: playlistItems.addedBySpotifyUserId,
      position: playlistItems.position,
      snapshotIdAtSync: playlistItems.snapshotIdAtSync,
      syncRunId: playlistItems.syncRunId,
    })
    .from(playlistItems)
    .innerJoin(
      userPlaylists,
      eq(userPlaylists.playlistId, playlistItems.playlistId)
    )
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
    .orderBy(desc(playlistItems.position), desc(playlistItems.itemId))
    .limit(limit);

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
  const nextCursor = last
    ? encodeCursor(last.position ?? 0, last.itemId)
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
        ...((row.trackId ? playlistsByTrack.get(row.trackId) : null) ?? []).map(
          (pl) => ({
          ...pl,
          spotifyUrl: `https://open.spotify.com/playlist/${pl.id}`,
          })
        ),
      ],
    })),
    nextCursor,
    asOf: Date.now(),
    sync: {
      status: sync?.status ?? "idle",
      lastSuccessfulAt,
      lagSec,
    },
  });
}
