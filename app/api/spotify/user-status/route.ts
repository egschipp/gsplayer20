import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { hasAllScopes } from "@/lib/spotify/scopes";
import { getRequestIp, rateLimitResponse, jsonNoStore } from "@/lib/api/guards";
import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const ip = getRequestIp(req);
  const rl = await rateLimitResponse({
    key: `user-status:${ip}`,
    limit: 30,
    windowMs: 60_000,
    body: { status: "ERROR_RATE_LIMIT" },
  });
  if (rl) return rl;

  const session = await getServerSession(getAuthOptions());
  if (!session?.accessToken) {
    return jsonNoStore({ status: "LOGGED_OUT" }, 401);
  }

  const scope = session.scope as string | undefined;
  if (!hasAllScopes(scope)) {
    return jsonNoStore({ status: "ERROR_SCOPES", scope }, 403);
  }

  try {
    const profile = await spotifyFetch({
      url: "https://api.spotify.com/v1/me",
      userLevel: true,
    });
    return jsonNoStore({ status: "OK", profile });
  } catch (error) {
    const message = String(error);
    if (error instanceof SpotifyFetchError && error.status === 401) {
      return jsonNoStore({ status: "ERROR_REVOKED" }, 401);
    }
    return jsonNoStore({ status: "ERROR_NETWORK" }, 502);
  }
}
