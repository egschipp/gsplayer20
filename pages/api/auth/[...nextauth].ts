import type { NextApiRequest, NextApiResponse } from "next";
import NextAuth from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { cookieKeys, logAuthEvent, redactHeaders } from "@/lib/auth/authLog";

export default async function authHandler(req: NextApiRequest, res: NextApiResponse) {
  const url = req.url ?? "";
  if (url.startsWith("/api/auth/")) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
    }
    const query = req.query ?? {};
    const error = typeof query.error === "string" ? query.error : undefined;

    logAuthEvent({
      level: error ? "error" : "info",
      event: error ? "nextauth_callback_error" : "nextauth_request",
      route: "/api/auth/[...nextauth]",
      method: req.method,
      url,
      errorCode: error,
      data: {
        query,
        headers: redactHeaders(headers),
        cookieKeys: cookieKeys(headers),
      },
    });
  }
  return NextAuth(req, res, getAuthOptions());
}
