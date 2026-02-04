type LogLevel = "info" | "warn" | "error" | "debug";

export type AuthLogEntry = {
  ts: number;
  level: LogLevel;
  message: string;
  data?: unknown;
};

type AuthLogState = {
  runId: number;
  startedAt: number | null;
  entries: AuthLogEntry[];
};

const authLogState: AuthLogState = {
  runId: 0,
  startedAt: null,
  entries: [],
};

function redactString(value: string): string {
  if (value.startsWith("Bearer ")) return "Bearer [redacted]";
  return value;
}

function sanitize(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|authorization|refresh|access|password/i.test(key)) {
        next[key] = "[redacted]";
      } else {
        next[key] = sanitize(val);
      }
    }
    return next;
  }
  return value;
}

export function startAuthLog(reason: string, meta?: unknown) {
  authLogState.runId += 1;
  authLogState.startedAt = Date.now();
  authLogState.entries = [];
  addAuthLog("info", "Auth log started", { reason, meta });
}

export function addAuthLog(level: LogLevel, message: string, data?: unknown) {
  authLogState.entries.push({
    ts: Date.now(),
    level,
    message,
    data: sanitize(data),
  });
}

export function getAuthLog() {
  return {
    runId: authLogState.runId,
    startedAt: authLogState.startedAt,
    entries: [...authLogState.entries],
  };
}

export function clearAuthLog() {
  authLogState.runId += 1;
  authLogState.startedAt = null;
  authLogState.entries = [];
}
