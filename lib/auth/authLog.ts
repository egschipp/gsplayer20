import crypto from "crypto";
import fs from "fs";
import path from "path";

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
  active: boolean;
  entries: AuthLogEntry[];
};

const authLogState: AuthLogState = {
  runId: null,
  startedAt: null,
  active: false,
  entries: [],
};

const SENSITIVE_KEYS =
  /code|token|secret|verifier|authorization|cookie|set-cookie/i;
const MASK_KEYS = /state|code_challenge/i;
const COOKIE_ALLOW_KEYS = new Set(["cookieKeys", "cookieFlags"]);
const LOG_PATH =
  process.env.AUTH_LOG_PATH || path.join(process.cwd(), ".auth-login.log");
const AUTH_LOG_ENABLED = process.env.AUTH_LOG_ENABLED === "true";

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
    if (COOKIE_ALLOW_KEYS.has(key)) {
      next[key] = val;
      continue;
    }
    if (MASK_KEYS.test(key) && typeof val === "string") {
      next[key] = maskValue(val);
      continue;
    }
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

export function cookieFlags(headers: Headers) {
  const keys = cookieKeys(headers);
  const hasState = keys.some((key) => key.includes("state"));
  const hasPkce = keys.some((key) => key.includes("pkce"));
  const hasCallback = keys.some((key) => key.includes("callback"));
  return {
    hasState,
    hasPkce,
    hasCallback,
    total: keys.length,
  };
}

export function cookieHashes(headers: Headers) {
  const raw = headers.get("cookie") ?? "";
  const pairs = raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq === -1) return [part, ""];
      return [part.slice(0, eq), part.slice(eq + 1)];
    });
  const map = new Map(pairs as [string, string][]);
  const state = map.get("__Secure-next-auth.state");
  const pkce = map.get("__Secure-next-auth.pkce.code_verifier");
  return {
    state: state ? maskValue(state) : undefined,
    pkce: pkce ? maskValue(pkce) : undefined,
  };
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
  try {
    fs.appendFileSync(LOG_PATH, line, "utf8");
  } catch {
    // ignore file write issues
  }
}

export function startAuthLog(reason: string, data?: Record<string, unknown>) {
  if (!AUTH_LOG_ENABLED) {
    return null;
  }
  authLogState.runId = crypto.randomUUID();
  authLogState.startedAt = Date.now();
  authLogState.active = true;
  authLogState.entries = [];
  try {
    fs.writeFileSync(LOG_PATH, "", "utf8");
  } catch {
    // ignore file reset issues
  }
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
  if (!AUTH_LOG_ENABLED) {
    return;
  }
  if (!authLogState.active && entry.event !== "login_start") {
    return;
  }
  const payload: AuthLogEntry = {
    ...entry,
    runId: entry.runId ?? authLogState.runId ?? undefined,
    timestamp: new Date().toISOString(),
    data: entry.data ? (sanitize(entry.data) as Record<string, unknown>) : undefined,
  };
  authLogState.entries.push(payload);
  flush(payload);
}

export function endAuthLog(reason?: string) {
  if (!authLogState.active) return;
  logAuthEvent({
    level: "info",
    event: "login_end",
    data: reason ? { reason } : undefined,
  });
  authLogState.active = false;
}

export function getAuthLog() {
  try {
    if (fs.existsSync(LOG_PATH)) {
      const raw = fs.readFileSync(LOG_PATH, "utf8");
      const entries = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)) as AuthLogEntry[];
      const startedAt = entries[0]?.timestamp
        ? new Date(entries[0].timestamp).getTime()
        : authLogState.startedAt;
      const runId = entries[0]?.runId ?? authLogState.runId;
      return { runId, startedAt, entries };
    }
  } catch {
    // fall back to memory
  }
  return {
    runId: authLogState.runId,
    startedAt: authLogState.startedAt,
    entries: [...authLogState.entries],
  };
}

export function clearAuthLog() {
  authLogState.runId = null;
  authLogState.startedAt = null;
  authLogState.active = false;
  authLogState.entries = [];
  try {
    fs.writeFileSync(LOG_PATH, "", "utf8");
  } catch {
    // ignore
  }
}

export function isAuthLogActive() {
  return authLogState.active;
}

export function isAuthLogEnabled() {
  return AUTH_LOG_ENABLED;
}
