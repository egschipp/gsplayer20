type RateLimitActivitySource = "spotify_http_429" | "spotify_local_limiter";
type RateLimitImpactLevel = "low" | "medium" | "high";

export type RateLimitActivityEntry = {
  at: number;
  activity: string;
  source: RateLimitActivitySource;
  endpointGroup: string;
  endpointPath: string;
  method: string;
  priority: "foreground" | "default" | "background";
  statusCode: number;
  retryAfterMs: number | null;
  correlationId: string;
  attempt: number | null;
  impact: {
    reliability: RateLimitImpactLevel;
    responsiveness: RateLimitImpactLevel;
    reasons: string[];
  };
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

function rankImpact(level: RateLimitImpactLevel): number {
  if (level === "high") return 3;
  if (level === "medium") return 2;
  return 1;
}

function deriveImpact(input: {
  activity: string;
  endpointGroup: string;
  method: string;
  retryAfterMs: number | null;
  priority: "foreground" | "default" | "background";
  source: RateLimitActivitySource;
}): RateLimitActivityEntry["impact"] {
  const reasons = new Set<string>();
  const normalizedMethod = input.method.toUpperCase();
  const isMutation = normalizedMethod !== "GET";
  const isPlayerCritical =
    input.endpointGroup.startsWith("me_player") || input.activity.includes("player");
  const isLibraryMutation =
    isMutation &&
    (input.endpointGroup === "me_tracks" || input.endpointGroup === "playlists_items");
  const retryAfterMs = input.retryAfterMs ?? 0;

  let reliability: RateLimitImpactLevel = "low";
  let responsiveness: RateLimitImpactLevel = "low";

  if (isMutation || isPlayerCritical || retryAfterMs >= 4000) {
    reliability = "high";
  } else if (
    input.priority !== "background" ||
    input.source === "spotify_local_limiter" ||
    retryAfterMs >= 2000
  ) {
    reliability = "medium";
  }

  if (input.priority === "foreground" || isPlayerCritical || retryAfterMs >= 4000) {
    responsiveness = "high";
  } else if (input.priority === "default" || retryAfterMs >= 2000) {
    responsiveness = "medium";
  }

  if (isMutation) reasons.add("write_flow_blocked");
  if (isPlayerCritical) reasons.add("player_controls_delayed");
  if (isLibraryMutation) reasons.add("library_sync_delayed");
  if (retryAfterMs >= 4000) reasons.add("long_backoff");
  else if (retryAfterMs >= 2000) reasons.add("visible_backoff");
  if (input.source === "spotify_local_limiter") reasons.add("local_guard_triggered");
  if (input.priority === "foreground") reasons.add("interactive_request");

  return {
    reliability,
    responsiveness,
    reasons: Array.from(reasons),
  };
}

export function recordRateLimitActivity(input: {
  activity: string;
  source: RateLimitActivitySource;
  endpointGroup: string;
  endpointPath: string;
  method: string;
  priority?: "foreground" | "default" | "background";
  statusCode?: number;
  retryAfterMs?: number | null;
  correlationId?: string | null;
  attempt?: number | null;
  at?: number;
}): void {
  const at = typeof input.at === "number" ? input.at : Date.now();
  const priority = input.priority ?? "default";
  const impact = deriveImpact({
    activity: input.activity,
    endpointGroup: input.endpointGroup,
    method: input.method,
    retryAfterMs:
      typeof input.retryAfterMs === "number" && Number.isFinite(input.retryAfterMs)
        ? Math.max(0, Math.floor(input.retryAfterMs))
        : null,
    priority,
    source: input.source,
  });
  entries.push({
    at,
    activity: normalizeText(input.activity, "unknown_activity"),
    source: input.source,
    endpointGroup: normalizeText(input.endpointGroup, "unknown_endpoint"),
    endpointPath: normalizeText(input.endpointPath, "unknown_path"),
    method: normalizeText(input.method, "GET").toUpperCase(),
    priority,
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
    impact,
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
  negativeReliabilityActivities: TopEntry[];
  negativeResponsivenessActivities: TopEntry[];
} {
  prune(now);
  const safeLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  const cutoff = now - normalizeWindowMs(windowMs);
  const byActivity = new Map<string, number>();
  const byEndpointPath = new Map<string, number>();
  const bySource = new Map<string, number>();
  const byReliabilityActivity = new Map<string, number>();
  const byResponsivenessActivity = new Map<string, number>();
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
    if (rankImpact(entry.impact.reliability) >= 2) {
      byReliabilityActivity.set(
        entry.activity,
        (byReliabilityActivity.get(entry.activity) || 0) + 1
      );
    }
    if (rankImpact(entry.impact.responsiveness) >= 2) {
      byResponsivenessActivity.set(
        entry.activity,
        (byResponsivenessActivity.get(entry.activity) || 0) + 1
      );
    }
  }

  return {
    total,
    byActivity: topFromMap(byActivity, safeLimit),
    byEndpointPath: topFromMap(byEndpointPath, safeLimit),
    bySource: topFromMap(bySource, safeLimit),
    negativeReliabilityActivities: topFromMap(byReliabilityActivity, safeLimit),
    negativeResponsivenessActivities: topFromMap(byResponsivenessActivity, safeLimit),
  };
}

export function clearRateLimitActivityLog(): void {
  entries.length = 0;
}
