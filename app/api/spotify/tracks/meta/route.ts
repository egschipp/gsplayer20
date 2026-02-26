import { NextResponse } from "next/server";
import { requireAppUser } from "@/lib/api/guards";
import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";

export const runtime = "nodejs";
const TRACK_ID_REGEX = /^[A-Za-z0-9]{22}$/;

export async function GET(req: Request) {
  const { response } = await requireAppUser();
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const trackId = searchParams.get("trackId");
  if (!trackId || !TRACK_ID_REGEX.test(trackId)) {
    return NextResponse.json({ error: "INVALID_TRACK" }, { status: 400 });
  }

  try {
    const data = await spotifyFetch({
      url: `https://api.spotify.com/v1/tracks/${trackId}`,
      userLevel: true,
      priority: "background",
      cacheTtlMs: 20_000,
      dedupeWindowMs: 2_000,
    });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof SpotifyFetchError) {
      if (error.status === 401) {
        return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
      }
      if (error.status === 403) {
        return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
      }
      if (error.status === 429) {
        return NextResponse.json({ error: "RATE_LIMIT" }, { status: 429 });
      }
      return NextResponse.json({ error: "SPOTIFY_UPSTREAM" }, { status: 502 });
    }

    if (String(error).includes("UserNotAuthenticated")) {
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }

    return NextResponse.json({ error: "SPOTIFY_UPSTREAM" }, { status: 502 });
  }
}
