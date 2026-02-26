import type { NextRequest } from "next/server";
import {
  getCorrelationId,
  jsonNoStore,
  rateLimitResponse,
  requireAppUser,
} from "@/lib/api/guards";
import {
  parseRecommendationsLimit,
  parseRecommendationsSeedTracks,
} from "@/lib/recommendations/recommendationService";
import { RecommendationsServiceError } from "@/lib/recommendations/types";
import { createRecommendationsTraceLogger } from "@/lib/recommendations/troubleshootingLog";
import { getPlaylistOnlyRecommendations } from "@/lib/recommendations/playlistOnlyRecommendations";

export const runtime = "nodejs";

function shouldForceRefresh(req: NextRequest) {
  const raw = String(new URL(req.url).searchParams.get("refresh") ?? "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ playlistId: string }> }
) {
  const correlationId = getCorrelationId(req);
  const started = Date.now();
  const { session, response } = await requireAppUser();
  if (response) return response;

  const { playlistId } = await ctx.params;
  const trace = createRecommendationsTraceLogger({
    correlationId,
    route: "/api/spotify/playlists/[playlistId]/recommendations",
    method: "GET",
    playlistId,
  });
  trace("request_received", {
    data: {
      query: new URL(req.url).searchParams.toString(),
    },
  });

  if (!playlistId) {
    trace("request_failed", {
      level: "warn",
      status: 400,
      code: "MISSING_PLAYLIST_ID",
      message: "Playlist id ontbreekt.",
      durationMs: Date.now() - started,
    });
    return jsonNoStore({ error: "MISSING_PLAYLIST_ID" }, 400, {
      "x-correlation-id": correlationId,
    });
  }

  const searchParams = new URL(req.url).searchParams;
  const rawSeedTracksParam = String(searchParams.get("seed_tracks") ?? "");
  const parsedSeedTracks = rawSeedTracksParam
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const validSeedPattern = /^[0-9A-Za-z]{22}$/;
  const validSeedTracks = parsedSeedTracks.filter((seed) => validSeedPattern.test(seed));
  const invalidSeedTracksSample = parsedSeedTracks
    .filter((seed) => !validSeedPattern.test(seed))
    .slice(0, 2);
  const preferredSeedTracks = parseRecommendationsSeedTracks(rawSeedTracksParam);
  trace("request_seed_tracks_parsed", {
    data: {
      rawSeedTracksString: rawSeedTracksParam.slice(0, 256),
      parsedSeedCount: parsedSeedTracks.length,
      validSeedCount: validSeedTracks.length,
      invalidSeedTracksSample,
      preferredSeedCount: preferredSeedTracks.length,
    },
  });
  let limit = 25;
  try {
    limit = parseRecommendationsLimit(searchParams.get("limit"));
  } catch (error) {
    if (error instanceof RecommendationsServiceError) {
      trace("request_failed", {
        level: "warn",
        status: error.status,
        code: error.code,
        message: error.message,
        durationMs: Date.now() - started,
      });
      return jsonNoStore({ error: error.code, message: error.message }, error.status, {
        "x-correlation-id": correlationId,
      });
    }
    throw error;
  }

  const rl = await rateLimitResponse({
    key: `playlist-recommendations:${session.appUserId}:${playlistId}`,
    limit: 180,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rl) {
    trace("request_rate_limited", {
      level: "warn",
      status: 429,
      code: "RATE_LIMIT",
      durationMs: Date.now() - started,
    });
    return rl;
  }

  try {
    const statusPayload = await getPlaylistOnlyRecommendations({
      userId: session.appUserId as string,
      playlistId,
      limit,
      forceRefresh: shouldForceRefresh(req),
      preferredSeedTracks,
      correlationId,
      mode: shouldForceRefresh(req) ? "refresh" : "initial",
    });
    if (statusPayload.status === "rate_limited") {
      const retryAfter = Math.max(1, Math.floor(statusPayload.retryAfterSeconds ?? 5));
      trace("request_failed", {
        level: "warn",
        status: 429,
        code: "RATE_LIMIT",
        message: "Spotify tijdelijk geblokkeerd (rate limit).",
        durationMs: Date.now() - started,
        data: {
          retryAfterSec: retryAfter,
        },
      });
      return jsonNoStore(
        {
          error: "RATE_LIMIT",
          message: "Spotify tijdelijk geblokkeerd (rate limit).",
          retryAfter: retryAfter,
        },
        429,
        {
          "Retry-After": String(retryAfter),
          "x-correlation-id": correlationId,
        }
      );
    }
    if (statusPayload.status === "auth_required") {
      trace("request_failed", {
        level: "warn",
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Log opnieuw in om aanbevelingen te laden.",
        durationMs: Date.now() - started,
      });
      return jsonNoStore(
        {
          error: "UNAUTHENTICATED",
          message: "Log opnieuw in om aanbevelingen te laden.",
        },
        401,
        { "x-correlation-id": correlationId }
      );
    }
    if (statusPayload.status === "error") {
      trace("request_failed", {
        level: "error",
        status: 503,
        code: statusPayload.code ?? "SPOTIFY_UPSTREAM",
        message: "Spotify is tijdelijk niet bereikbaar.",
        durationMs: Date.now() - started,
      });
      return jsonNoStore(
        {
          error: statusPayload.code ?? "SPOTIFY_UPSTREAM",
          message: "Spotify is tijdelijk niet bereikbaar.",
          requestId: statusPayload.requestId,
        },
        503,
        { "x-correlation-id": correlationId }
      );
    }

    const payload = {
      status: statusPayload.status,
      items: statusPayload.legacyItems,
      totalCount: statusPayload.legacyItems.length,
      asOf: Date.now(),
      reason: statusPayload.legacyReason,
      playlistId,
      snapshotId: null,
      seedTrackCount: statusPayload.seed.trackIds.length,
      seedArtistCount: 0,
      cacheState: "miss" as const,
      diagnostics: {
        seedSource: "live" as const,
        candidateTrackCount: statusPayload.seed.poolSize,
        validatedTrackCount: statusPayload.seed.poolSize,
        seedTrackPoolCount: statusPayload.seed.poolSize,
        preferredSeedTrackCount: preferredSeedTracks.length,
        seedArtistPoolCount: 0,
        attemptsPlanned: statusPayload.meta.topUpUsed ? 2 : 1,
        attemptsUsed: statusPayload.meta.topUpUsed ? 2 : 1,
        fallbackUsed: "none" as const,
      },
      market: statusPayload.market,
      seed: statusPayload.seed,
      tracks: statusPayload.tracks,
      meta: statusPayload.meta,
      hints: statusPayload.hints ?? [],
      requestId: statusPayload.requestId,
    };
    trace("request_succeeded", {
      status: 200,
      durationMs: Date.now() - started,
      data: {
        cacheState: payload.cacheState,
        totalCount: payload.totalCount,
        seedTrackCount: payload.seedTrackCount,
        parsedSeedCount: parsedSeedTracks.length,
        validSeedCount: validSeedTracks.length,
        invalidSeedTracksSample,
        reason: payload.reason ?? null,
        marketUsed: payload.market ?? null,
        spotifyStatus: payload.meta.spotifyStatus ?? null,
        spotifyErrorMessage: payload.meta.spotifyErrorMessage ?? null,
        outboundHost: payload.meta.outboundHost ?? null,
        tokenPresent: payload.meta.tokenPresent ?? null,
      },
    });
    return jsonNoStore(payload, 200, {
      "x-recommendations-cache": payload.cacheState,
      "x-correlation-id": correlationId,
    });
  } catch (error) {
    if (error instanceof RecommendationsServiceError) {
      const headers: Record<string, string> = {};
      if (error.retryAfterSec) {
        headers["Retry-After"] = String(error.retryAfterSec);
      }
      if (error.correlationId) {
        headers["x-correlation-id"] = error.correlationId;
      } else {
        headers["x-correlation-id"] = correlationId;
      }
      trace("request_failed", {
        level: error.status >= 500 ? "error" : "warn",
        status: error.status,
        code: error.code,
        message: error.message,
        durationMs: Date.now() - started,
        data: {
          upstreamCorrelationId: error.correlationId ?? null,
          retryAfterSec: error.retryAfterSec ?? null,
        },
      });
      return jsonNoStore(
        {
          error: error.code,
          message: error.message,
          ...(error.retryAfterSec ? { retryAfter: error.retryAfterSec } : {}),
        },
        error.status,
        headers
      );
    }
    if (String(error).includes("UserNotAuthenticated")) {
      trace("request_failed", {
        level: "warn",
        status: 401,
        code: "UNAUTHENTICATED",
        message: "UserNotAuthenticated",
        durationMs: Date.now() - started,
      });
      return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
    }
    trace("request_failed", {
      level: "error",
      status: 500,
      code: "INTERNAL_ERROR",
      message: String(error),
      durationMs: Date.now() - started,
    });
    return jsonNoStore(
      {
        error: "INTERNAL_ERROR",
        message: "Recommendations laden lukt nu niet.",
      },
      500,
      { "x-correlation-id": correlationId }
    );
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ playlistId: string }> }
) {
  const correlationId = getCorrelationId(req);
  const { session, response } = await requireAppUser();
  if (response) return response;

  const { playlistId } = await ctx.params;
  if (!playlistId) {
    return jsonNoStore(
      {
        status: "error",
        code: "MISSING_PLAYLIST_ID",
        requestId: correlationId,
      },
      400,
      { "x-correlation-id": correlationId }
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    mode?: "initial" | "refresh";
    limit?: number;
    seedTracks?: string[];
  };
  const mode = body.mode === "refresh" ? "refresh" : "initial";
  let limit = 25;
  try {
    limit = Number.isFinite(body.limit) ? parseRecommendationsLimit(String(body.limit)) : 25;
  } catch {
    limit = 25;
  }
  const preferredSeedTracks = Array.isArray(body.seedTracks)
    ? parseRecommendationsSeedTracks(body.seedTracks.join(","))
    : [];

  try {
    const payload = await getPlaylistOnlyRecommendations({
      userId: session.appUserId as string,
      playlistId,
      limit,
      mode,
      forceRefresh: mode === "refresh",
      preferredSeedTracks,
      correlationId,
    });
    if (payload.status === "success" || payload.status === "empty") {
      return jsonNoStore(payload, 200, { "x-correlation-id": correlationId });
    }
    if (payload.status === "rate_limited") {
      const retryAfter = Math.max(1, Math.floor(payload.retryAfterSeconds ?? 5));
      return jsonNoStore(payload, 429, {
        "Retry-After": String(retryAfter),
        "x-correlation-id": correlationId,
      });
    }
    if (payload.status === "auth_required") {
      return jsonNoStore(payload, 401, { "x-correlation-id": correlationId });
    }
    return jsonNoStore(payload, 502, { "x-correlation-id": correlationId });
  } catch (error) {
    if (error instanceof RecommendationsServiceError) {
      if (error.code === "RATE_LIMIT") {
        const retryAfter = Math.max(1, Math.floor(error.retryAfterSec ?? 5));
        return jsonNoStore(
          {
            status: "rate_limited",
            retryAfterSeconds: retryAfter,
          },
          429,
          {
            "Retry-After": String(retryAfter),
            "x-correlation-id": error.correlationId ?? correlationId,
          }
        );
      }
      if (error.code === "UNAUTHENTICATED") {
        return jsonNoStore(
          {
            status: "auth_required",
          },
          401,
          { "x-correlation-id": error.correlationId ?? correlationId }
        );
      }
      return jsonNoStore(
        {
          status: "error",
          code: error.code,
          requestId: error.correlationId ?? correlationId,
        },
        error.status >= 400 && error.status < 600 ? error.status : 500,
        { "x-correlation-id": error.correlationId ?? correlationId }
      );
    }
    return jsonNoStore(
      {
        status: "error",
        code: "INTERNAL_ERROR",
        requestId: correlationId,
      },
      500,
      { "x-correlation-id": correlationId }
    );
  }
}
