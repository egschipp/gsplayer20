import { getDb } from "@/lib/db/client";
import {
  tracks,
  trackArtists,
  artists,
  playlists,
  userSavedTracks,
  playlistItems,
  userPlaylists,
} from "@/lib/db/schema";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { encodeCursor, tryDecodeCursor } from "@/lib/spotify/cursor";
import {
  jsonError,
  jsonNoStore,
  requireAppUser,
  jsonPrivateCache,
  rateLimitResponse,
} from "@/lib/api/guards";
import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";

export const runtime = "nodejs";

async function fetchLiveTracksForArtist(artistId: string, limit: number) {
  const rows: Array<{
    trackId: string;
    name: string | null;
    durationMs: number | null;
    explicit: number | null;
    isLocal: number | null;
    linkedFromTrackId: string | null;
    restrictionsReason: string | null;
    popularity: number | null;
    albumId: string | null;
    albumName: string | null;
    albumReleaseDate: string | null;
    releaseYear: number | null;
    albumImageUrl: string | null;
    coverUrl: string | null;
    artists: string | null;
    playlists: Array<{ id: string; name: string; spotifyUrl: string }>;
  }> = [];
  let offset = 0;
  let pages = 0;
  const pageLimit = 50;
  const maxPages = 10;

  while (rows.length < limit && pages < maxPages) {
    const data = await spotifyFetch<{
      items?: Array<{
        track?: {
          id?: string;
          name?: string;
          duration_ms?: number;
          explicit?: boolean;
          is_local?: boolean;
          linked_from?: { id?: string | null };
          restrictions?: { reason?: string | null };
          popularity?: number;
          artists?: Array<{ id?: string; name?: string }>;
          album?: {
            id?: string;
            name?: string;
            release_date?: string;
            images?: Array<{ url?: string }>;
          };
        };
      }>;
      next?: string | null;
    }>({
      url: `https://api.spotify.com/v1/me/tracks?limit=${pageLimit}&offset=${offset}`,
      userLevel: true,
    });

    const items = Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      const track = item?.track;
      const trackId = typeof track?.id === "string" ? track.id : null;
      if (!trackId) continue;
      const artists = Array.isArray(track?.artists) ? track.artists : [];
      const matchesArtist = artists.some((artist) => artist?.id === artistId);
      if (!matchesArtist) continue;
      const releaseDate = track?.album?.release_date ?? null;
      const albumImageUrl =
        track?.album?.images?.find((image) => typeof image?.url === "string")?.url ??
        null;
      rows.push({
        trackId,
        name: track?.name ?? null,
        durationMs:
          typeof track?.duration_ms === "number" ? track.duration_ms : null,
        explicit:
          typeof track?.explicit === "boolean" ? (track.explicit ? 1 : 0) : null,
        isLocal:
          typeof track?.is_local === "boolean" ? (track.is_local ? 1 : 0) : null,
        linkedFromTrackId:
          typeof track?.linked_from?.id === "string" ? track.linked_from.id : null,
        restrictionsReason:
          typeof track?.restrictions?.reason === "string"
            ? track.restrictions.reason
            : null,
        popularity:
          typeof track?.popularity === "number" ? track.popularity : null,
        albumId: track?.album?.id ?? null,
        albumName: track?.album?.name ?? null,
        albumReleaseDate: releaseDate,
        releaseYear:
          releaseDate && /^\d{4}/.test(releaseDate)
            ? Number(releaseDate.slice(0, 4))
            : null,
        albumImageUrl,
        coverUrl: albumImageUrl,
        artists: artists
          .map((artist) => artist?.name)
          .filter(Boolean)
          .join(", "),
        playlists: [
          {
            id: "liked",
            name: "Liked Songs",
            spotifyUrl: "https://open.spotify.com/collection/tracks",
          },
        ],
      });
      if (rows.length >= limit) break;
    }

    if (!data?.next || items.length === 0) break;
    offset += items.length;
    pages += 1;
  }

  return rows;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ artistId: string }> }
) {
  const { session, response } = await requireAppUser();
  if (response) return response;
  const rl = await rateLimitResponse({
    key: `artist-tracks:${session.appUserId}`,
    limit: 600,
    windowMs: 60_000,
  });
  if (rl) return rl;

  const { artistId } = await ctx.params;
  if (!artistId) {
    return jsonPrivateCache({ error: "MISSING_ARTIST" }, 400);
  }

  const { searchParams } = new URL(req.url);
  const limitValue = Number(searchParams.get("limit") ?? "50");
  const limit =
    Number.isFinite(limitValue) && limitValue > 0
      ? Math.min(Math.floor(limitValue), 50)
      : 50;
  const cursor = searchParams.get("cursor");

  const db = getDb();
  const artistTracks = db
    .select({ trackId: trackArtists.trackId })
    .from(trackArtists)
    .where(eq(trackArtists.artistId, artistId));

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
      isLocal: tracks.isLocal,
      linkedFromTrackId: tracks.linkedFromTrackId,
      restrictionsReason: tracks.restrictionsReason,
      popularity: tracks.popularity,
      albumId: tracks.albumId,
      albumName: tracks.albumName,
      albumReleaseDate: tracks.albumReleaseDate,
      releaseYear: tracks.albumReleaseYear,
      albumImageUrl: tracks.albumImageUrl,
      hasCover: sql<number>`(${tracks.albumImageBlob} IS NOT NULL)`,
      artists: sql<string | null>`replace(group_concat(DISTINCT ${artists.name}), ',', ', ')`,
      saved: sql<number>`max(${userSavedTracks.trackId} IS NOT NULL)`,
    })
    .from(tracks)
    .leftJoin(trackArtists, eq(trackArtists.trackId, tracks.trackId))
    .leftJoin(artists, eq(artists.artistId, trackArtists.artistId))
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
    .where(
      and(
        inArray(tracks.trackId, artistTracks),
        baseWhere ? baseWhere : sql`1=1`,
        userWhere
      )
    )
    .groupBy(tracks.trackId)
    .orderBy(desc(tracks.trackId))
    .limit(limit);

  if (!rows.length && !cursor) {
    try {
      const liveRows = await fetchLiveTracksForArtist(artistId, limit);
      return jsonNoStore({
        items: liveRows,
        nextCursor: null,
        asOf: Date.now(),
        sync: {
          status: "live",
          lastSuccessfulAt: Date.now(),
          lagSec: 0,
        },
      });
    } catch (error) {
      if (error instanceof SpotifyFetchError) {
        if (error.status === 401) return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
        if (error.status === 403) return jsonNoStore({ error: "FORBIDDEN" }, 403);
        if (error.status === 429) return jsonNoStore({ error: "RATE_LIMIT" }, 429);
      }
      if (String(error).includes("UserNotAuthenticated")) {
        return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
      }
      return jsonNoStore({ error: "SPOTIFY_UPSTREAM" }, 502);
    }
  }

  const trackIds = rows.map((row) => row.trackId).filter(Boolean);
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
        ...(playlistsByTrack.get(row.trackId) ?? []).map((pl) => ({
          ...pl,
          spotifyUrl: `https://open.spotify.com/playlist/${pl.id}`,
        })),
      ],
    })),
    nextCursor,
    asOf: Date.now(),
  });
}
