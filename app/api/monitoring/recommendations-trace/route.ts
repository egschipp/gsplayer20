import { jsonNoStore, requireAppUser } from "@/lib/api/guards";
import { createCorrelationId, readCorrelationId } from "@/lib/observability/correlation";
import { getRecommendationsTraces } from "@/lib/recommendations/troubleshootingLog";

export const runtime = "nodejs";

function parseLimit(value: string | null) {
  const parsed = Number(value ?? "200");
  if (!Number.isFinite(parsed)) return 200;
  return Math.max(10, Math.min(1000, Math.floor(parsed)));
}

export async function GET(req: Request) {
  const { response } = await requireAppUser();
  if (response) return response;

  const correlationId = readCorrelationId(req.headers) || createCorrelationId();
  const url = new URL(req.url);
  const payload = {
    generatedAt: Date.now(),
    correlationId,
    traces: getRecommendationsTraces({
      limit: parseLimit(url.searchParams.get("limit")),
      correlationId: url.searchParams.get("correlationId"),
      playlistId: url.searchParams.get("playlistId"),
    }),
  };

  return jsonNoStore(payload, 200, { "x-correlation-id": correlationId });
}

