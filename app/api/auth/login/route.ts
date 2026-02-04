import crypto from "crypto";
import { NextResponse } from "next/server";
import { getBaseUrl } from "@/lib/env";
import { cookieKeys, logAuthEvent, redactHeaders, redactQuery, startAuthLog } from "@/lib/auth/authLog";

export function GET(req: Request) {
  const baseUrl = getBaseUrl() || new URL(req.url).origin;
  const callbackUrl = `${baseUrl}/`;
  const requestId = crypto.randomUUID();
  const runId = startAuthLog("login", { baseUrl, callbackUrl });
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  logAuthEvent({
    level: "info",
    event: "login_request",
    runId,
    requestId,
    route: "/api/auth/login",
    method: "GET",
    url: req.url,
    data: {
      query: redactQuery(url.searchParams),
      headers: redactHeaders(headers),
      cookieKeys: cookieKeys(headers),
    },
  });
  const signinUrl = new URL("/api/auth/signin/spotify", baseUrl);
  signinUrl.searchParams.set("callbackUrl", callbackUrl);
  logAuthEvent({
    level: "info",
    event: "login_redirect",
    runId,
    requestId,
    spotifyEndpoint: "https://accounts.spotify.com/authorize",
    data: { redirectTo: signinUrl.toString() },
  });
  return NextResponse.redirect(signinUrl.toString());
}
