import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { hasAllScopes } from "@/lib/spotify/scopes";
import { getRequestIp, rateLimitResponse } from "@/lib/api/guards";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const ip = getRequestIp(req);
  const rl = rateLimitResponse({
    key: `user-status:${ip}`,
    limit: 30,
    windowMs: 60_000,
    body: { status: "ERROR_RATE_LIMIT" },
  });
  if (rl) return rl;

  const session = await getServerSession(getAuthOptions());
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
