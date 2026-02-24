import type { NextRequest } from "next/server";
import { jsonNoStore, rateLimitResponse, requireAppUser } from "@/lib/api/guards";
import {
  getPlaylistRecommendations,
  parseRecommendationsLimit,
} from "@/lib/recommendations/recommendationService";
import { RecommendationsServiceError } from "@/lib/recommendations/types";

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
  const { session, response } = await requireAppUser();
  if (response) return response;

  const { playlistId } = await ctx.params;
  if (!playlistId) {
    return jsonNoStore({ error: "MISSING_PLAYLIST_ID" }, 400);
  }

  const searchParams = new URL(req.url).searchParams;
  let limit = 25;
  try {
    limit = parseRecommendationsLimit(searchParams.get("limit"));
  } catch (error) {
    if (error instanceof RecommendationsServiceError) {
      return jsonNoStore({ error: error.code, message: error.message }, error.status);
    }
    throw error;
  }

  const rl = await rateLimitResponse({
    key: `playlist-recommendations:${session.appUserId}:${playlistId}`,
    limit: 180,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rl) return rl;

  try {
    const payload = await getPlaylistRecommendations({
      userId: session.appUserId as string,
      playlistId,
      limit,
      forceRefresh: shouldForceRefresh(req),
    });
    return jsonNoStore(payload, 200, {
      "x-recommendations-cache": payload.cacheState,
    });
  } catch (error) {
    if (error instanceof RecommendationsServiceError) {
      const headers: Record<string, string> = {};
      if (error.retryAfterSec) {
        headers["Retry-After"] = String(error.retryAfterSec);
      }
      if (error.correlationId) {
        headers["x-correlation-id"] = error.correlationId;
      }
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
      return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
    }
    return jsonNoStore(
      {
        error: "INTERNAL_ERROR",
        message: "Recommendations laden lukt nu niet.",
      },
      500
    );
  }
}
