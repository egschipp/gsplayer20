import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "gs_pin";
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;

function base64UrlToBytes(input: string) {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "===".slice((base64.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64Url(bytes: ArrayBuffer) {
  const arr = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < arr.length; i += 1) {
    binary += String.fromCharCode(arr[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(input: string) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyToken(token: string, secret: string, ua: string) {
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) return false;
  const payloadBytes = base64UrlToBytes(payloadB64);
  const payload = new TextDecoder().decode(payloadBytes);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, payloadBytes);
  const expectedSig = bytesToBase64Url(sig);
  if (expectedSig !== sigB64) return false;

  try {
    const data = JSON.parse(payload) as { iat: number; ua: string };
    if (!data?.iat || !data?.ua) return false;
    if (Date.now() - data.iat > MAX_AGE_MS) return false;
    const uaHash = await sha256Hex(ua);
    return uaHash === data.ua;
  } catch {
    return false;
  }
}

function isPublicPath(pathname: string) {
  if (
    pathname === "/login" ||
    pathname.startsWith("/api/pin-login") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/icon-") ||
    pathname.startsWith("/apple-touch-icon") ||
    pathname.startsWith("/site.webmanifest")
  ) {
    return true;
  }
  return false;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  const expectedPin = process.env.APP_PIN || process.env.PIN_CODE;
  if (!secret || !expectedPin) {
    return NextResponse.next();
  }

  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (token) {
    const ok = await verifyToken(
      token,
      secret,
      req.headers.get("user-agent") || ""
    );
    if (ok) return NextResponse.next();
  }

  if (pathname.startsWith("/api")) {
    return NextResponse.json({ error: "PIN_REQUIRED" }, { status: 401 });
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
