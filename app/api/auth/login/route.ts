import { NextResponse } from "next/server";
import { getBaseUrl } from "@/lib/env";

export function GET(req: Request) {
  const baseUrl = getBaseUrl() || new URL(req.url).origin;
  const callbackUrl = `${baseUrl}/`;
  const signinUrl = new URL("/api/auth/signin/spotify", baseUrl);
  signinUrl.searchParams.set("callbackUrl", callbackUrl);
  return NextResponse.redirect(signinUrl.toString());
}
