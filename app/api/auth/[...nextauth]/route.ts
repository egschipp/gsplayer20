import NextAuth from "next-auth";
import type { NextRequest } from "next/server";
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

const handler = NextAuth(getAuthOptions());

async function authHandler(req: NextRequest) {
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
  return handler(req as any);
}

export { authHandler as GET, authHandler as POST };
