import { NextResponse } from "next/server";
import { spotifyFetch } from "@/lib/spotify/client";
import { assertSpotifyEnv } from "@/lib/env";
import { getRequestIp, rateLimitResponse } from "@/lib/api/guards";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const ip = getRequestIp(req);
  const rl = await rateLimitResponse({
    key: `app-status:${ip}`,
    limit: 30,
    windowMs: 60_000,
    body: { status: "ERROR_RATE_LIMIT" },
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

    if (message.includes("SpotifyFetchError:401")) {
      return NextResponse.json({ status: "ERROR_AUTH" }, { status: 401 });
    }

    return NextResponse.json({ status: "ERROR_NETWORK" }, { status: 502 });
  }
}
