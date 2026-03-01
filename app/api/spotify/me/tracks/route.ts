import { getDb } from "@/lib/db/client";
import {
  userSavedTracks,
  tracks,
  syncState,
  trackArtists,
  artists,
  playlistItems,
  playlists,
  userPlaylists,
} from "@/lib/db/schema";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { encodeCursor, tryDecodeCursor } from "@/lib/spotify/cursor";
import { rateLimitResponse, requireAppUser, jsonNoStore, jsonPrivateCache } from "@/lib/api/guards";
import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";

export const runtime = "nodejs";

async function fetchPlaylistsByTrack(
  appUserId: string,
  trackIds: string[]
): Promise<Map<string, { id: string; name: string }[]>> {
  const cleaned = Array.from(
    new Set(trackIds.map((id) => String(id ?? "").trim()).filter(Boolean))
  );
  if (!cleaned.length) return new Map();

  const db = getDb();
  const rows = await db
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
        eq(userPlaylists.userId, appUserId)
      )
    )
    .where(inArray(playlistItems.trackId, cleaned));

  const map = new Map<string, { id: string; name: string }[]>();
  for (const row of rows) {
    if (!row.trackId || !row.playlistId) continue;
    const list = map.get(row.trackId) ?? [];
    if (!list.some((item) => item.id === row.playlistId)) {
      list.push({ id: row.playlistId, name: row.playlistName ?? "" });
    }
    map.set(row.trackId, list);
  }
  return map;
}

export async function GET(req: Request) {
  const { session, response } = await requireAppUser();
  if (response) return response;
  const rl = await rateLimitResponse({
    key: `tracks:${session.appUserId}`,
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

  if (live) {
    const parsedOffset = Number(cursor ?? "0");
    const offset =
      Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0;
    try {
      const data = await spotifyFetch<{
        items?: Array<{
          added_at?: string;
          track?: {
            id?: string;
            name?: string;
            duration_ms?: number;
            explicit?: boolean;
            is_local?: boolean;
            linked_from?: { id?: string | null };
            restrictions?: { reason?: string | null };
            popularity?: number;
            album?: {
              id?: string;
              name?: string;
              release_date?: string;
              images?: Array<{ url: string }>;
            };
            artists?: Array<{ name?: string }>;
          };
        }>;
        next?: string | null;
        total?: number;
      }>({
        url: `https://api.spotify.com/v1/me/tracks?limit=${limit}&offset=${offset}`,
        userLevel: true,
      });

      const items = Array.isArray(data?.items) ? data.items : [];
      const mapped = items
        .map((row) => {
          const track = row?.track;
          if (!track?.id) return null;
          const parsedAddedAt = row?.added_at ? Date.parse(row.added_at) : NaN;
          return {
            trackId: track.id,
            name: track.name ?? null,
            durationMs:
              typeof track.duration_ms === "number" ? track.duration_ms : null,
            explicit:
              typeof track.explicit === "boolean"
                ? track.explicit
                  ? 1
                  : 0
                : null,
            isLocal:
              typeof track.is_local === "boolean" ? (track.is_local ? 1 : 0) : null,
            linkedFromTrackId:
              typeof track.linked_from?.id === "string" ? track.linked_from.id : null,
            restrictionsReason:
              typeof track.restrictions?.reason === "string"
                ? track.restrictions.reason
                : null,
            albumId: track.album?.id ?? null,
            albumName: track.album?.name ?? null,
            albumReleaseDate: track.album?.release_date ?? null,
            releaseYear:
              track.album?.release_date && /^\d{4}/.test(track.album.release_date)
                ? Number(track.album.release_date.slice(0, 4))
                : null,
            albumImageUrl: track.album?.images?.[0]?.url ?? null,
            coverUrl: track.album?.images?.[0]?.url ?? null,
            popularity:
              typeof track.popularity === "number" ? track.popularity : null,
            addedAt: Number.isFinite(parsedAddedAt) ? parsedAddedAt : null,
            artists: Array.isArray(track.artists)
              ? track.artists
                  .map((artist) => artist?.name)
                  .filter(Boolean)
                  .join(", ")
              : null,
            playlists: [
              {
                id: "liked",
                name: "Liked Songs",
                spotifyUrl: "https://open.spotify.com/collection/tracks",
              },
            ],
          };
        })
        .filter(Boolean);

      const trackIds = mapped
        .map((item) => String(item?.trackId ?? "").trim())
        .filter(Boolean);
      const playlistsByTrack = await fetchPlaylistsByTrack(
        session.appUserId as string,
        trackIds
      );

      const nextCursor = data?.next ? String(offset + items.length) : null;

      return jsonNoStore({
        items: mapped.map((item) => ({
          ...item,
          playlists: [
            {
              id: "liked",
              name: "Liked Songs",
              spotifyUrl: "https://open.spotify.com/collection/tracks",
            },
            ...((playlistsByTrack.get(String(item?.trackId ?? "")) ?? []).map((pl) => ({
              ...pl,
              spotifyUrl: `https://open.spotify.com/playlist/${pl.id}`,
            })) as Array<{ id: string; name: string; spotifyUrl: string }>),
          ],
        })),
        nextCursor,
        totalCount:
          typeof data?.total === "number" && Number.isFinite(data.total)
            ? Math.max(0, Math.floor(data.total))
            : null,
        asOf: Date.now(),
        sync: {
          status: "live",
          lastSuccessfulAt: Date.now(),
          lagSec: 0,
        },
      });
    } catch (error) {
      if (error instanceof SpotifyFetchError) {
        if (error.status === 401) {
          return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
        }
        if (error.status === 403) {
          return jsonNoStore({ error: "FORBIDDEN" }, 403);
        }
        if (error.status === 429) {
          return jsonNoStore({ error: "RATE_LIMIT" }, 429);
        }
      }
      if (String(error).includes("UserNotAuthenticated")) {
        return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
      }
      return jsonNoStore({ error: "SPOTIFY_UPSTREAM" }, 502);
    }
  }

  const db = getDb();
  const baseWhere = eq(userSavedTracks.userId, session.appUserId as string);
  let whereClause = baseWhere;

  if (cursor) {
    const decoded = tryDecodeCursor(cursor);
    if (!decoded) {
      return jsonNoStore({ error: "INVALID_CURSOR" }, 400);
    }
    const cursorWhere = and(
      baseWhere,
      or(
        lt(userSavedTracks.addedAt, decoded.addedAt),
        and(
          eq(userSavedTracks.addedAt, decoded.addedAt),
          lt(userSavedTracks.trackId, decoded.id)
        )
      )
    );
    if (!cursorWhere) {
      return jsonNoStore({ error: "INVALID_CURSOR" }, 400);
    }
    whereClause = cursorWhere;
  }

  const rows = await db
    .select({
      trackId: tracks.trackId,
      name: tracks.name,
      durationMs: tracks.durationMs,
      explicit: tracks.explicit,
      isLocal: tracks.isLocal,
      linkedFromTrackId: tracks.linkedFromTrackId,
      restrictionsReason: tracks.restrictionsReason,
      albumId: tracks.albumId,
      albumName: tracks.albumName,
      albumReleaseDate: tracks.albumReleaseDate,
      releaseYear: tracks.albumReleaseYear,
      albumImageUrl: tracks.albumImageUrl,
      hasCover: sql<number>`(${tracks.albumImageBlob} IS NOT NULL)`,
      popularity: tracks.popularity,
      addedAt: userSavedTracks.addedAt,
      artists: sql<string | null>`replace(group_concat(DISTINCT ${artists.name}), ',', ', ')`,
    })
    .from(userSavedTracks)
    .innerJoin(tracks, eq(tracks.trackId, userSavedTracks.trackId))
    .leftJoin(trackArtists, eq(trackArtists.trackId, tracks.trackId))
    .leftJoin(artists, eq(artists.artistId, trackArtists.artistId))
    .where(whereClause)
    .groupBy(tracks.trackId, userSavedTracks.addedAt, userSavedTracks.trackId)
    .orderBy(desc(userSavedTracks.addedAt), desc(userSavedTracks.trackId))
    .limit(limit);

  const totalRow = await db
    .select({ count: sql<number>`count(*)` })
    .from(userSavedTracks)
    .where(eq(userSavedTracks.userId, session.appUserId as string))
    .get();

  const last = rows[rows.length - 1];
  const nextCursor = last ? encodeCursor(last.addedAt, last.trackId) : null;

  const sync = await db
    .select()
    .from(syncState)
    .where(
      and(
        eq(syncState.userId, session.appUserId as string),
        eq(syncState.resource, "tracks")
      )
    )
    .get();

  const lastSuccessfulAt = sync?.lastSuccessfulAt ?? null;
  const lagSec = lastSuccessfulAt
    ? Math.floor((Date.now() - lastSuccessfulAt) / 1000)
    : null;

  const trackIds = rows.map((row) => row.trackId).filter(Boolean);
  const playlistsByTrack = await fetchPlaylistsByTrack(
    session.appUserId as string,
    trackIds
  );

  return jsonPrivateCache({
    items: rows.map((row) => ({
      ...row,
      coverUrl: row.hasCover ? `/api/spotify/cover/${row.trackId}` : row.albumImageUrl,
      playlists: [
        {
          id: "liked",
          name: "Liked Songs",
          spotifyUrl: "https://open.spotify.com/collection/tracks",
        },
        ...((playlistsByTrack.get(row.trackId) ?? []).map((pl) => ({
          ...pl,
          spotifyUrl: `https://open.spotify.com/playlist/${pl.id}`,
        })) as Array<{ id: string; name: string; spotifyUrl: string }>),
      ],
    })),
    nextCursor,
    totalCount:
      typeof totalRow?.count === "number" && Number.isFinite(totalRow.count)
        ? Math.max(0, Math.floor(totalRow.count))
        : null,
    asOf: Date.now(),
    sync: {
      status: sync?.status ?? "idle",
      lastSuccessfulAt,
      lagSec,
    },
  });
}
