type SlowImpactLevel = "low" | "medium" | "high";
type SlowPriority = "foreground" | "default" | "background";

export type SlowActivityEntry = {
  at: number;
  activity: string;
  endpointGroup: string;
  endpointPath: string;
  method: string;
  priority: SlowPriority;
  statusCode: number;
  durationMs: number;
  correlationId: string;
  impact: {
    reliability: SlowImpactLevel;
    responsiveness: SlowImpactLevel;
    reasons: string[];
  };
};

type TopEntry = {
  label: string;
  count: number;
};

const MAX_ENTRIES = Number(process.env.SLOW_ACTIVITY_LOG_MAX_ENTRIES || "2000");
const RETENTION_MS = Number(process.env.SLOW_ACTIVITY_LOG_RETENTION_MS || "86400000");
const PRUNE_INTERVAL_MS = 5000;
const FOREGROUND_THRESHOLD_MS = Number(
  process.env.SLOW_ACTIVITY_FOREGROUND_THRESHOLD_MS || "500"
);
const DEFAULT_THRESHOLD_MS = Number(
  process.env.SLOW_ACTIVITY_DEFAULT_THRESHOLD_MS || "800"
);
const BACKGROUND_THRESHOLD_MS = Number(
  process.env.SLOW_ACTIVITY_BACKGROUND_THRESHOLD_MS || "1200"
);

const entries: SlowActivityEntry[] = [];
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
  if (now - lastPruneAt < PRUNE_INTERVAL_MS && entries.length <= MAX_ENTRIES) {
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

function thresholdForPriority(priority: SlowPriority): number {
  if (priority === "foreground") return Math.max(100, FOREGROUND_THRESHOLD_MS);
  if (priority === "background") return Math.max(200, BACKGROUND_THRESHOLD_MS);
  return Math.max(150, DEFAULT_THRESHOLD_MS);
}

function rankImpact(level: SlowImpactLevel): number {
  if (level === "high") return 3;
  if (level === "medium") return 2;
  return 1;
}

function deriveImpact(input: {
  activity: string;
  endpointGroup: string;
  method: string;
  priority: SlowPriority;
  durationMs: number;
  statusCode: number;
}): SlowActivityEntry["impact"] {
  const reasons = new Set<string>();
  const normalizedMethod = input.method.toUpperCase();
  const isMutation = normalizedMethod !== "GET";
  const isPlayerCritical =
    input.endpointGroup.startsWith("me_player") || input.activity.includes("player");
  const durationMs = Math.max(0, Math.floor(input.durationMs));

  let responsiveness: SlowImpactLevel = "low";
  if (input.priority === "foreground" || isPlayerCritical || durationMs >= 1200) {
    responsiveness = "high";
  } else if (durationMs >= 700 || input.priority === "default") {
    responsiveness = "medium";
  }

  let reliability: SlowImpactLevel = "low";
  if (input.statusCode >= 500 || (isMutation && durationMs >= 1000)) {
    reliability = "high";
  } else if (isMutation || durationMs >= 1500) {
    reliability = "medium";
  }

  if (input.priority === "foreground") reasons.add("interactive_request");
  if (isPlayerCritical) reasons.add("player_controls_delayed");
  if (isMutation) reasons.add("write_flow_slow");
  if (durationMs >= 1500) reasons.add("long_wait");
  else if (durationMs >= 800) reasons.add("visible_wait");
  if (input.statusCode >= 500) reasons.add("upstream_degraded");

  return {
    reliability,
    responsiveness,
    reasons: Array.from(reasons),
  };
}

export function shouldRecordSlowActivity(input: {
  priority?: SlowPriority | null;
  durationMs: number;
}): boolean {
  const priority = input.priority ?? "default";
  const durationMs = Math.max(0, Math.floor(input.durationMs));
  return durationMs >= thresholdForPriority(priority);
}

export function recordSlowActivity(input: {
  activity: string;
  endpointGroup: string;
  endpointPath: string;
  method: string;
  priority?: SlowPriority;
  statusCode?: number;
  durationMs: number;
  correlationId?: string | null;
  at?: number;
}): void {
  const at = typeof input.at === "number" ? input.at : Date.now();
  const priority = input.priority ?? "default";
  const durationMs = Math.max(0, Math.floor(input.durationMs));
  if (!shouldRecordSlowActivity({ priority, durationMs })) {
    return;
  }
  const statusCode =
    typeof input.statusCode === "number" && Number.isFinite(input.statusCode)
      ? Math.max(0, Math.floor(input.statusCode))
      : 200;
  entries.push({
    at,
    activity: normalizeText(input.activity, "unknown_activity"),
    endpointGroup: normalizeText(input.endpointGroup, "unknown_endpoint"),
    endpointPath: normalizeText(input.endpointPath, "unknown_path"),
    method: normalizeText(input.method, "GET").toUpperCase(),
    priority,
    statusCode,
    durationMs,
    correlationId: normalizeText(input.correlationId, "n/a"),
    impact: deriveImpact({
      activity: input.activity,
      endpointGroup: input.endpointGroup,
      method: input.method,
      priority,
      durationMs,
      statusCode,
    }),
  });
  prune(at);
}

export function getRecentSlowActivities(
  limit = 50,
  windowMs = 600000,
  now = Date.now()
): SlowActivityEntry[] {
  prune(now);
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const cutoff = now - normalizeWindowMs(windowMs);
  const recent: SlowActivityEntry[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.at < cutoff) break;
    recent.push(entry);
    if (recent.length >= safeLimit) break;
  }
  return recent;
}

function topFromMap(map: Map<string, number>, limit: number): TopEntry[] {
  return Array.from(map.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function getSlowActivitySummary(
  windowMs = 600000,
  limit = 8,
  now = Date.now()
): {
  total: number;
  byActivity: TopEntry[];
  byEndpointPath: TopEntry[];
  negativeReliabilityActivities: TopEntry[];
  negativeResponsivenessActivities: TopEntry[];
} {
  prune(now);
  const safeLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  const cutoff = now - normalizeWindowMs(windowMs);
  const byActivity = new Map<string, number>();
  const byEndpointPath = new Map<string, number>();
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
    negativeReliabilityActivities: topFromMap(byReliabilityActivity, safeLimit),
    negativeResponsivenessActivities: topFromMap(byResponsivenessActivity, safeLimit),
  };
}

export function clearSlowActivityLog(): void {
  entries.splice(0, entries.length);
  lastPruneAt = 0;
}
