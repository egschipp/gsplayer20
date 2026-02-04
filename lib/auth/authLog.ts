import crypto from "crypto";

export type AuthLogLevel = "debug" | "info" | "warn" | "error";

export type AuthLogEntry = {
  timestamp: string;
  level: AuthLogLevel;
  event: string;
  runId?: string;
  requestId?: string;
  sessionId?: string;
  route?: string;
  method?: string;
  url?: string;
  spotifyEndpoint?: string;
  status?: number;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  hints?: string[];
  data?: Record<string, unknown>;
};

type AuthLogState = {
  runId: string | null;
  startedAt: number | null;
  entries: AuthLogEntry[];
};

const authLogState: AuthLogState = {
  runId: null,
  startedAt: null,
  entries: [],
};

const SENSITIVE_KEYS = /code|token|secret|verifier|authorization|cookie|set-cookie/i;

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function maskValue(value: string) {
  const len = value.length;
  const head = value.slice(0, 4);
  const tail = value.slice(-4);
  return `${head}…${tail} (len:${len}, sha256:${sha256(value).slice(0, 12)})`;
}

function sanitize(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input)) {
    if (SENSITIVE_KEYS.test(key)) {
      next[key] = "[redacted]";
      continue;
    }
    if (typeof val === "string" && SENSITIVE_KEYS.test(key)) {
      next[key] = "[redacted]";
      continue;
    }
    next[key] = sanitize(val);
  }
  return next;
}

export function redactQuery(params: URLSearchParams) {
  const out: Record<string, unknown> = {};
  params.forEach((value, key) => {
    if (SENSITIVE_KEYS.test(key)) out[key] = "[redacted]";
    else out[key] = value;
  });
  return out;
}

export function redactHeaders(headers: Headers) {
  const out: Record<string, unknown> = {};
  headers.forEach((value, key) => {
    if (SENSITIVE_KEYS.test(key)) out[key] = "[redacted]";
    else out[key] = value;
  });
  return out;
}

export function cookieKeys(headers: Headers) {
  const cookie = headers.get("cookie");
  if (!cookie) return [];
  return cookie
    .split(";")
    .map((c) => c.split("=")[0].trim())
    .filter(Boolean);
}

export function hashSensitive(value?: string | null) {
  if (!value) return undefined;
  return maskValue(value);
}

function flush(entry: AuthLogEntry) {
  const line = JSON.stringify(entry) + "\n";
  if (!process.stdout.write(line)) {
    process.stdout.once("drain", () => void 0);
  }
}

export function startAuthLog(reason: string, data?: Record<string, unknown>) {
  authLogState.runId = crypto.randomUUID();
  authLogState.startedAt = Date.now();
  authLogState.entries = [];
  logAuthEvent({
    level: "info",
    event: "login_start",
    data: { reason, ...data },
  });
  return authLogState.runId;
}

export function logAuthEvent(entry: Omit<AuthLogEntry, "timestamp" | "runId"> & {
  runId?: string;
}) {
  const payload: AuthLogEntry = {
    ...entry,
    runId: entry.runId ?? authLogState.runId ?? undefined,
    timestamp: new Date().toISOString(),
    data: entry.data ? (sanitize(entry.data) as Record<string, unknown>) : undefined,
  };
  authLogState.entries.push(payload);
  flush(payload);
}

export function getAuthLog() {
  return {
    runId: authLogState.runId,
    startedAt: authLogState.startedAt,
    entries: [...authLogState.entries],
  };
}

export function clearAuthLog() {
  authLogState.runId = null;
  authLogState.startedAt = null;
  authLogState.entries = [];
}
