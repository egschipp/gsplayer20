import { spotifyFetch } from "@/lib/spotify/client";
import { rateLimitResponse, jsonNoStore, requireAppUser } from "@/lib/api/guards";
import { SpotifyFetchError } from "@/lib/spotify/errors";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { session, response } = await requireAppUser();
  if (response) return response;

  const rl = await rateLimitResponse({
    key: `top:${session.appUserId}`,
    limit: 60,
    windowMs: 60_000,
  });
  if (rl) return rl;

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") ?? "artists";
  const timeRange = searchParams.get("time_range") ?? "medium_term";
  const limitRaw = Number(searchParams.get("limit") ?? "20");
  const offsetRaw = Number(searchParams.get("offset") ?? "0");

  if (!['artists', 'tracks'].includes(type)) {
    return jsonNoStore({ error: "INVALID_TYPE" }, 400);
  }

  if (!["short_term", "medium_term", "long_term"].includes(timeRange)) {
    return jsonNoStore({ error: "INVALID_TIME_RANGE" }, 400);
  }

  if (!Number.isFinite(limitRaw) || limitRaw < 1 || limitRaw > 50) {
    return jsonNoStore({ error: "INVALID_LIMIT" }, 400);
  }

  if (!Number.isFinite(offsetRaw) || offsetRaw < 0 || offsetRaw > 100_000) {
    return jsonNoStore({ error: "INVALID_OFFSET" }, 400);
  }

  const limit = Math.floor(limitRaw);
  const offset = Math.floor(offsetRaw);

  try {
    const data = await spotifyFetch({
      url: `https://api.spotify.com/v1/me/top/${type}?time_range=${timeRange}&limit=${limit}&offset=${offset}`,
      userLevel: true,
      activity: `me_top_${type}`,
    });

    return jsonNoStore(data);
  } catch (error) {
    if (error instanceof SpotifyFetchError) {
      if (error.status === 401) return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
      if (error.status === 403) return jsonNoStore({ error: "FORBIDDEN" }, 403);
      if (error.status === 429) return jsonNoStore({ error: "RATE_LIMIT" }, 429);
      return jsonNoStore({ error: "SPOTIFY_UPSTREAM" }, 502);
    }

    if (String(error).includes("UserNotAuthenticated")) {
      return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
    }

    return jsonNoStore({ error: "SPOTIFY_UPSTREAM" }, 502);
  }
}
