import { NextResponse } from "next/server";
import { getBaseUrl } from "@/lib/env";
import { addAuthLog } from "@/lib/auth/authLog";

export function GET(req: Request) {
  const baseUrl = getBaseUrl() || new URL(req.url).origin;
  const signoutUrl = new URL("/api/auth/signout", baseUrl);
  addAuthLog("info", "Redirecting to NextAuth signout", {
    redirectTo: signoutUrl.toString(),
  });
  return NextResponse.redirect(signoutUrl.toString());
}
