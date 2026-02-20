import { getDb } from "@/lib/db/client";
import {
  artists,
  trackArtists,
  userSavedTracks,
  playlistItems,
  userPlaylists,
} from "@/lib/db/schema";
import { and, desc, eq, lt, or } from "drizzle-orm";
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

async function fetchLiveArtistsFromSavedTracks(limit: number) {
  const unique = new Map<string, { artistId: string; name: string }>();
  let offset = 0;
  let pages = 0;
  const pageLimit = 50;
  const maxPages = 8;

  while (unique.size < limit && pages < maxPages) {
    const data = await spotifyFetch<{
      items?: Array<{
        track?: {
          artists?: Array<{ id?: string; name?: string }>;
        };
      }>;
      next?: string | null;
    }>({
      url: `https://api.spotify.com/v1/me/tracks?limit=${pageLimit}&offset=${offset}`,
      userLevel: true,
    });

    const items = Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      const artists = Array.isArray(item?.track?.artists) ? item.track.artists : [];
      for (const artist of artists) {
        const artistId = typeof artist?.id === "string" ? artist.id : "";
        const name = typeof artist?.name === "string" ? artist.name : "";
        if (!artistId || !name) continue;
        if (!unique.has(artistId)) {
          unique.set(artistId, { artistId, name });
        }
        if (unique.size >= limit) break;
      }
      if (unique.size >= limit) break;
    }

    if (!data?.next || items.length === 0) break;
    offset += items.length;
    pages += 1;
  }

  const items = Array.from(unique.values()).sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" })
  );

  return items.slice(0, limit).map((artist) => ({
    artistId: artist.artistId,
    name: artist.name,
    genres: null as string | null,
    popularity: null as number | null,
    followersTotal: null as number | null,
    imageUrl: null as string | null,
  }));
}

export async function GET(req: Request) {
  const { session, response } = await requireAppUser();
  if (response) return response;
  const rl = await rateLimitResponse({
    key: `artists-list:${session.appUserId}`,
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
  const baseWhere = cursor
    ? (() => {
        const decoded = tryDecodeCursor(cursor);
        if (!decoded) return null;
        return lt(artists.artistId, decoded.id);
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
      artistId: artists.artistId,
      name: artists.name,
      genres: artists.genres,
      popularity: artists.popularity,
      followersTotal: artists.followersTotal,
      imageUrl: artists.imageUrl,
    })
    .from(artists)
    .leftJoin(trackArtists, eq(trackArtists.artistId, artists.artistId))
    .leftJoin(
      userSavedTracks,
      and(
        eq(userSavedTracks.trackId, trackArtists.trackId),
        eq(userSavedTracks.userId, session.appUserId as string)
      )
    )
    .leftJoin(playlistItems, eq(playlistItems.trackId, trackArtists.trackId))
    .leftJoin(
      userPlaylists,
      and(
        eq(userPlaylists.playlistId, playlistItems.playlistId),
        eq(userPlaylists.userId, session.appUserId as string)
      )
    )
    .where(baseWhere ? and(baseWhere, userWhere) : userWhere)
    .groupBy(artists.artistId)
    .orderBy(desc(artists.artistId))
    .limit(limit);

  if (!rows.length && !cursor) {
    try {
      const liveItems = await fetchLiveArtistsFromSavedTracks(limit);
      return jsonNoStore({
        items: liveItems,
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

  const last = rows[rows.length - 1];
  const nextCursor = last ? encodeCursor(0, last.artistId) : null;

  return jsonPrivateCache({ items: rows, nextCursor, asOf: Date.now() });
}
