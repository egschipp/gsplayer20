import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { nextPlayerSyncSeq } from "@/lib/spotify/playerSyncSeq";
import {
  getCorrelationId,
  jsonNoStore,
  rateLimitResponse,
  requireAppUser,
  requireSameOrigin,
} from "@/lib/api/guards";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type SpotifyPlayerResponse = {
  timestamp?: number;
  currently_playing_type?: "track" | "episode" | "ad" | "unknown";
  actions?: {
    disallows?: Record<string, boolean | null | undefined>;
  };
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

export async function GET(req: NextRequest) {
  const correlationId = getCorrelationId(req);
  const raw = req.nextUrl.searchParams.get("raw") === "1";
  const { session, response } = await requireAppUser();
  if (response) return response;

  const rl = await rateLimitResponse({
    key: `me-player:${session.appUserId}`,
    limit: 240,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rl) return rl;
  const userKey = String(session.appUserId || "");

  try {
    const data = await spotifyFetch<SpotifyPlayerResponse | undefined>({
      url: "https://api.spotify.com/v1/me/player",
      userLevel: true,
      correlationId,
      priority: "foreground",
      cacheTtlMs: 0,
      dedupeWindowMs: 200,
    });

    if (!data) {
      const serverSeq = nextPlayerSyncSeq(userKey);
      return new NextResponse(null, {
        status: 204,
        headers: {
          "Cache-Control": "no-store",
          "X-Player-Sync-Seq": String(serverSeq),
        },
      });
    }

    const serverSeq = nextPlayerSyncSeq(userKey);
    const syncMeta = {
      serverSeq,
      serverTime: Date.now(),
      source: "player_route",
    };

    if (raw) {
      const disallowsRaw = data.actions?.disallows;
      const disallows =
        disallowsRaw && typeof disallowsRaw === "object"
          ? Object.fromEntries(
              Object.entries(disallowsRaw).map(([key, value]) => [
                key,
                Boolean(value),
              ])
            )
          : {};
      return jsonNoStore({
        device: data.device ?? null,
        context: data.context ?? null,
        item: data.item ?? null,
        progress_ms:
          typeof data.progress_ms === "number" ? Math.max(0, data.progress_ms) : 0,
        is_playing: Boolean(data.is_playing),
        shuffle_state: Boolean(data.shuffle_state),
        repeat_state:
          data.repeat_state === "track" || data.repeat_state === "context"
            ? data.repeat_state
            : "off",
        timestamp:
          typeof data.timestamp === "number" ? Math.max(0, data.timestamp) : Date.now(),
        currently_playing_type:
          data.currently_playing_type === "track" ||
          data.currently_playing_type === "episode" ||
          data.currently_playing_type === "ad"
            ? data.currently_playing_type
            : "unknown",
        actions: {
          disallows,
        },
        sync: syncMeta,
      });
    }

    if (!data.item) {
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
      timestamp:
        typeof data.timestamp === "number" ? Math.max(0, data.timestamp) : Date.now(),
      currentlyPlayingType:
        data.currently_playing_type === "track" ||
        data.currently_playing_type === "episode" ||
        data.currently_playing_type === "ad"
          ? data.currently_playing_type
          : "unknown",
      disallows:
        data.actions?.disallows && typeof data.actions.disallows === "object"
          ? Object.fromEntries(
              Object.entries(data.actions.disallows).map(([key, value]) => [
                key,
                Boolean(value),
              ])
            )
          : {},
      fetchedAt: Date.now(),
      sync: syncMeta,
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

    return jsonNoStore({ error: "PLAYBACK_STATE_FAILED" }, 500);
  }
}

export async function PUT(req: NextRequest) {
  const correlationId = getCorrelationId(req);
  const originError = requireSameOrigin(req);
  if (originError) return originError;

  const { session, response } = await requireAppUser();
  if (response) return response;

  const rl = await rateLimitResponse({
    key: `me-player-put:${session.appUserId}`,
    limit: 180,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rl) return rl;

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return jsonNoStore({ error: "INVALID_BODY" }, 400);
  }

  const deviceIds = Array.isArray(body?.device_ids)
    ? body.device_ids
        .map((value: unknown) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
        .slice(0, 5)
    : [];
  if (!deviceIds.length) {
    return jsonNoStore({ error: "INVALID_DEVICE_IDS" }, 400);
  }
  const play = body?.play === true;
  const expectedActiveDeviceId =
    typeof body?.expectedActiveDeviceId === "string" && body.expectedActiveDeviceId.trim()
      ? body.expectedActiveDeviceId.trim().slice(0, 128)
      : null;

  if (expectedActiveDeviceId) {
    try {
      const current = await spotifyFetch<{ device?: { id?: string | null } | null } | undefined>({
        url: "https://api.spotify.com/v1/me/player",
        userLevel: true,
        correlationId,
        priority: "foreground",
        cacheTtlMs: 0,
        dedupeWindowMs: 200,
      });
      const currentDeviceId =
        typeof current?.device?.id === "string" ? current.device.id : null;
      if (currentDeviceId && currentDeviceId !== expectedActiveDeviceId) {
        return jsonNoStore(
          {
            error: "DEVICE_CONFLICT",
            expectedActiveDeviceId,
            currentDeviceId,
          },
          409
        );
      }
    } catch (error) {
      if (!(error instanceof SpotifyFetchError && error.status === 404)) {
        if (error instanceof SpotifyFetchError) {
          if (error.status === 401) return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
          if (error.status === 403) return jsonNoStore({ error: "FORBIDDEN" }, 403);
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
        return jsonNoStore({ error: "PLAYBACK_TRANSFER_FAILED" }, 500);
      }
    }
  }

  try {
    await spotifyFetch({
      url: "https://api.spotify.com/v1/me/player",
      method: "PUT",
      body: { device_ids: deviceIds, play },
      userLevel: true,
      correlationId,
      priority: "foreground",
      bypassCache: true,
    });
    return jsonNoStore({ ok: true, deviceIds, play });
  } catch (error) {
    if (error instanceof SpotifyFetchError) {
      if (error.status === 401) return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
      if (error.status === 403) return jsonNoStore({ error: "FORBIDDEN" }, 403);
      if (error.status === 404) return jsonNoStore({ error: "DEVICE_NOT_FOUND" }, 404);
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
    return jsonNoStore({ error: "PLAYBACK_TRANSFER_FAILED" }, 500);
  }
}
