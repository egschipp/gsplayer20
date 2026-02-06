import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { rateLimit } from "@/lib/rate-limit/ratelimit";

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

export function getRequestIp(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for");
  if (!forwarded) return "unknown";
  return forwarded.split(",")[0]?.trim() || "unknown";
}

export function rateLimitResponse(options: {
  key: string;
  limit: number;
  windowMs: number;
  body?: Record<string, unknown>;
  status?: number;
  includeRetryAfter?: boolean;
}) {
  const rl = rateLimit(options.key, options.limit, options.windowMs);
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
