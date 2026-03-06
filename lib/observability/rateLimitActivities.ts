type RateLimitActivitySource = "spotify_http_429" | "spotify_local_limiter";

export type RateLimitActivityEntry = {
  at: number;
  activity: string;
  source: RateLimitActivitySource;
  endpointGroup: string;
  endpointPath: string;
  method: string;
  statusCode: number;
  retryAfterMs: number | null;
  correlationId: string;
  attempt: number | null;
};

type TopEntry = {
  label: string;
  count: number;
};

const MAX_ENTRIES = Number(
  process.env.RATE_LIMIT_ACTIVITY_LOG_MAX_ENTRIES || "2000"
);
const RETENTION_MS = Number(
  process.env.RATE_LIMIT_ACTIVITY_LOG_RETENTION_MS || "86400000"
);
const PRUNE_INTERVAL_MS = 5000;

const entries: RateLimitActivityEntry[] = [];
let lastPruneAt = 0;

function normalizeWindowMs(windowMs: number): number {
  if (!Number.isFinite(windowMs)) return 600000;
  return Math.max(1000, Math.min(RETENTION_MS, Math.floor(windowMs)));
}

function normalizeText(value: string | null | undefined, fallback: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 96);
  return normalized || fallback;
}

function prune(now = Date.now()): void {
  if (
    now - lastPruneAt < PRUNE_INTERVAL_MS &&
    entries.length <= MAX_ENTRIES
  ) {
    return;
  }
  lastPruneAt = now;
  const cutoff = now - RETENTION_MS;
  let dropCount = 0;
  while (dropCount < entries.length && entries[dropCount].at < cutoff) {
    dropCount += 1;
  }
  if (dropCount > 0) {
    entries.splice(0, dropCount);
  }
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
}

export function recordRateLimitActivity(input: {
  activity: string;
  source: RateLimitActivitySource;
  endpointGroup: string;
  endpointPath: string;
  method: string;
  statusCode?: number;
  retryAfterMs?: number | null;
  correlationId?: string | null;
  attempt?: number | null;
  at?: number;
}): void {
  const at = typeof input.at === "number" ? input.at : Date.now();
  entries.push({
    at,
    activity: normalizeText(input.activity, "unknown_activity"),
    source: input.source,
    endpointGroup: normalizeText(input.endpointGroup, "unknown_endpoint"),
    endpointPath: normalizeText(input.endpointPath, "unknown_path"),
    method: normalizeText(input.method, "GET").toUpperCase(),
    statusCode:
      typeof input.statusCode === "number" && Number.isFinite(input.statusCode)
        ? Math.floor(input.statusCode)
        : 429,
    retryAfterMs:
      typeof input.retryAfterMs === "number" && Number.isFinite(input.retryAfterMs)
        ? Math.max(0, Math.floor(input.retryAfterMs))
        : null,
    correlationId: normalizeText(input.correlationId, "n/a"),
    attempt:
      typeof input.attempt === "number" && Number.isFinite(input.attempt)
        ? Math.max(1, Math.floor(input.attempt))
        : null,
  });
  prune(at);
}

export function getRecentRateLimitActivities(
  limit = 50,
  windowMs = 600000,
  now = Date.now()
): RateLimitActivityEntry[] {
  prune(now);
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const cutoff = now - normalizeWindowMs(windowMs);
  const recent: RateLimitActivityEntry[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.at < cutoff) break;
    recent.push(entry);
    if (recent.length >= safeLimit) break;
  }
  return recent;
}

function topFromMap(
  map: Map<string, number>,
  limit: number
): TopEntry[] {
  return Array.from(map.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function getRateLimitActivitySummary(
  windowMs = 600000,
  limit = 8,
  now = Date.now()
): {
  total: number;
  byActivity: TopEntry[];
  byEndpointPath: TopEntry[];
  bySource: TopEntry[];
} {
  prune(now);
  const safeLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  const cutoff = now - normalizeWindowMs(windowMs);
  const byActivity = new Map<string, number>();
  const byEndpointPath = new Map<string, number>();
  const bySource = new Map<string, number>();
  let total = 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.at < cutoff) break;
    total += 1;
    byActivity.set(entry.activity, (byActivity.get(entry.activity) || 0) + 1);
    byEndpointPath.set(
      entry.endpointPath,
      (byEndpointPath.get(entry.endpointPath) || 0) + 1
    );
    bySource.set(entry.source, (bySource.get(entry.source) || 0) + 1);
  }

  return {
    total,
    byActivity: topFromMap(byActivity, safeLimit),
    byEndpointPath: topFromMap(byEndpointPath, safeLimit),
    bySource: topFromMap(bySource, safeLimit),
  };
}

export function clearRateLimitActivityLog(): void {
  entries.length = 0;
}
