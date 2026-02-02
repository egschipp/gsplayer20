import { NextResponse } from "next/server";
import { spotifyFetch } from "@/lib/spotify/client";
import { rateLimit } from "@/lib/rate-limit/ratelimit";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  const rl = rateLimit(`top:${ip}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "RATE_LIMIT" },
      { status: 429 }
    );
  }

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") ?? "artists";
  const timeRange = searchParams.get("time_range") ?? "medium_term";
  const limit = searchParams.get("limit") ?? "20";
  const offset = searchParams.get("offset") ?? "0";

  if (!['artists', 'tracks'].includes(type)) {
    return NextResponse.json({ error: "INVALID_TYPE" }, { status: 400 });
  }

  try {
    const data = await spotifyFetch({
      url: `https://api.spotify.com/v1/me/top/${type}?time_range=${timeRange}&limit=${limit}&offset=${offset}`,
      userLevel: true,
    });

    return NextResponse.json(data);
  } catch (error) {
    const message = String(error);
    const status = message.includes("UserNotAuthenticated") ? 401 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
