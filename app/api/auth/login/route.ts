import { NextResponse } from "next/server";
import { getBaseUrl } from "@/lib/env";

export function GET() {
  const baseUrl = getBaseUrl();
  const callbackUrl = baseUrl ? `${baseUrl}/` : "/";
  const url = `/api/auth/signin/spotify?callbackUrl=${encodeURIComponent(
    callbackUrl
  )}`;
  return NextResponse.redirect(url);
}
