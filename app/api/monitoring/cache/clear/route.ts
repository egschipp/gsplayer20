import { jsonNoStore, requireAppUser } from "@/lib/api/guards";
import { clearMetrics } from "@/lib/observability/metrics";
import { clearRecentErrors } from "@/lib/observability/logger";
import { clearRateLimitActivityLog } from "@/lib/observability/rateLimitActivities";
import { clearAppTokenCache } from "@/lib/spotify/tokens";
import {
  createCorrelationId,
  readCorrelationId,
} from "@/lib/observability/correlation";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { response } = await requireAppUser();
  if (response) return response;

  const correlationId = readCorrelationId(req.headers) || createCorrelationId();

  clearMetrics();
  clearRecentErrors();
  clearRateLimitActivityLog();
  clearAppTokenCache();

  return jsonNoStore(
    {
      ok: true,
      cleared: ["metrics", "recentErrors", "rateLimitActivityLog", "appTokenCache"],
      correlationId,
    },
    200,
    { "x-correlation-id": correlationId }
  );
}
