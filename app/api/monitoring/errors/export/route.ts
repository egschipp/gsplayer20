import { jsonNoStore, requireAppUser } from "@/lib/api/guards";
import { counterEntries } from "@/lib/observability/metrics";
import { getRecentErrors } from "@/lib/observability/logger";
import { getRecentRateLimitActivities } from "@/lib/observability/rateLimitActivities";
import {
  createCorrelationId,
  readCorrelationId,
} from "@/lib/observability/correlation";

export const runtime = "nodejs";

type EndpointErrorAggregate = {
  endpoint: string;
  totalErrors: number;
  statusClass: {
    "4xx": number;
    "5xx": number;
  };
  methods: Array<{ method: string; count: number }>;
};

export async function GET(req: Request) {
  const { response } = await requireAppUser();
  if (response) return response;

  const correlationId = readCorrelationId(req.headers) || createCorrelationId();
  const now = Date.now();

  const requestCounterRows = counterEntries("spotify_api_requests_total");
  const errorRows = requestCounterRows.filter((row) => {
    const statusClass = String(row.labels.status_class || "").toLowerCase();
    return statusClass === "4xx" || statusClass === "5xx";
  });

  const byEndpoint = new Map<
    string,
    {
      totalErrors: number;
      statusClass: { "4xx": number; "5xx": number };
      methods: Map<string, number>;
    }
  >();

  for (const row of errorRows) {
    const endpoint = String(row.labels.endpoint || "unknown").trim() || "unknown";
    const statusClass = String(row.labels.status_class || "").toLowerCase();
    const method = String(row.labels.method || "unknown").toUpperCase();

    const current =
      byEndpoint.get(endpoint) ?? {
        totalErrors: 0,
        statusClass: { "4xx": 0, "5xx": 0 },
        methods: new Map<string, number>(),
      };

    current.totalErrors += row.value;
    if (statusClass === "4xx") current.statusClass["4xx"] += row.value;
    if (statusClass === "5xx") current.statusClass["5xx"] += row.value;
    current.methods.set(method, (current.methods.get(method) || 0) + row.value);

    byEndpoint.set(endpoint, current);
  }

  const errorMix: EndpointErrorAggregate[] = Array.from(byEndpoint.entries())
    .map(([endpoint, data]) => ({
      endpoint,
      totalErrors: data.totalErrors,
      statusClass: data.statusClass,
      methods: Array.from(data.methods.entries())
        .map(([method, count]) => ({ method, count }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.totalErrors - a.totalErrors);

  const recentErrors = getRecentErrors(200).map((entry, index) => ({
    id: `${entry.ts}-${index}`,
    ...entry,
  }));
  const recentRateLimitActivities = getRecentRateLimitActivities(500, 3_600_000);

  return jsonNoStore(
    {
      generatedAt: now,
      correlationId,
      exportType: "monitoring_error_mix_recent_errors",
      errorMix: {
        totalEndpoints: errorMix.length,
        totalErrorRequests: errorMix.reduce((sum, row) => sum + row.totalErrors, 0),
        endpoints: errorMix,
        rawCounterRows: errorRows,
      },
      recentErrors: {
        total: recentErrors.length,
        items: recentErrors,
      },
      recentRateLimitActivities: {
        total: recentRateLimitActivities.length,
        items: recentRateLimitActivities,
      },
    },
    200,
    { "x-correlation-id": correlationId }
  );
}
