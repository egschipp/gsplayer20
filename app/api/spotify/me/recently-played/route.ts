import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { tracks, userRecentlyPlayed } from "@/lib/db/schema";
import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { incCounter } from "@/lib/observability/metrics";
import {
  jsonNoStore,
  rateLimitResponse,
  requireAppUser,
} from "@/lib/api/guards";
import {
  buildDataSourceMeta,
  getSpotifyResourcePolicy,
} from "@/lib/spotify/cachePolicy";
import {
  upsertArtist,
  upsertRecentlyPlayed,
  upsertTrack,
  upsertTrackArtist,
} from "@/lib/db/queries";

export const runtime = "nodejs";

const TRACK_ID_REGEX = /^[A-Za-z0-9]{22}$/;

type SpotifyRecentlyPlayedResponse = {
  items?: Array<{
    played_at?: string;
    context?: { uri?: string | null };
    track?: {
      id?: string | null;
      uri?: string | null;
      name?: string | null;
      duration_ms?: number;
      explicit?: boolean;
      is_local?: boolean;
      linked_from?: { id?: string | null };
      restrictions?: { reason?: string | null };
      album?: {
        id?: string | null;
        name?: string | null;
        release_date?: string | null;
        images?: Array<{ url?: string | null }>;
      };
      artists?: Array<{ id?: string | null; name?: string | null }>;
      popularity?: number;
    };
  }>;
};

function parseReleaseYear(releaseDate: string | null | undefined) {
  if (!releaseDate || !/^\d{4}/.test(releaseDate)) return null;
  return Number(releaseDate.slice(0, 4));
}

async function readRecentlyPlayedFromDb(args: {
  userId: string;
  limit: number;
  trackIdFilter: string | null;
}) {
  const db = getDb();
  const where = args.trackIdFilter
    ? and(
        eq(userRecentlyPlayed.userId, args.userId),
        eq(userRecentlyPlayed.trackId, args.trackIdFilter)
      )
    : eq(userRecentlyPlayed.userId, args.userId);

  const rows = await db
    .select({
      entryId: userRecentlyPlayed.entryId,
      playedAt: userRecentlyPlayed.playedAt,
      trackId: userRecentlyPlayed.trackId,
      contextUri: userRecentlyPlayed.contextUri,
      name: userRecentlyPlayed.trackName,
      artistNames: userRecentlyPlayed.artistNames,
      durationMs: userRecentlyPlayed.durationMs,
      albumImageUrl: userRecentlyPlayed.albumImageUrl,
      trackNameFallback: tracks.name,
      albumImageFallback: tracks.albumImageUrl,
      trackDurationFallback: tracks.durationMs,
    })
    .from(userRecentlyPlayed)
    .leftJoin(tracks, eq(tracks.trackId, userRecentlyPlayed.trackId))
    .where(where)
    .orderBy(desc(userRecentlyPlayed.playedAt))
    .limit(args.limit);

  return rows.map((row) => ({
    entryId: row.entryId,
    playedAt: row.playedAt,
    trackId: row.trackId,
    uri: row.trackId ? `spotify:track:${row.trackId}` : null,
    name: row.name ?? row.trackNameFallback ?? null,
    artistNames: row.artistNames ?? null,
    durationMs: row.durationMs ?? row.trackDurationFallback ?? null,
    explicit: null,
    isLocal: null,
    linkedFromTrackId: null,
    restrictionsReason: null,
    albumId: null,
    albumName: null,
    albumReleaseDate: null,
    releaseYear: null,
    albumImageUrl: row.albumImageUrl ?? row.albumImageFallback ?? null,
    popularity: null,
    contextUri: row.contextUri ?? null,
    artists: [],
  }));
}

export async function GET(req: Request) {
  const { session, response } = await requireAppUser();
  if (response) return response;

  const rl = await rateLimitResponse({
    key: `me-recently-played:${session.appUserId}`,
    limit: 180,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rl) return rl;

  const { searchParams } = new URL(req.url);
  const limitRaw = Number(searchParams.get("limit") ?? "30");
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), 50)
      : 30;
  const trackIdFilterRaw = searchParams.get("trackId");
  const trackIdFilter =
    trackIdFilterRaw && TRACK_ID_REGEX.test(trackIdFilterRaw) ? trackIdFilterRaw : null;
  const policy = getSpotifyResourcePolicy("recently_played");

  try {
    const data = await spotifyFetch<SpotifyRecentlyPlayedResponse>({
      url: `https://api.spotify.com/v1/me/player/recently-played?limit=${limit}`,
      userLevel: true,
      priority: "default",
      cacheTtlMs: policy.cacheTtlMs,
      dedupeWindowMs: policy.dedupeWindowMs,
    });

    const sourceItems = Array.isArray(data?.items) ? data.items : [];
    const mapped = sourceItems
      .map((item, index) => {
        const track = item?.track;
        const trackId = typeof track?.id === "string" ? track.id : null;
        if (trackIdFilter && trackId !== trackIdFilter) return null;
        const playedAtRaw = item?.played_at ? Date.parse(item.played_at) : NaN;
        const playedAt = Number.isFinite(playedAtRaw) ? playedAtRaw : Date.now();
        const artistNames = Array.isArray(track?.artists)
          ? track.artists
              .map((artist) => artist?.name)
              .filter((name): name is string => Boolean(name))
              .join(", ")
          : "";
        const albumImageUrl =
          track?.album?.images?.find((image) => typeof image?.url === "string")?.url ??
          null;
        const durationMs =
          typeof track?.duration_ms === "number"
            ? Math.max(0, Math.floor(track.duration_ms))
            : null;
        const explicit =
          typeof track?.explicit === "boolean" ? (track.explicit ? 1 : 0) : null;
        const isLocal =
          typeof track?.is_local === "boolean" ? (track.is_local ? 1 : 0) : null;
        const linkedFromTrackId =
          typeof track?.linked_from?.id === "string" ? track.linked_from.id : null;
        const restrictionsReason =
          typeof track?.restrictions?.reason === "string"
            ? track.restrictions.reason
            : null;
        const entryId = createHash("sha1")
          .update(`${playedAt}:${trackId ?? track?.uri ?? index}`)
          .digest("hex");

        return {
          entryId,
          playedAt,
          trackId,
          uri: track?.uri ?? null,
          name: track?.name ?? null,
          artistNames: artistNames || null,
          durationMs,
          explicit,
          isLocal,
          linkedFromTrackId,
          restrictionsReason,
          albumId: track?.album?.id ?? null,
          albumName: track?.album?.name ?? null,
          albumReleaseDate: track?.album?.release_date ?? null,
          releaseYear: parseReleaseYear(track?.album?.release_date),
          albumImageUrl,
          popularity:
            typeof track?.popularity === "number" ? Math.floor(track.popularity) : null,
          contextUri: item?.context?.uri ?? null,
          artists: Array.isArray(track?.artists)
            ? track.artists
                .map((artist) => {
                  const artistId = typeof artist?.id === "string" ? artist.id : "";
                  const name = typeof artist?.name === "string" ? artist.name : "";
                  return artistId && name ? { id: artistId, name } : null;
                })
                .filter((artist): artist is { id: string; name: string } => Boolean(artist))
            : [],
        };
      })
      .filter(
        (
          item
        ): item is {
          entryId: string;
          playedAt: number;
          trackId: string | null;
          uri: string | null;
          name: string | null;
          artistNames: string | null;
          durationMs: number | null;
          explicit: number | null;
          isLocal: number | null;
          linkedFromTrackId: string | null;
          restrictionsReason: string | null;
          albumId: string | null;
          albumName: string | null;
          albumReleaseDate: string | null;
          releaseYear: number | null;
          albumImageUrl: string | null;
          popularity: number | null;
          contextUri: string | null;
          artists: { id: string; name: string }[];
        } => Boolean(item)
      );

    for (const item of mapped) {
      try {
        if (item.trackId) {
          await upsertTrack({
            trackId: item.trackId,
            name: item.name ?? "Onbekend nummer",
            durationMs: item.durationMs ?? 0,
            explicit: item.explicit === 1,
            isLocal: item.isLocal === null ? null : item.isLocal === 1,
            restrictionsReason: item.restrictionsReason,
            linkedFromTrackId: item.linkedFromTrackId,
            albumId: item.albumId,
            popularity: item.popularity,
          });
          for (const artist of item.artists) {
            await upsertArtist({
              artistId: artist.id,
              name: artist.name,
              genres: null,
              popularity: null,
            });
            await upsertTrackArtist(item.trackId, artist.id);
          }
        }
        await upsertRecentlyPlayed({
          userId: session.appUserId as string,
          entryId: item.entryId,
          playedAt: item.playedAt,
          trackId: item.trackId,
          contextUri: item.contextUri,
          trackName: item.name,
          artistNames: item.artistNames,
          albumImageUrl: item.albumImageUrl,
          durationMs: item.durationMs,
        });
      } catch {
        // Keep serving live data even if local cache persistence fails.
      }
    }

    return jsonNoStore({
      items: mapped,
      asOf: Date.now(),
      meta: buildDataSourceMeta({
        resource: "recently_played",
        source: "live",
        asOf: Date.now(),
        staleSec: 0,
        degraded: false,
      }),
    });
  } catch (error) {
    const fallbackRows = await readRecentlyPlayedFromDb({
      userId: session.appUserId as string,
      limit,
      trackIdFilter,
    });

    if (error instanceof SpotifyFetchError) {
      if (error.status === 401) return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
      if (error.status === 403) return jsonNoStore({ error: "FORBIDDEN" }, 403);
      if (error.status === 404) {
        incCounter("spotify_route_degraded_total", {
          route: "me_recently_played",
          reason: "live_not_found",
        });
        return jsonNoStore({
          items: fallbackRows,
          asOf: Date.now(),
          meta: buildDataSourceMeta({
            resource: "recently_played",
            source: "db",
            asOf: Date.now(),
            staleSec: null,
            degraded: true,
            degradeReason: "live_not_found",
          }),
        });
      }
      if (error.status === 429 || error.status >= 500) {
        incCounter("spotify_route_degraded_total", {
          route: "me_recently_played",
          reason: error.status === 429 ? "live_rate_limited" : "live_spotify_upstream",
        });
        return jsonNoStore({
          items: fallbackRows,
          asOf: Date.now(),
          meta: buildDataSourceMeta({
            resource: "recently_played",
            source: "db",
            asOf: Date.now(),
            staleSec: null,
            degraded: true,
            degradeReason: error.status === 429 ? "live_rate_limited" : "live_spotify_upstream",
          }),
        });
      }
      return jsonNoStore({ error: "SPOTIFY_UPSTREAM" }, 502);
    }
    if (String(error).includes("UserNotAuthenticated")) {
      return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
    }
    incCounter("spotify_route_degraded_total", {
      route: "me_recently_played",
      reason: "live_failed",
    });
    return jsonNoStore({
      items: fallbackRows,
      asOf: Date.now(),
      meta: buildDataSourceMeta({
        resource: "recently_played",
        source: "db",
        asOf: Date.now(),
        staleSec: null,
        degraded: true,
        degradeReason: "live_failed",
      }),
    });
  }
}
