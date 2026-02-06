import { spotifyFetch } from "@/lib/spotify/client";
import { getRequestIp, rateLimitResponse, jsonNoStore } from "@/lib/api/guards";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const ip = getRequestIp(req);
  const rl = await rateLimitResponse({
    key: `top:${ip}`,
    limit: 60,
    windowMs: 60_000,
  });
  if (rl) return rl;

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") ?? "artists";
  const timeRange = searchParams.get("time_range") ?? "medium_term";
  const limit = searchParams.get("limit") ?? "20";
  const offset = searchParams.get("offset") ?? "0";

  if (!['artists', 'tracks'].includes(type)) {
    return jsonNoStore({ error: "INVALID_TYPE" }, 400);
  }

  try {
    const data = await spotifyFetch({
      url: `https://api.spotify.com/v1/me/top/${type}?time_range=${timeRange}&limit=${limit}&offset=${offset}`,
      userLevel: true,
    });

    return jsonNoStore(data);
  } catch (error) {
    const message = String(error);
    const status = message.includes("UserNotAuthenticated") ? 401 : 502;
    return jsonNoStore({ error: message }, status);
  }
}
