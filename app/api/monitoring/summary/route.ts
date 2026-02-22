import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { oauthTokens } from "@/lib/db/schema";
import { jsonNoStore, requireAppUser } from "@/lib/api/guards";
import {
  counterEntries,
  counterTotal,
  histogramQuantiles,
  topCounterByLabel,
} from "@/lib/observability/metrics";
import { getRecentErrors } from "@/lib/observability/logger";
import { getSpotifyRateLimitSnapshot } from "@/lib/observability/rateLimit";

export const runtime = "nodejs";

export async function GET() {
  const { session, response } = await requireAppUser();
  if (response) return response;

  const db = getDb();
  const now = Date.now();

  const tokenRow = await db
    .select({
      scope: oauthTokens.scope,
      accessExpiresAt: oauthTokens.accessExpiresAt,
      updatedAt: oauthTokens.updatedAt,
    })
    .from(oauthTokens)
    .where(eq(oauthTokens.userId, session.appUserId as string))
    .get();

  const refreshSuccess = counterTotal("spotify_token_refresh_total", {
    outcome: "success",
  });
  const refreshInvalidGrant = counterTotal("spotify_token_refresh_total", {
    outcome: "invalid_grant",
  });
  const refreshFailed = counterTotal("spotify_token_refresh_total", {
    outcome: "refresh_failed",
  });
  const refreshLockTimeout = counterTotal("spotify_token_refresh_total", {
    outcome: "lock_timeout",
  });
  const refreshAttempts =
    refreshSuccess + refreshInvalidGrant + refreshFailed + refreshLockTimeout;

  const apiSuccess = counterTotal("spotify_api_requests_total", {
    status_class: "2xx",
  });
  const api4xx = counterTotal("spotify_api_requests_total", {
    status_class: "4xx",
  });
  const api5xx = counterTotal("spotify_api_requests_total", {
    status_class: "5xx",
  });
  const apiTotal = apiSuccess + api4xx + api5xx;
  const apiLatency = histogramQuantiles("spotify_api_latency_ms");
  const refreshLockLatency = histogramQuantiles("spotify_refresh_lock_wait_ms");
  const rateLimitSnapshot = getSpotifyRateLimitSnapshot(now);

  const expiresInSec =
    typeof tokenRow?.accessExpiresAt === "number" && tokenRow.accessExpiresAt > 0
      ? Math.max(0, Math.floor((tokenRow.accessExpiresAt - now) / 1000))
      : null;

  const scopes =
    typeof tokenRow?.scope === "string"
      ? tokenRow.scope.split(" ").filter(Boolean)
      : [];

  const errors = getRecentErrors(25).map((entry, index) => ({
    id: `${entry.ts}-${index}`,
    at: Date.parse(entry.ts),
    level: entry.level,
    code: entry.errorCode || "UNKNOWN",
    message: entry.errorMessage || entry.event,
    endpoint: entry.endpointGroup || null,
    correlationId: entry.correlationId || "n/a",
    appUserHash: entry.appUserHash || null,
  }));

  const incidents: Array<{
    id: string;
    severity: "P0" | "P1" | "P2";
    title: string;
    startedAt: number;
  }> = [];
  if (refreshInvalidGrant > 0) {
    incidents.push({
      id: "invalid-grant",
      severity: "P1",
      title: "Refresh token ongeldig (invalid_grant)",
      startedAt: now,
    });
  }
  if (api5xx >= 10) {
    incidents.push({
      id: "spotify-5xx-burst",
      severity: "P1",
      title: "Spotify upstream 5xx burst",
      startedAt: now,
    });
  }

  const requestCounters = counterEntries("spotify_api_requests_total");
  const errorBreakdownMap = new Map<string, number>();
  for (const row of requestCounters) {
    const statusClass = String(row.labels.status_class || "").toLowerCase();
    if (statusClass !== "4xx" && statusClass !== "5xx") continue;
    const endpoint = String(row.labels.endpoint || "unknown").trim() || "unknown";
    const statusCode = String(row.labels.status_code || "").trim();
    const isExpectedPlayer404 =
      statusCode === "404" &&
      (endpoint === "me_player" || endpoint === "me_player_devices");
    if (isExpectedPlayer404) continue;
    errorBreakdownMap.set(endpoint, (errorBreakdownMap.get(endpoint) || 0) + row.value);
  }
  const errorBreakdown = Array.from(errorBreakdownMap.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  return jsonNoStore({
    generatedAt: now,
    meta: {
      environment: process.env.NODE_ENV || "unknown",
    },
    authStatus: {
      status:
        !session?.accessToken || !tokenRow
          ? "DISCONNECTED"
          : refreshInvalidGrant > 0
          ? "REAUTH_REQUIRED"
          : "CONNECTED",
      scopes,
      userId: session.spotifyUserId ?? null,
      appUserId: session.appUserId ?? null,
      lastAuthAt: tokenRow?.updatedAt ?? null,
    },
    tokenHealth: {
      expiresInSec,
      refreshSuccessRate:
        refreshAttempts > 0 ? Number((refreshSuccess / refreshAttempts).toFixed(4)) : 1,
      refreshAttempts,
      invalidGrantCount: refreshInvalidGrant,
      lockWaitP95Ms: refreshLockLatency.p95,
      lastRefreshAt: tokenRow?.updatedAt ?? null,
    },
    apiHealth: {
      successRate: apiTotal > 0 ? Number((apiSuccess / apiTotal).toFixed(4)) : 1,
      latencyMs: apiLatency,
      errorBreakdown,
      upstream5xx: api5xx,
    },
    rateLimits: {
      count429: counterTotal("spotify_api_requests_total", { status_code: "429" }) || 0,
      backoffState: rateLimitSnapshot.backoffState,
      backoffRemainingMs: rateLimitSnapshot.backoffRemainingMs,
      backoffUntilTs: rateLimitSnapshot.backoffUntilTs,
      lastRetryAfterMs: rateLimitSnapshot.lastRetryAfterMs,
      lastTriggeredAt: rateLimitSnapshot.lastTriggeredAt,
      retryAfterObservationsSec: rateLimitSnapshot.retryAfterObservationsSec,
    },
    traffic: {
      requestsPerMin: apiTotal,
      topEndpoints: topCounterByLabel("spotify_api_requests_total", "endpoint", 8).map(
        (row) => ({
          endpoint: row.label,
          rpm: row.value,
        })
      ),
      activeUsers: null,
    },
    callbackHealth: {
      enabled: false,
      latencyP95Ms: null,
      failures: 0,
    },
    recentErrors: errors,
    incidents: {
      active: incidents,
      runbookUrl: "/status#runbook",
    },
  });
}
