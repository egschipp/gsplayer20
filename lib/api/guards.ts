import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { rateLimit } from "@/lib/rate-limit/ratelimit";
import {
  createCorrelationId,
  readCorrelationId,
} from "@/lib/observability/correlation";

export function jsonError(
  error: string,
  status: number,
  extra?: Record<string, unknown>
) {
  return NextResponse.json({ error, ...(extra ?? {}) }, { status });
}

export async function requireAppUser() {
  const session = await getServerSession(getAuthOptions());
  if (!session?.appUserId) {
    return { session: null, response: jsonError("UNAUTHENTICATED", 401) };
  }
  return { session, response: null };
}

function normalizeIp(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 128);
}

export function getRequestIp(req: Request) {
  const trustProxy = process.env.TRUST_PROXY === "true";
  if (!trustProxy) return "direct";

  const forwarded = req.headers.get("x-forwarded-for");
  const forwardedIp = normalizeIp(forwarded?.split(",")[0]);
  if (forwardedIp) return forwardedIp;

  const realIp = normalizeIp(req.headers.get("x-real-ip"));
  if (realIp) return realIp;

  return "unknown";
}

export function getCorrelationId(req: Request) {
  return readCorrelationId(req.headers) || createCorrelationId();
}

export async function rateLimitResponse(options: {
  key: string;
  limit: number;
  windowMs: number;
  body?: Record<string, unknown>;
  status?: number;
  includeRetryAfter?: boolean;
}) {
  const rl = await rateLimit(options.key, options.limit, options.windowMs);
  if (rl.allowed) return null;
  const retryAfter = Math.max(Math.ceil((rl.resetAt - Date.now()) / 1000), 1);
  const headers = options.includeRetryAfter
    ? { "Retry-After": String(retryAfter) }
    : undefined;
  const body =
    options.body ?? (options.includeRetryAfter ? { error: "RATE_LIMIT", retryAfter } : { error: "RATE_LIMIT" });
  return NextResponse.json(body, {
    status: options.status ?? 429,
    headers,
  });
}

export function jsonNoStore(
  body: Record<string, unknown> | unknown,
  status = 200,
  headers?: Record<string, string>
) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...(headers ?? {}) },
  });
}

export function jsonPrivateCache(
  body: Record<string, unknown> | unknown,
  status = 200,
  maxAgeSeconds = 30
) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": `private, max-age=${maxAgeSeconds}, must-revalidate`,
    },
  });
}

export function requireSameOrigin(req: Request) {
  const baseUrl = process.env.NEXTAUTH_URL || process.env.AUTH_URL;
  const expectedOrigin = baseUrl
    ? new URL(baseUrl).origin
    : new URL(req.url).origin;
  const origin = req.headers.get("origin") || req.headers.get("referer");
  const method = req.method.toUpperCase();
  const strictMethod =
    method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  if (!origin) {
    if (strictMethod) {
      return jsonError("MISSING_ORIGIN", 403);
    }
    return null;
  }
  try {
    const originUrl = new URL(origin);
    const expectedHost = new URL(expectedOrigin).host.replace(/^www\./, "");
    const originHost = originUrl.host.replace(/^www\./, "");
    const requestHost = new URL(req.url).host.replace(/^www\./, "");
    if (originHost === expectedHost || originHost === requestHost) return null;
  } catch {
    // fall through
  }
  return jsonError("INVALID_ORIGIN", 403);
}
