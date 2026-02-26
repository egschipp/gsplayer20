import { jsonNoStore, requireAppUser } from "@/lib/api/guards";
import { createCorrelationId, readCorrelationId } from "@/lib/observability/correlation";
import { getRecommendationsTraces } from "@/lib/recommendations/troubleshootingLog";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { response } = await requireAppUser();
  if (response) return response;

  const correlationId = readCorrelationId(req.headers) || createCorrelationId();
  const traces = getRecommendationsTraces({ limit: 1000 });
  const latest = [...traces].reverse().find((trace) => {
    const outboundUrl = String(trace.data?.outboundUrl ?? "").trim();
    if (outboundUrl.startsWith("https://api.spotify.com/")) return true;
    const outboundHost = String(trace.data?.outboundHost ?? "").trim();
    const outboundPath = String(trace.data?.outboundPath ?? "").trim();
    return outboundHost === "api.spotify.com" && outboundPath.startsWith("/v1/");
  });

  const outboundUrlRaw = String(latest?.data?.outboundUrl ?? "").trim();
  const outboundHost = String(latest?.data?.outboundHost ?? "").trim();
  const outboundPath = String(latest?.data?.outboundPath ?? "").trim();
  const outboundUrl =
    outboundUrlRaw ||
    (outboundHost && outboundPath ? `https://${outboundHost}${outboundPath}` : null);

  return jsonNoStore(
    {
      correlationId,
      found: Boolean(outboundUrl),
      outboundUrl,
      at: latest?.ts ?? null,
      stage: latest?.stage ?? null,
    },
    200,
    { "x-correlation-id": correlationId }
  );
}

