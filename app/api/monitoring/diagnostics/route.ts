import crypto from "crypto";
import { jsonNoStore, requireAppUser } from "@/lib/api/guards";
import { getRecentErrors } from "@/lib/observability/logger";
import { counterTotal, histogramQuantiles } from "@/lib/observability/metrics";
import { getSpotifyRateLimiterSnapshot } from "@/lib/spotify/rateLimitManager";
import {
  createCorrelationId,
  readCorrelationId,
} from "@/lib/observability/correlation";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { session, response } = await requireAppUser();
  if (response) return response;

  const correlationId = readCorrelationId(req.headers) || createCorrelationId();

  const sessionHash =
    typeof session.appUserId === "string" && session.appUserId.trim()
      ? crypto.createHash("sha256").update(session.appUserId).digest("hex").slice(0, 16)
      : null;
  const scopeCount =
    typeof session.scope === "string"
      ? session.scope
          .split(/\s+/)
          .map((value) => value.trim())
          .filter(Boolean).length
      : 0;

  const payload = {
    generatedAt: Date.now(),
    correlationId,
    app: {
      nodeEnv: process.env.NODE_ENV || "unknown",
      hasUpstash:
        Boolean(process.env.UPSTASH_REDIS_REST_URL) &&
        Boolean(process.env.UPSTASH_REDIS_REST_TOKEN),
      trustProxy: process.env.TRUST_PROXY === "true",
      authLogEnabled: process.env.AUTH_LOG_ENABLED === "true",
    },
    session: {
      appUserHash: sessionHash,
      hasSpotifyUser: Boolean(session.spotifyUserId),
      scopeCount,
    },
    metrics: {
      requests2xx: counterTotal("spotify_api_requests_total", {
        status_class: "2xx",
      }),
      requests4xx: counterTotal("spotify_api_requests_total", {
        status_class: "4xx",
      }),
      requests5xx: counterTotal("spotify_api_requests_total", {
        status_class: "5xx",
      }),
      retries: counterTotal("spotify_api_retries_total"),
      cacheHits: counterTotal("spotify_cache_hits_total"),
      cacheMisses: counterTotal("spotify_cache_misses_total"),
      latency: histogramQuantiles("spotify_api_latency_ms"),
    },
    rateLimiter: getSpotifyRateLimiterSnapshot(),
    recentErrors: getRecentErrors(50).map((entry) => ({
      ts: entry.ts,
      level: entry.level,
      event: entry.event,
      code: entry.errorCode || null,
      message: entry.errorMessage || null,
      correlationId: entry.correlationId || null,
      endpoint: entry.endpointGroup || null,
    })),
  };

  return jsonNoStore(payload, 200, { "x-correlation-id": correlationId });
}
