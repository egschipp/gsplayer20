import { getAppAccessToken } from "@/lib/spotify/tokens";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { createCorrelationId } from "@/lib/observability/correlation";
import { getValidAccessTokenForUser } from "@/lib/spotify/tokenManager";
import {
  SpotifyApiError,
  spotifyApiRequest,
} from "@/lib/spotify/spotifyApiClient";
import { bumpUserCacheVersion } from "@/lib/spotify/requestCache";
import {
  inferSpotifyRequestPriority,
  type SpotifyRequestPriority,
} from "@/lib/spotify/requestPriority";

const FETCH_TIMEOUT_MS = Number(process.env.SPOTIFY_FETCH_TIMEOUT_MS || "8000");

function mapToFetchError(error: unknown, fallbackCorrelationId: string): SpotifyFetchError {
  if (error instanceof SpotifyApiError) {
    return new SpotifyFetchError(error.status, error.body || error.code, {
      code: error.code,
      retryAfterMs: error.retryAfterMs,
      correlationId: error.correlationId || fallbackCorrelationId,
    });
  }
  return new SpotifyFetchError(500, String(error), {
    code: "SPOTIFY_CLIENT_ERROR",
    correlationId: fallbackCorrelationId,
  });
}

function resolveCachePolicy(args: {
  url: string;
  method: string;
}): { cacheTtlMs: number; dedupeWindowMs: number } {
  const method = args.method.toUpperCase();
  if (method !== "GET") {
    return { cacheTtlMs: 0, dedupeWindowMs: 250 };
  }

  try {
    const path = new URL(args.url).pathname;
    if (path.startsWith("/v1/me/player")) {
      return { cacheTtlMs: 0, dedupeWindowMs: 200 };
    }
    if (path.startsWith("/v1/me/player/devices")) {
      return { cacheTtlMs: 1500, dedupeWindowMs: 500 };
    }
    if (path.startsWith("/v1/me/tracks") || path.startsWith("/v1/me/playlists")) {
      return { cacheTtlMs: 6000, dedupeWindowMs: 1200 };
    }
    if (path.startsWith("/v1/me/top") || path.startsWith("/v1/me/player/recently-played")) {
      return { cacheTtlMs: 15000, dedupeWindowMs: 2000 };
    }
  } catch {
    // ignore and use defaults
  }

  return { cacheTtlMs: 5000, dedupeWindowMs: 1000 };
}

export async function spotifyFetch<T>(args: {
  url: string;
  method?: string;
  body?: unknown;
  userLevel?: boolean;
  activity?: string;
  correlationId?: string;
  priority?: SpotifyRequestPriority;
  cacheTtlMs?: number;
  dedupeWindowMs?: number;
  bypassCache?: boolean;
}) {
  const {
    url,
    method = "GET",
    body,
    userLevel = false,
    activity,
    correlationId = createCorrelationId(),
    priority,
    cacheTtlMs,
    dedupeWindowMs,
    bypassCache = false,
  } = args;

  const normalizedMethod = method.toUpperCase();
  const resolvedPriority =
    priority || inferSpotifyRequestPriority({ method: normalizedMethod, url });
  const cachePolicy = resolveCachePolicy({ url, method: normalizedMethod });

  try {
    if (!userLevel) {
      const appToken = await getAppAccessToken();
      return await spotifyApiRequest<T>({
        url,
        method: normalizedMethod,
        body,
        accessToken: appToken,
        timeoutMs: FETCH_TIMEOUT_MS,
        correlationId,
        activity,
        userKey: "app",
        priority: resolvedPriority,
        cacheTtlMs: cacheTtlMs ?? cachePolicy.cacheTtlMs,
        dedupeWindowMs: dedupeWindowMs ?? cachePolicy.dedupeWindowMs,
        bypassCache,
      });
    }

    const session = await getServerSession(getAuthOptions());
    const appUserId =
      typeof session?.appUserId === "string" && session.appUserId.trim()
        ? session.appUserId.trim()
        : null;
    if (!appUserId) {
      throw new SpotifyFetchError(401, "UserNotAuthenticated", {
        code: "UNAUTHENTICATED",
        correlationId,
      });
    }

    const tokenResult = await getValidAccessTokenForUser({
      userId: appUserId,
      correlationId,
    });

    if (!tokenResult.ok) {
      if (
        tokenResult.code === "MISSING_REFRESH_TOKEN" ||
        tokenResult.code === "INVALID_GRANT"
      ) {
        throw new SpotifyFetchError(401, tokenResult.code, {
          code: tokenResult.code,
          correlationId,
        });
      }
      throw new SpotifyFetchError(503, tokenResult.code, {
        code: tokenResult.code,
        correlationId,
      });
    }

    try {
      const result = await spotifyApiRequest<T>({
        url,
        method: normalizedMethod,
        body,
        accessToken: tokenResult.accessToken,
        timeoutMs: FETCH_TIMEOUT_MS,
        correlationId,
        activity,
        userKey: appUserId,
        priority: resolvedPriority,
        cacheTtlMs: cacheTtlMs ?? cachePolicy.cacheTtlMs,
        dedupeWindowMs: dedupeWindowMs ?? cachePolicy.dedupeWindowMs,
        bypassCache,
      });
      if (normalizedMethod !== "GET") {
        await bumpUserCacheVersion(appUserId);
      }
      return result;
    } catch (error) {
      if (error instanceof SpotifyApiError && error.status === 401) {
        const forced = await getValidAccessTokenForUser({
          userId: appUserId,
          correlationId,
          forceRefresh: true,
        });
        if (!forced.ok) {
          throw new SpotifyFetchError(401, forced.code, {
            code: forced.code,
            correlationId,
          });
        }
        const retried = await spotifyApiRequest<T>({
          url,
          method: normalizedMethod,
          body,
          accessToken: forced.accessToken,
          timeoutMs: FETCH_TIMEOUT_MS,
          correlationId,
          activity,
          userKey: appUserId,
          priority: resolvedPriority,
          cacheTtlMs: cacheTtlMs ?? cachePolicy.cacheTtlMs,
          dedupeWindowMs: dedupeWindowMs ?? cachePolicy.dedupeWindowMs,
          bypassCache,
        });
        if (normalizedMethod !== "GET") {
          await bumpUserCacheVersion(appUserId);
        }
        return retried;
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof SpotifyFetchError) {
      throw error;
    }
    throw mapToFetchError(error, correlationId);
  }
}
