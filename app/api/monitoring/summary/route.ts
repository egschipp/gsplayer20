import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { oauthTokens } from "@/lib/db/schema";
import { jsonNoStore, requireAppUser } from "@/lib/api/guards";
import {
  counterEntriesWindow,
  counterTotalWindow,
  histogramQuantilesWindow,
  topCounterByLabelWindow,
} from "@/lib/observability/metrics";
import { getRecentErrors } from "@/lib/observability/logger";
import { getSpotifyRateLimitSnapshot } from "@/lib/observability/rateLimit";
import { getSpotifyCentralRateLimitSnapshot } from "@/lib/spotify/centralRateLimiter";
import { getAppAccessToken, getAppTokenStatus } from "@/lib/spotify/tokens";

export const runtime = "nodejs";

const METRICS_WINDOW_MS = Number(process.env.MONITORING_METRICS_WINDOW_MS || "600000");

function normalizeMetricsWindowMs() {
  if (!Number.isFinite(METRICS_WINDOW_MS)) return 600000;
  return Math.max(60000, Math.min(3600000, Math.floor(METRICS_WINDOW_MS)));
}

export async function GET() {
  const { session, response } = await requireAppUser();
  if (response) return response;

  const db = getDb();
  const now = Date.now();
  const metricsWindowMs = normalizeMetricsWindowMs();
  const metricsWindowSec = Math.floor(metricsWindowMs / 1000);
  let appTokenFetchError: string | null = null;
  try {
    await getAppAccessToken();
  } catch (error) {
    appTokenFetchError = String(error).slice(0, 256);
  }
  const appTokenStatus = getAppTokenStatus(now);

  const tokenRow = await db
    .select({
      scope: oauthTokens.scope,
      accessExpiresAt: oauthTokens.accessExpiresAt,
      updatedAt: oauthTokens.updatedAt,
    })
    .from(oauthTokens)
    .where(eq(oauthTokens.userId, session.appUserId as string))
    .get();

  const refreshSuccess = counterTotalWindow(
    "spotify_token_refresh_total",
    {
      outcome: "success",
    },
    metricsWindowMs,
    now
  );
  const refreshInvalidGrant = counterTotalWindow(
    "spotify_token_refresh_total",
    {
      outcome: "invalid_grant",
    },
    metricsWindowMs,
    now
  );
  const refreshFailed = counterTotalWindow(
    "spotify_token_refresh_total",
    {
      outcome: "refresh_failed",
    },
    metricsWindowMs,
    now
  );
  const refreshLockTimeout = counterTotalWindow(
    "spotify_token_refresh_total",
    {
      outcome: "lock_timeout",
    },
    metricsWindowMs,
    now
  );
  const refreshAttempts =
    refreshSuccess + refreshInvalidGrant + refreshFailed + refreshLockTimeout;

  const requestCounters = counterEntriesWindow(
    "spotify_api_requests_total",
    {},
    metricsWindowMs,
    now
  );
  let apiSuccess = 0;
  let api4xx = 0;
  let api5xx = 0;
  const errorBreakdownMap = new Map<string, number>();
  let count429 = 0;

  for (const row of requestCounters) {
    const statusClass = String(row.labels.status_class || "").toLowerCase();
    const endpoint = String(row.labels.endpoint || "unknown").trim() || "unknown";
    const statusCode = String(row.labels.status_code || "").trim();
    const isExpectedPlayer404 =
      statusCode === "404" &&
      (endpoint === "me_player" || endpoint === "me_player_devices");

    if (statusCode === "429") {
      count429 += row.value;
    }

    if (statusClass === "2xx" || isExpectedPlayer404) {
      apiSuccess += row.value;
      continue;
    }
    if (statusClass === "4xx") {
      api4xx += row.value;
      errorBreakdownMap.set(endpoint, (errorBreakdownMap.get(endpoint) || 0) + row.value);
      continue;
    }
    if (statusClass === "5xx") {
      api5xx += row.value;
      errorBreakdownMap.set(endpoint, (errorBreakdownMap.get(endpoint) || 0) + row.value);
    }
  }
  const restrictionViolatedCount = counterTotalWindow(
    "spotify_api_errors_total",
    {
      endpoint: "me_player",
      code: "RESTRICTION_VIOLATED",
    },
    metricsWindowMs,
    now
  );
  if (restrictionViolatedCount > 0 && api4xx > 0) {
    const expectedCount = Math.min(api4xx, restrictionViolatedCount);
    api4xx -= expectedCount;
    apiSuccess += expectedCount;
  }
  const apiTotal = apiSuccess + api4xx + api5xx;
  const apiLatency = histogramQuantilesWindow(
    "spotify_api_latency_ms",
    {},
    metricsWindowMs,
    now
  );
  const refreshLockLatency = histogramQuantilesWindow(
    "spotify_refresh_lock_wait_ms",
    {},
    metricsWindowMs,
    now
  );
  const rateLimitSnapshot = getSpotifyRateLimitSnapshot(now);
  const centralRateLimitSnapshot = getSpotifyCentralRateLimitSnapshot(now);

  const expiresInSec =
    typeof tokenRow?.accessExpiresAt === "number" && tokenRow.accessExpiresAt > 0
      ? Math.max(0, Math.floor((tokenRow.accessExpiresAt - now) / 1000))
      : null;
  const userTokenStatus =
    !tokenRow
      ? "MISSING"
      : expiresInSec == null
      ? "MISSING_ACCESS"
      : expiresInSec <= 0
      ? "EXPIRED"
      : expiresInSec <= 120
      ? "EXPIRING"
      : refreshInvalidGrant > 0
      ? "REAUTH_REQUIRED"
      : "VALID";

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

  const errorBreakdown = Array.from(errorBreakdownMap.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  return jsonNoStore({
    generatedAt: now,
    meta: {
      environment: process.env.NODE_ENV || "unknown",
      metricsWindowSec,
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
      status: userTokenStatus,
      expiresInSec,
      refreshSuccessRate:
        refreshAttempts > 0 ? Number((refreshSuccess / refreshAttempts).toFixed(4)) : 1,
      refreshAttempts,
      refreshSuccessCount: refreshSuccess,
      refreshFailureCount: refreshInvalidGrant + refreshFailed + refreshLockTimeout,
      invalidGrantCount: refreshInvalidGrant,
      lockWaitP95Ms: refreshLockLatency.p95,
      lastRefreshAt: tokenRow?.updatedAt ?? null,
    },
    appTokenHealth: {
      status: appTokenStatus.status,
      expiresInSec: appTokenStatus.expiresInSec,
      expiresAt: appTokenStatus.expiresAt,
      refreshSuccessCount: appTokenStatus.refreshSuccessCount,
      refreshFailureCount: appTokenStatus.refreshFailureCount,
      lastRefreshAt: appTokenStatus.lastRefreshAt,
      lastAttemptAt: appTokenStatus.lastAttemptAt,
      lastError: appTokenFetchError ?? appTokenStatus.lastError,
    },
    apiHealth: {
      successRate: apiTotal > 0 ? Number((apiSuccess / apiTotal).toFixed(4)) : 1,
      sampleCount: apiTotal,
      restrictionViolatedCount,
      latencyMs: apiLatency,
      errorBreakdown,
      upstream5xx: api5xx,
    },
    rateLimits: {
      count429: count429 || 0,
      sampleWindowSec: metricsWindowSec,
      backoffState: rateLimitSnapshot.backoffState,
      backoffRemainingMs: rateLimitSnapshot.backoffRemainingMs,
      backoffUntilTs: rateLimitSnapshot.backoffUntilTs,
      lastRetryAfterMs: rateLimitSnapshot.lastRetryAfterMs,
      lastTriggeredAt: rateLimitSnapshot.lastTriggeredAt,
      retryAfterObservationsSec: rateLimitSnapshot.retryAfterObservationsSec,
      central: centralRateLimitSnapshot,
    },
    traffic: {
      requestsPerMin:
        apiTotal > 0
          ? Number((apiTotal / Math.max(1, metricsWindowMs / 60000)).toFixed(1))
          : 0,
      requestsInWindow: apiTotal,
      topEndpoints: topCounterByLabelWindow(
        "spotify_api_requests_total",
        "endpoint",
        8,
        metricsWindowMs,
        now
      ).map(
        (row) => ({
          endpoint: row.label,
          rpm: Number(
            (
              row.value / Math.max(1, metricsWindowMs / 60000)
            ).toFixed(1)
          ),
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
