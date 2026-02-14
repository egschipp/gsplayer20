import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import {
  jsonNoStore,
  rateLimitResponse,
  requireAppUser,
} from "@/lib/api/guards";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type SpotifyPlayerResponse = {
  device?: {
    id?: string | null;
    name?: string | null;
  };
  context?: {
    uri?: string | null;
  };
  item?: {
    id?: string | null;
    uri?: string | null;
    name?: string | null;
    duration_ms?: number;
    artists?: Array<{ name?: string | null }>;
    album?: {
      images?: Array<{ url?: string | null }>;
    };
  };
  progress_ms?: number;
  is_playing?: boolean;
  shuffle_state?: boolean;
  repeat_state?: "off" | "track" | "context";
};

export async function GET() {
  const { session, response } = await requireAppUser();
  if (response) return response;

  const rl = await rateLimitResponse({
    key: `me-player:${session.appUserId}`,
    limit: 240,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rl) return rl;

  try {
    const data = await spotifyFetch<SpotifyPlayerResponse | undefined>({
      url: "https://api.spotify.com/v1/me/player",
      userLevel: true,
    });

    if (!data || !data.item) {
      return new NextResponse(null, {
        status: 204,
        headers: {
          "Cache-Control": "no-store",
        },
      });
    }

    return jsonNoStore({
      deviceId: data.device?.id ?? null,
      deviceName: data.device?.name ?? null,
      contextUri: data.context?.uri ?? null,
      itemUri: data.item?.uri ?? null,
      trackId: data.item?.id ?? null,
      trackName: data.item?.name ?? null,
      artistNames: Array.isArray(data.item?.artists)
        ? data.item?.artists
            .map((artist) => artist?.name)
            .filter(Boolean)
            .join(", ") || null
        : null,
      artworkUrl:
        data.item?.album?.images?.[0]?.url &&
        typeof data.item.album.images[0].url === "string"
          ? data.item.album.images[0].url
          : null,
      progressMs:
        typeof data.progress_ms === "number" ? Math.max(0, data.progress_ms) : 0,
      durationMs:
        typeof data.item?.duration_ms === "number"
          ? Math.max(0, data.item.duration_ms)
          : 0,
      isPlaying: Boolean(data.is_playing),
      shuffleState: Boolean(data.shuffle_state),
      repeatState:
        data.repeat_state === "track" || data.repeat_state === "context"
          ? data.repeat_state
          : "off",
      fetchedAt: Date.now(),
    });
  } catch (error) {
    if (error instanceof SpotifyFetchError) {
      if (error.status === 401) {
        return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
      }
      if (error.status === 403) {
        return jsonNoStore({ error: "FORBIDDEN" }, 403);
      }
      if (error.status === 404) {
        return new NextResponse(null, {
          status: 204,
          headers: {
            "Cache-Control": "no-store",
          },
        });
      }
      if (error.status === 429) {
        return jsonNoStore({ error: "RATE_LIMIT" }, 429);
      }
      return jsonNoStore({ error: "SPOTIFY_UPSTREAM" }, 502);
    }

    if (String(error).includes("UserNotAuthenticated")) {
      return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
    }

    return jsonNoStore({ error: "PLAYBACK_STATE_FAILED" }, 500);
  }
}
