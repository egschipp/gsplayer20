import { logEvent, type LogLevel } from "@/lib/observability/logger";

const TRACE_BUFFER_LIMIT = Number(process.env.RECOMMENDATIONS_TRACE_BUFFER_LIMIT || "1000");
const SENSITIVE_KEYS = /token|secret|authorization|cookie|password|refresh|access/i;

export type RecommendationsTraceEntry = {
  ts: string;
  level: LogLevel;
  stage: string;
  correlationId: string;
  route?: string;
  method?: string;
  playlistId?: string;
  status?: number;
  durationMs?: number;
  code?: string;
  message?: string;
  data?: Record<string, unknown>;
};

const traceBuffer: RecommendationsTraceEntry[] = [];

function safeLimit(value: number) {
  if (!Number.isFinite(value)) return 1000;
  return Math.max(200, Math.min(5000, Math.floor(value)));
}

function redactValue(value: unknown, key = ""): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    if (SENSITIVE_KEYS.test(key)) return "[redacted]";
    if (value.length > 1200) return `${value.slice(0, 1200)}...[truncated]`;
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      next[childKey] = redactValue(childValue, childKey);
    }
    return next;
  }
  return String(value);
}

export function recordRecommendationsTrace(input: Omit<RecommendationsTraceEntry, "ts">) {
  const entry: RecommendationsTraceEntry = {
    ...input,
    ts: new Date().toISOString(),
    data: input.data ? (redactValue(input.data) as Record<string, unknown>) : undefined,
  };

  traceBuffer.push(entry);
  const max = safeLimit(TRACE_BUFFER_LIMIT);
  if (traceBuffer.length > max) {
    traceBuffer.splice(0, traceBuffer.length - max);
  }

  logEvent({
    level: entry.level,
    event: "recommendations_trace",
    correlationId: entry.correlationId,
    route: entry.route,
    method: entry.method,
    status: entry.status,
    durationMs: entry.durationMs,
    errorCode: entry.code,
    errorMessage: entry.message,
    data: {
      stage: entry.stage,
      playlistId: entry.playlistId,
      ...(entry.data ?? {}),
    },
  });
}

export function createRecommendationsTraceLogger(base: {
  correlationId: string;
  route?: string;
  method?: string;
  playlistId?: string;
}) {
  return (
    stage: string,
    details?: {
      level?: LogLevel;
      status?: number;
      durationMs?: number;
      code?: string;
      message?: string;
      data?: Record<string, unknown>;
      playlistId?: string;
    }
  ) => {
    recordRecommendationsTrace({
      level: details?.level ?? "info",
      stage,
      correlationId: base.correlationId,
      route: base.route,
      method: base.method,
      playlistId: details?.playlistId ?? base.playlistId,
      status: details?.status,
      durationMs: details?.durationMs,
      code: details?.code,
      message: details?.message,
      data: details?.data,
    });
  };
}

export function getRecommendationsTraces(args?: {
  limit?: number;
  correlationId?: string | null;
  playlistId?: string | null;
}) {
  const limit = safeLimit(args?.limit ?? 200);
  const correlationId = String(args?.correlationId ?? "").trim();
  const playlistId = String(args?.playlistId ?? "").trim();
  let rows = traceBuffer;
  if (correlationId) {
    rows = rows.filter((entry) => entry.correlationId === correlationId);
  }
  if (playlistId) {
    rows = rows.filter((entry) => entry.playlistId === playlistId);
  }
  return rows.slice(Math.max(0, rows.length - limit));
}

