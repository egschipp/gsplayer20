import crypto from "crypto";
import { NextResponse } from "next/server";
import { getBaseUrl } from "@/lib/env";
import { cookieKeys, logAuthEvent, redactHeaders, redactQuery } from "@/lib/auth/authLog";

export function GET(req: Request) {
  const baseUrl = getBaseUrl() || new URL(req.url).origin;
  const requestId = crypto.randomUUID();
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  logAuthEvent({
    level: "info",
    event: "logout_request",
    requestId,
    route: "/api/auth/logout",
    method: "GET",
    url: req.url,
    data: {
      query: redactQuery(url.searchParams),
      headers: redactHeaders(headers),
      cookieKeys: cookieKeys(headers),
    },
  });
  const signoutUrl = new URL("/api/auth/signout", baseUrl);
  logAuthEvent({
    level: "info",
    event: "logout_redirect",
    requestId,
    data: { redirectTo: signoutUrl.toString() },
  });
  return NextResponse.redirect(signoutUrl.toString());
}
