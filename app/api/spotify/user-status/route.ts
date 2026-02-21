import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { hasAllScopes } from "@/lib/spotify/scopes";
import { getRequestIp, rateLimitResponse, jsonNoStore } from "@/lib/api/guards";
import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await getServerSession(getAuthOptions());
  const ip = getRequestIp(req);
  const appUserId =
    typeof session?.appUserId === "string" && session.appUserId.trim()
      ? session.appUserId.trim()
      : null;
  const rl = await rateLimitResponse({
    key: appUserId ? `user-status:user:${appUserId}` : `user-status:ip:${ip}`,
    limit: 120,
    windowMs: 60_000,
    body: { status: "ERROR_RATE_LIMIT" },
    includeRetryAfter: true,
  });
  if (rl) return rl;

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
