import { NextResponse } from "next/server";
import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { assertSpotifyEnv } from "@/lib/env";
import { getRequestIp, rateLimitResponse } from "@/lib/api/guards";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const ip = getRequestIp(req);
  const userAgent = (req.headers.get("user-agent") ?? "unknown").slice(0, 120);
  const rl = await rateLimitResponse({
    key: `app-status:${ip}:${userAgent}`,
    limit: 180,
    windowMs: 60_000,
    body: { status: "ERROR_RATE_LIMIT" },
    includeRetryAfter: true,
  });
  if (rl) return rl;

  try {
    assertSpotifyEnv();
    await spotifyFetch({
      url: "https://api.spotify.com/v1/search?q=a&type=artist&limit=1",
      userLevel: false,
    });
    return NextResponse.json({ status: "OK" });
  } catch (error) {
    const message = String(error);
    if (message.includes("Missing environment variable")) {
      return NextResponse.json({ status: "ERROR_MISSING_ENV" }, { status: 500 });
    }

    if (error instanceof SpotifyFetchError && error.status === 401) {
      return NextResponse.json({ status: "ERROR_AUTH" }, { status: 401 });
    }

    return NextResponse.json({ status: "ERROR_NETWORK" }, { status: 502 });
  }
}
