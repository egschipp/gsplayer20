import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { missingScopes, scopeCapabilities } from "@/lib/spotify/scopes";
import {
  getCorrelationId,
  getRequestIp,
  rateLimitResponse,
  jsonNoStore,
} from "@/lib/api/guards";
import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { getSqlite } from "@/lib/db/client";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const correlationId = getCorrelationId(req);
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

  if (!session?.appUserId) {
    return jsonNoStore({ status: "LOGGED_OUT", correlationId }, 401, {
      "x-correlation-id": correlationId,
    });
  }

  const scope = session.scope as string | undefined;
  const capabilities = scopeCapabilities(scope);
  const missing = missingScopes(scope);
  const tokenMetadata = getSqlite()
    .prepare("SELECT refresh_expires_at FROM oauth_tokens WHERE user_id = ?")
    .get(session.appUserId) as { refresh_expires_at?: number | null } | undefined;
  const refreshExpiresAt = tokenMetadata?.refresh_expires_at ?? null;
  if (refreshExpiresAt && refreshExpiresAt <= Date.now()) {
    return jsonNoStore(
      { status: "ERROR_REAUTH_REQUIRED", refreshExpiresAt, correlationId },
      401,
      { "x-correlation-id": correlationId }
    );
  }

  try {
    const spotifyProfile = (await spotifyFetch({
      url: "https://api.spotify.com/v1/me",
      userLevel: true,
      activity: "user_status_profile",
      correlationId,
    })) as Record<string, unknown>;
    const profile = {
      id: typeof spotifyProfile.id === "string" ? spotifyProfile.id : undefined,
      display_name:
        typeof spotifyProfile.display_name === "string"
          ? spotifyProfile.display_name
          : undefined,
      images: Array.isArray(spotifyProfile.images)
        ? spotifyProfile.images.slice(0, 1)
        : [],
      product:
        typeof spotifyProfile.product === "string" ? spotifyProfile.product : undefined,
    };
    return jsonNoStore(
      {
        status:
          refreshExpiresAt && refreshExpiresAt - Date.now() < 14 * 24 * 60 * 60 * 1000
            ? "OK_REAUTH_SOON"
            : missing.length > 0
              ? "OK_LIMITED"
              : "OK",
        profile,
        capabilities,
        missingScopes: missing,
        refreshExpiresAt,
        correlationId,
      },
      200,
      {
        "x-correlation-id": correlationId,
      }
    );
  } catch (error) {
    if (error instanceof SpotifyFetchError && error.status === 401) {
      return jsonNoStore({ status: "ERROR_REVOKED", correlationId }, 401, {
        "x-correlation-id": correlationId,
      });
    }
    return jsonNoStore({ status: "ERROR_NETWORK", correlationId }, 502, {
      "x-correlation-id": correlationId,
    });
  }
}
