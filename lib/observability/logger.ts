import crypto from "crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogRecordInput = {
  level: LogLevel;
  event: string;
  correlationId?: string;
  route?: string;
  method?: string;
  endpointGroup?: string;
  status?: number;
  durationMs?: number;
  appUserId?: string | null;
  errorCode?: string;
  errorMessage?: string;
  data?: Record<string, unknown>;
};

export type LogRecord = LogRecordInput & {
  ts: string;
  service: string;
  env: string;
  appUserHash?: string;
};

const SENSITIVE_KEYS = /token|secret|authorization|cookie|password|refresh|access/i;
const ERROR_BUFFER_LIMIT = 200;
const errorBuffer: LogRecord[] = [];

function hashUserId(value?: string | null): string | undefined {
  if (!value) return undefined;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function redactValue(value: unknown, key = ""): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    if (SENSITIVE_KEYS.test(key)) return "[redacted]";
    if (value.length > 2000) return `${value.slice(0, 2000)}...[truncated]`;
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (SENSITIVE_KEYS.test(childKey)) {
        next[childKey] = "[redacted]";
      } else {
        next[childKey] = redactValue(childValue, childKey);
      }
    }
    return next;
  }
  return String(value);
}

export function logEvent(input: LogRecordInput): void {
  const record: LogRecord = {
    ...input,
    ts: new Date().toISOString(),
    service: "gsplayer20",
    env: process.env.NODE_ENV || "unknown",
    appUserHash: hashUserId(input.appUserId),
    data: input.data ? (redactValue(input.data) as Record<string, unknown>) : undefined,
  };

  if (record.level === "error") {
    errorBuffer.push(record);
    if (errorBuffer.length > ERROR_BUFFER_LIMIT) {
      errorBuffer.shift();
    }
  }

  process.stdout.write(`${JSON.stringify(record)}\n`);
}

export function getRecentErrors(limit = 20): LogRecord[] {
  const size = Math.max(1, Math.min(limit, ERROR_BUFFER_LIMIT));
  return errorBuffer.slice(Math.max(0, errorBuffer.length - size));
}

export function clearRecentErrors(): void {
  errorBuffer.length = 0;
}

