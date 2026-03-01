import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import {
  getCorrelationId,
  jsonNoStore,
  rateLimitResponse,
  requireAppUser,
} from "@/lib/api/guards";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type SpotifyCurrentlyPlayingResponse = {
  timestamp?: number;
  is_playing?: boolean;
  progress_ms?: number;
  device?: {
    id?: string | null;
    name?: string | null;
  };
  item?: {
    id?: string | null;
    uri?: string | null;
    name?: string | null;
    duration_ms?: number;
    artists?: Array<{ name?: string | null }>;
    album?: {
      name?: string | null;
      images?: Array<{ url?: string | null }>;
    };
  };
};

export async function GET(req: NextRequest) {
  const correlationId = getCorrelationId(req);
  const { session, response } = await requireAppUser();
  if (response) return response;

  const rl = await rateLimitResponse({
    key: `currently-playing:${session.appUserId}`,
    limit: 240,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rl) return rl;

  try {
    const data = await spotifyFetch<SpotifyCurrentlyPlayingResponse | undefined>({
      url: "https://api.spotify.com/v1/me/player/currently-playing",
      userLevel: true,
      correlationId,
      priority: "foreground",
      cacheTtlMs: 0,
      dedupeWindowMs: 200,
    });

    const trackId = typeof data?.item?.id === "string" ? data.item.id.trim() : "";
    const trackUri = typeof data?.item?.uri === "string" ? data.item.uri.trim() : "";
    const hasPlayableTrack = Boolean(trackId && trackUri);

    if (!data || !hasPlayableTrack) {
      return new NextResponse(null, {
        status: 204,
        headers: {
          "Cache-Control": "no-store",
        },
      });
    }

    return jsonNoStore({
      playable: true,
      verifiedAt: Date.now(),
      device: {
        id: data.device?.id ?? null,
        name: data.device?.name ?? null,
      },
      track: {
        id: trackId,
        uri: trackUri,
        name: data.item?.name ?? null,
        artists: Array.isArray(data.item?.artists)
          ? data.item?.artists.map((artist) => artist?.name).filter(Boolean)
          : [],
        album: data.item?.album?.name ?? null,
        artworkUrl:
          data.item?.album?.images?.[0]?.url &&
          typeof data.item.album.images[0].url === "string"
            ? data.item.album.images[0].url
            : null,
        durationMs:
          typeof data.item?.duration_ms === "number"
            ? Math.max(0, Math.floor(data.item.duration_ms))
            : 0,
      },
      context: {
        isPlaying: Boolean(data.is_playing),
        positionMs:
          typeof data.progress_ms === "number"
            ? Math.max(0, Math.floor(data.progress_ms))
            : 0,
        timestamp:
          typeof data.timestamp === "number"
            ? Math.max(0, Math.floor(data.timestamp))
            : Date.now(),
      },
    });
  } catch (error) {
    if (error instanceof SpotifyFetchError) {
      if (error.status === 401) return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
      if (error.status === 403) return jsonNoStore({ error: "FORBIDDEN" }, 403);
      if (error.status === 404) {
        return new NextResponse(null, {
          status: 204,
          headers: {
            "Cache-Control": "no-store",
          },
        });
      }
      if (error.status === 429) {
        const retryAfter =
          error.retryAfterMs && error.retryAfterMs > 0
            ? Math.max(1, Math.ceil(error.retryAfterMs / 1000))
            : null;
        return jsonNoStore(
          { error: "RATE_LIMIT", ...(retryAfter ? { retryAfter } : {}) },
          429,
          retryAfter ? { "Retry-After": String(retryAfter) } : undefined
        );
      }
      return jsonNoStore({ error: "SPOTIFY_UPSTREAM" }, 502);
    }
    if (String(error).includes("UserNotAuthenticated")) {
      return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
    }
    return jsonNoStore({ error: "CURRENTLY_PLAYING_FAILED" }, 500);
  }
}
