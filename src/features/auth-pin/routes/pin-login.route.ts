import { NextResponse } from "next/server";
import {
  getRequestIp,
  rateLimitResponse,
  requireSameOrigin,
} from "@/lib/api/guards";
import { pinLockRepository } from "@/src/features/auth-pin/data/pin-lock.repository";
import { runPinLoginAction } from "@/src/features/auth-pin/actions/pin-login.action";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const originCheck = requireSameOrigin(req);
  if (originCheck) return originCheck;

  const ipKey = getRequestIp(req);
  const rateLimitResult = await rateLimitResponse({
    key: `pin-login:${ipKey}`,
    limit: 20,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rateLimitResult) return rateLimitResult;

  const body = await req.json().catch(() => ({}));

  const result = await runPinLoginAction({
    body,
    ipKey,
    userAgent: req.headers.get("user-agent") || "",
    pinLockRepository,
  });

  if (result.status !== 200) {
    return NextResponse.json(result.body, {
      status: result.status,
      headers:
        result.status === 429 && "retryAfterSec" in result
          ? {
              "Retry-After": String(result.retryAfterSec),
            }
          : undefined,
    });
  }

  const response = NextResponse.json(result.body, { status: result.status });
  response.cookies.set(result.cookie.name, result.cookie.value, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: result.cookie.maxAgeSec,
  });

  return response;
}
