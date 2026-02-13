import { NextResponse } from "next/server";
import { requireAppUser } from "@/lib/api/guards";
import { spotifyFetch } from "@/lib/spotify/client";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { response } = await requireAppUser();
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const trackId = searchParams.get("trackId");
  if (!trackId) {
    return NextResponse.json({ error: "MISSING_TRACK" }, { status: 400 });
  }

  try {
    const data = await spotifyFetch({
      url: `https://api.spotify.com/v1/tracks/${trackId}`,
      userLevel: true,
    });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = String(error);
    const status = message.includes("UserNotAuthenticated") ? 401 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
