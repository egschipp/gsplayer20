import type { NextRequest } from "next/server";
import {
  getCorrelationId,
  jsonNoStore,
  rateLimitResponse,
  requireAppUser,
} from "@/lib/api/guards";
import {
  getPlaylistRecommendations,
  parseRecommendationsLimit,
  parseRecommendationsSeedTracks,
} from "@/lib/recommendations/recommendationService";
import { RecommendationsServiceError } from "@/lib/recommendations/types";
import { createRecommendationsTraceLogger } from "@/lib/recommendations/troubleshootingLog";

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
  const preferredSeedTracks = parseRecommendationsSeedTracks(
    searchParams.get("seed_tracks")
  );
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
    const payload = await getPlaylistRecommendations({
      userId: session.appUserId as string,
      playlistId,
      limit,
      forceRefresh: shouldForceRefresh(req),
      preferredSeedTracks,
      correlationId,
    });
    trace("request_succeeded", {
      status: 200,
      durationMs: Date.now() - started,
      data: {
        cacheState: payload.cacheState,
        totalCount: payload.totalCount,
        seedTrackCount: payload.seedTrackCount,
        reason: payload.reason ?? null,
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
