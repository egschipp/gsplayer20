import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { rateLimit } from "@/lib/rate-limit/ratelimit";
import { hasAllScopes } from "@/lib/spotify/scopes";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  const rl = rateLimit(`user-status:${ip}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { status: "ERROR_RATE_LIMIT" },
      { status: 429 }
    );
  }

  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ status: "LOGGED_OUT" }, { status: 401 });
  }

  const scope = session.scope as string | undefined;
  if (!hasAllScopes(scope)) {
    return NextResponse.json(
      { status: "ERROR_SCOPES", scope },
      { status: 403 }
    );
  }

  const res = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });

  if (res.status === 401) {
    return NextResponse.json(
      { status: "ERROR_REVOKED" },
      { status: 401 }
    );
  }

  if (!res.ok) {
    return NextResponse.json(
      { status: "ERROR_NETWORK", detail: res.status },
      { status: 502 }
    );
  }

  const profile = await res.json();
  return NextResponse.json({ status: "OK", profile });
}
