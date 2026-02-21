import { jsonNoStore, requireAppUser } from "@/lib/api/guards";
import { getRecentErrors } from "@/lib/observability/logger";
import { counterTotal, histogramQuantiles } from "@/lib/observability/metrics";
import {
  createCorrelationId,
  readCorrelationId,
} from "@/lib/observability/correlation";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { session, response } = await requireAppUser();
  if (response) return response;

  const correlationId = readCorrelationId(req.headers) || createCorrelationId();

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
      appUserId: session.appUserId ?? null,
      spotifyUserId: session.spotifyUserId ?? null,
      scope: session.scope ?? null,
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
      latency: histogramQuantiles("spotify_api_latency_ms"),
    },
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

