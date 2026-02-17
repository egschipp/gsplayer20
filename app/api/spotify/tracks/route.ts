import { getDb } from "@/lib/db/client";
import {
  artists,
  playlists,
  trackArtists,
  tracks,
  userSavedTracks,
  playlistItems,
  userPlaylists,
} from "@/lib/db/schema";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { encodeCursor, tryDecodeCursor } from "@/lib/spotify/cursor";
import {
  jsonError,
  requireAppUser,
  jsonPrivateCache,
  rateLimitResponse,
} from "@/lib/api/guards";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { session, response } = await requireAppUser();
  if (response) return response;
  const rl = await rateLimitResponse({
    key: `tracks-list:${session.appUserId}`,
    limit: 600,
    windowMs: 60_000,
  });
  if (rl) return rl;

  const { searchParams } = new URL(req.url);
  const limitValue = Number(searchParams.get("limit") ?? "50");
  const limit =
    Number.isFinite(limitValue) && limitValue > 0
      ? Math.min(Math.floor(limitValue), 100)
      : 50;
  const cursor = searchParams.get("cursor");

  const db = getDb();
  const baseWhere = cursor
    ? (() => {
        const decoded = tryDecodeCursor(cursor);
        if (!decoded) return null;
        return lt(tracks.trackId, decoded.id);
      })()
    : undefined;

  if (cursor && !baseWhere) {
    return jsonError("INVALID_CURSOR", 400);
  }

  const userWhere = or(
    eq(userSavedTracks.userId, session.appUserId as string),
    eq(userPlaylists.userId, session.appUserId as string)
  );

  const rows = await db
    .select({
      trackId: tracks.trackId,
      name: tracks.name,
      durationMs: tracks.durationMs,
      explicit: tracks.explicit,
      popularity: tracks.popularity,
      albumId: tracks.albumId,
      albumName: tracks.albumName,
      albumReleaseDate: tracks.albumReleaseDate,
      releaseYear: tracks.albumReleaseYear,
      albumImageUrl: tracks.albumImageUrl,
      hasCover: sql<number>`(${tracks.albumImageBlob} IS NOT NULL)`,
      saved: sql<number>`max(${userSavedTracks.trackId} IS NOT NULL)`,
    })
    .from(tracks)
    .leftJoin(
      userSavedTracks,
      and(
        eq(userSavedTracks.trackId, tracks.trackId),
        eq(userSavedTracks.userId, session.appUserId as string)
      )
    )
    .leftJoin(playlistItems, eq(playlistItems.trackId, tracks.trackId))
    .leftJoin(
      userPlaylists,
      and(
        eq(userPlaylists.playlistId, playlistItems.playlistId),
        eq(userPlaylists.userId, session.appUserId as string)
      )
    )
    .where(baseWhere ? and(baseWhere, userWhere) : userWhere)
    .groupBy(tracks.trackId)
    .orderBy(desc(tracks.trackId))
    .limit(limit);

  const trackIds = rows.map((row) => row.trackId).filter(Boolean);
  const artistRows = trackIds.length
    ? await db
        .select({
          trackId: trackArtists.trackId,
          artistId: artists.artistId,
          artistName: artists.name,
        })
        .from(trackArtists)
        .innerJoin(artists, eq(artists.artistId, trackArtists.artistId))
        .where(inArray(trackArtists.trackId, trackIds))
    : [];

  const artistsByTrack = new Map<string, { id: string; name: string }[]>();
  for (const row of artistRows) {
    if (!row.trackId || !row.artistId) continue;
    const list = artistsByTrack.get(row.trackId) ?? [];
    list.push({ id: row.artistId, name: row.artistName ?? "" });
    artistsByTrack.set(row.trackId, list);
  }

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
  const nextCursor = last ? encodeCursor(0, last.trackId) : null;

  return jsonPrivateCache({
    items: rows.map((row) => {
      const coverUrl = row.hasCover
        ? `/api/spotify/cover/${row.trackId}`
        : row.albumImageUrl;
      return {
        id: row.trackId,
        trackId: row.trackId,
        name: row.name,
        artists: artistsByTrack.get(row.trackId) ?? [],
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
          ...(playlistsByTrack.get(row.trackId) ?? []).map((pl) => ({
            ...pl,
            spotifyUrl: `https://open.spotify.com/playlist/${pl.id}`,
          })),
        ],
        album: {
          id: row.albumId ?? null,
          name: row.albumName ?? null,
          images: coverUrl ? [{ url: coverUrl }] : [],
          release_date: row.albumReleaseDate ?? null,
        },
        releaseYear: row.releaseYear ?? null,
        durationMs: row.durationMs ?? null,
        explicit: row.explicit ?? null,
        popularity: row.popularity ?? null,
        albumImageUrl: row.albumImageUrl ?? null,
        coverUrl,
      };
    }),
    nextCursor,
    asOf: Date.now(),
  });
}
