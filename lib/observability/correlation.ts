import crypto from "crypto";

export const CORRELATION_HEADER = "x-correlation-id";

export function createCorrelationId(): string {
  return crypto.randomUUID();
}

export function readCorrelationId(headers: Headers): string | null {
  const raw = headers.get(CORRELATION_HEADER);
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 128);
}

export function ensureCorrelationId(headers: Headers): string {
  const existing = readCorrelationId(headers);
  if (existing) return existing;
  const generated = createCorrelationId();
  headers.set(CORRELATION_HEADER, generated);
  return generated;
}

