import { NextRequest, NextResponse } from "next/server";
import { ensureCorrelationId, CORRELATION_HEADER } from "@/lib/observability/correlation";

const COOKIE_NAME = "gs_pin";
const MAX_AGE_MS = 1000 * 60 * 60 * 12;

function createNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return bytesToBase64Url(bytes.buffer);
}

function buildContentSecurityPolicy(nonce: string) {
  const development = process.env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src 'nonce-${nonce}' 'strict-dynamic' 'self' https://sdk.scdn.co${
      development ? " 'unsafe-eval'" : ""
    }`,
    `style-src 'self' 'nonce-${nonce}'`,
    // Virtualized rows require runtime-calculated style attributes. Limit the exception
    // to attributes; injected style elements still require the per-request nonce.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob: https://i.scdn.co https://*.scdn.co",
    "font-src 'self' data:",
    "media-src 'self' https://*.scdn.co https://*.spotify.com",
    "connect-src 'self' https://api.spotify.com https://accounts.spotify.com https://api-partner.spotify.com https://*.spotify.com https://*.scdn.co wss://*.spotify.com wss://*.scdn.co",
    "worker-src 'self' blob:",
    "child-src 'self' blob: https://sdk.scdn.co https://*.scdn.co",
    "frame-src 'self' https://open.spotify.com https://*.spotify.com https://sdk.scdn.co https://*.scdn.co",
    "form-action 'self' https://accounts.spotify.com",
    "upgrade-insecure-requests",
  ].join("; ");
}

function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "===".slice((base64.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
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
    ["verify"]
  );
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64UrlToBytes(sigB64);
  } catch {
    return false;
  }
  if (!(await crypto.subtle.verify("HMAC", key, signature, payloadBytes))) return false;

  try {
    const data = JSON.parse(payload) as {
      v?: number;
      aud?: string;
      iat: number;
      exp?: number;
      ua: string;
    };
    if (!data?.iat || !data?.ua) return false;
    const now = Date.now();
    if (data.iat > now + 60_000) return false;
    if (data.exp != null && data.exp <= now) return false;
    if (data.exp == null && now - data.iat > MAX_AGE_MS) return false;
    if (data.v != null && data.v !== 1) return false;
    if (data.aud != null && data.aud !== "gsplayer-pin-session") return false;
    const uaHash = await sha256Hex(ua);
    return uaHash === data.ua;
  } catch {
    return false;
  }
}

function isPublicPath(pathname: string) {
  if (pathname === "/api/auth/log") {
    return false;
  }

  if (
    pathname === "/api/health" ||
    pathname === "/login" ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/pin-login") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/icon-") ||
    pathname.startsWith("/apple-touch-icon") ||
    pathname.startsWith("/georgies-spotify.png") ||
    pathname.startsWith("/georgies-spotify.jpg") ||
    pathname.startsWith("/site.webmanifest")
  ) {
    return true;
  }
  return false;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const requestHeaders = new Headers(req.headers);
  const correlationId = ensureCorrelationId(requestHeaders);
  const nonce = createNonce();
  const contentSecurityPolicy = buildContentSecurityPolicy(nonce);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);

  if (isPublicPath(pathname)) {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set(CORRELATION_HEADER, correlationId);
    response.headers.set("Content-Security-Policy", contentSecurityPolicy);
    return response;
  }

  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  const expectedPin = process.env.APP_PIN || process.env.PIN_CODE;
  if (!secret || !expectedPin) {
    if (pathname.startsWith("/api")) {
      const response = NextResponse.json(
        { error: "SERVICE_MISCONFIGURED" },
        { status: 503 }
      );
      response.headers.set(CORRELATION_HEADER, correlationId);
      response.headers.set("Content-Security-Policy", contentSecurityPolicy);
      return response;
    }
    const response = NextResponse.redirect(
      new URL("/login?error=misconfigured", req.url)
    );
    response.headers.set(CORRELATION_HEADER, correlationId);
    response.headers.set("Content-Security-Policy", contentSecurityPolicy);
    return response;
  }

  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (token) {
    const ok = await verifyToken(token, secret, req.headers.get("user-agent") || "");
    if (ok) {
      const response = NextResponse.next({ request: { headers: requestHeaders } });
      response.headers.set(CORRELATION_HEADER, correlationId);
      response.headers.set("Content-Security-Policy", contentSecurityPolicy);
      return response;
    }
  }

  if (pathname.startsWith("/api")) {
    const response = NextResponse.json({ error: "PIN_REQUIRED" }, { status: 401 });
    response.headers.set(CORRELATION_HEADER, correlationId);
    response.headers.set("Content-Security-Policy", contentSecurityPolicy);
    return response;
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", pathname);
  const response = NextResponse.redirect(loginUrl);
  response.headers.set(CORRELATION_HEADER, correlationId);
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
