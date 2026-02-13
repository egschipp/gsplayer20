import NextAuth from "next-auth";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getAuthOptions } from "@/lib/auth/options";
import {
  cookieFlags,
  cookieHashes,
  cookieKeys,
  isAuthLogActive,
  isAuthLogEnabled,
  logAuthEvent,
  redactHeaders,
  startAuthLog,
} from "@/lib/auth/authLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authHandler(req: NextRequest) {
  if (!process.env.NEXTAUTH_URL) {
    process.env.NEXTAUTH_URL =
      process.env.AUTH_URL || new URL(req.url).origin;
  }
  const missing: string[] = [];
  if (!process.env.SPOTIFY_CLIENT_ID) missing.push("SPOTIFY_CLIENT_ID");
  if (!process.env.SPOTIFY_CLIENT_SECRET) missing.push("SPOTIFY_CLIENT_SECRET");
  if (!process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET) {
    missing.push("AUTH_SECRET|NEXTAUTH_SECRET");
  }
  if (missing.length) {
    const message = `AUTH_MISCONFIGURED: ${missing.join(", ")}`;
    if (isAuthLogEnabled()) {
      logAuthEvent({
        level: "error",
        event: "nextauth_env_missing",
        route: "/api/auth/[...nextauth]",
        method: req.method,
        url: req.nextUrl.toString(),
        data: { missing },
      });
    }
    return NextResponse.json({ error: message }, { status: 503 });
  }
  const handler = NextAuth(getAuthOptions());
  if (isAuthLogEnabled()) {
    const url = req.nextUrl.toString();
    const isLoginRelated =
      url.includes("/signin") || url.includes("/callback") || url.includes("/error");
    if (isLoginRelated && !isAuthLogActive()) {
      startAuthLog("nextauth_request", { url });
    }
    const headers = new Headers(req.headers);
    const error = req.nextUrl.searchParams.get("error") ?? undefined;
    logAuthEvent({
      level: error ? "error" : "info",
      event: error ? "nextauth_callback_error" : "nextauth_request",
      route: "/api/auth/[...nextauth]",
      method: req.method,
      url,
      errorCode: error,
      data: {
        query: Object.fromEntries(req.nextUrl.searchParams.entries()),
        headers: redactHeaders(headers),
        cookieKeys: cookieKeys(headers),
        cookieFlags: cookieFlags(headers),
        cookieHashes: cookieHashes(headers),
      },
    });
  }
  try {
    return handler(req as any);
  } catch (error) {
    if (isAuthLogEnabled()) {
      logAuthEvent({
        level: "error",
        event: "nextauth_handler_error",
        route: "/api/auth/[...nextauth]",
        method: req.method,
        url: req.nextUrl.toString(),
        data: { message: (error as Error)?.message ?? "Unknown error" },
      });
    }
    return NextResponse.json(
      { error: "NEXTAUTH_HANDLER_FAILED" },
      { status: 500 }
    );
  }
}

export { authHandler as GET, authHandler as POST };
