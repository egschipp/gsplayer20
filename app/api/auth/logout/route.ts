import { NextResponse } from "next/server";
import { getBaseUrl } from "@/lib/env";

export function GET(req: Request) {
  const baseUrl = getBaseUrl() || new URL(req.url).origin;
  const signoutUrl = new URL("/api/auth/signout", baseUrl);
  return NextResponse.redirect(signoutUrl.toString());
}
