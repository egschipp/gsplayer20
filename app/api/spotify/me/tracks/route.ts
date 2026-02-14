import { getDb } from "@/lib/db/client";
import { userSavedTracks, tracks, syncState, trackArtists, artists } from "@/lib/db/schema";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { decodeCursor, encodeCursor } from "@/lib/spotify/cursor";
import { rateLimitResponse, requireAppUser, jsonNoStore, jsonPrivateCache } from "@/lib/api/guards";
import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";

export const runtime = "nodejs";

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
  const limit = Math.min(Number(searchParams.get("limit") ?? "50"), 50);
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
            popularity?: number;
            album?: {
              id?: string;
              name?: string;
              images?: Array<{ url: string }>;
            };
            artists?: Array<{ name?: string }>;
          };
        }>;
        next?: string | null;
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
            albumId: track.album?.id ?? null,
            albumName: track.album?.name ?? null,
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

      const nextCursor = data?.next ? String(offset + items.length) : null;

      return jsonNoStore({
        items: mapped,
        nextCursor,
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
  const whereClause = cursor
    ? (() => {
        const decoded = decodeCursor(cursor);
        return and(
          eq(userSavedTracks.userId, session.appUserId as string),
          or(
            lt(userSavedTracks.addedAt, decoded.addedAt),
            and(
              eq(userSavedTracks.addedAt, decoded.addedAt),
              lt(userSavedTracks.trackId, decoded.id)
            )
          )
        );
      })()
    : eq(userSavedTracks.userId, session.appUserId as string);

  const rows = await db
    .select({
      trackId: tracks.trackId,
      name: tracks.name,
      durationMs: tracks.durationMs,
      explicit: tracks.explicit,
      albumId: tracks.albumId,
      albumName: tracks.albumName,
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
