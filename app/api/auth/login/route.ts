import { NextResponse } from "next/server";
import { getBaseUrl } from "@/lib/env";
import { addAuthLog, startAuthLog } from "@/lib/auth/authLog";

export function GET(req: Request) {
  const baseUrl = getBaseUrl() || new URL(req.url).origin;
  const callbackUrl = `${baseUrl}/`;
  startAuthLog("login", { baseUrl, callbackUrl });
  const signinUrl = new URL("/api/auth/signin/spotify", baseUrl);
  signinUrl.searchParams.set("callbackUrl", callbackUrl);
  addAuthLog("info", "Redirecting to NextAuth signin", {
    redirectTo: signinUrl.toString(),
  });
  return NextResponse.redirect(signinUrl.toString());
}
