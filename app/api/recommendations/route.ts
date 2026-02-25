import { jsonNoStore, requireAppUser } from "@/lib/api/guards";
import { createCorrelationId, readCorrelationId } from "@/lib/observability/correlation";
import { getPlaylistOnlyRecommendations } from "@/lib/recommendations/playlistOnlyRecommendations";
import { parseRecommendationsLimit, parseRecommendationsSeedTracks } from "@/lib/recommendations/recommendationService";
import { RecommendationsServiceError } from "@/lib/recommendations/types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { session, response } = await requireAppUser();
  if (response) return response;

  const correlationId = readCorrelationId(req.headers) || createCorrelationId();
  const body = (await req.json().catch(() => ({}))) as {
    playlistId?: string;
    mode?: "initial" | "refresh";
    seedTracks?: string[];
    limit?: number;
  };

  const playlistId = String(body.playlistId ?? "").trim();
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
    return jsonNoStore(payload, 200, { "x-correlation-id": correlationId });
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

