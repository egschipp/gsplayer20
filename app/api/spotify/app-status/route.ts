import { NextResponse } from "next/server";
import { getAppAccessToken } from "@/lib/spotify/tokens";
import { rateLimit } from "@/lib/rate-limit/ratelimit";
import { assertSpotifyEnv } from "@/lib/env";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  const rl = rateLimit(`app-status:${ip}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { status: "ERROR_RATE_LIMIT" },
      { status: 429 }
    );
  }

  try {
    assertSpotifyEnv();
    const token = await getAppAccessToken();

    const res = await fetch(
      "https://api.spotify.com/v1/search?q=a&type=artist&limit=1",
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (!res.ok) {
      return NextResponse.json(
        { status: "ERROR_AUTH", detail: res.status },
        { status: 401 }
      );
    }

    return NextResponse.json({ status: "OK" });
  } catch (error) {
    const message = String(error);
    if (message.includes("Missing environment variable")) {
      return NextResponse.json({ status: "ERROR_MISSING_ENV" }, { status: 500 });
    }

    return NextResponse.json({ status: "ERROR_NETWORK" }, { status: 502 });
  }
}
