import { NextResponse } from "next/server";
import crypto from "crypto";

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
  const body = await req.json().catch(() => ({}));
  const pin = String(body?.pin ?? "");
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  const expected = process.env.APP_PIN || process.env.PIN_CODE;

  if (!secret || !expected) {
    return NextResponse.json({ error: "MISCONFIGURED" }, { status: 500 });
  }

  if (!pin || pin !== expected) {
    return NextResponse.json({ error: "INVALID_PIN" }, { status: 401 });
  }

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
