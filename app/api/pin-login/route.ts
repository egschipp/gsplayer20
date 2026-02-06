import { NextResponse } from "next/server";
import crypto from "crypto";
import { getRequestIp, rateLimitResponse, requireSameOrigin } from "@/lib/api/guards";
import { clearPinLock, getPinLock, recordPinFailure } from "@/lib/auth/pinLock";

export const runtime = "nodejs";

const COOKIE_NAME = "gs_pin";
const MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days

function base64Url(input: Buffer) {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sha256(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function sign(payload: string, secret: string) {
  const sig = crypto.createHmac("sha256", secret).update(payload).digest();
  return base64Url(sig);
}

export async function POST(req: Request) {
  const originCheck = requireSameOrigin(req);
  if (originCheck) return originCheck;

  const ip = getRequestIp(req);
  const rl = await rateLimitResponse({
    key: `pin-login:${ip}`,
    limit: 20,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rl) return rl;

  const lock = getPinLock(ip);
  if (lock.locked) {
    return NextResponse.json(
      { error: "PIN_LOCKED", retryAfter: lock.retryAfterSec },
      { status: 429, headers: { "Retry-After": String(lock.retryAfterSec) } }
    );
  }

  const body = await req.json().catch(() => ({}));
  const pin = String(body?.pin ?? "");
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  const expected = process.env.APP_PIN || process.env.PIN_CODE;

  if (!secret || !expected) {
    return NextResponse.json({ error: "MISCONFIGURED" }, { status: 500 });
  }

  if (!pin || pin !== expected) {
    recordPinFailure(ip);
    return NextResponse.json({ error: "INVALID_PIN" }, { status: 401 });
  }

  clearPinLock(ip);
  const ua = req.headers.get("user-agent") || "";
  const payload = JSON.stringify({
    iat: Date.now(),
    ua: sha256(ua),
  });
  const token = `${base64Url(Buffer.from(payload, "utf8"))}.${sign(
    payload,
    secret
  )}`;

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SEC,
  });
  return res;
}
