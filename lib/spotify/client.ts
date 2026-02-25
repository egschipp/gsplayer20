import { getAppAccessToken } from "@/lib/spotify/tokens";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { createCorrelationId } from "@/lib/observability/correlation";
import { getValidAccessTokenForUser } from "@/lib/spotify/tokenManager";
import { SpotifyApiError, spotifyApiRequest } from "@/lib/spotify/spotifyApiClient";
import type { SpotifyRequestClass, SpotifyRequestPriority } from "@/lib/spotify/requestPolicy";

const FETCH_TIMEOUT_MS = Number(process.env.SPOTIFY_FETCH_TIMEOUT_MS || "15000");

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

export async function spotifyFetch<T>(args: {
  url: string;
  method?: string;
  body?: unknown;
  userLevel?: boolean;
  correlationId?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  priority?: SpotifyRequestPriority;
  requestClass?: SpotifyRequestClass;
  cacheTtlMs?: number;
  staleWhileRevalidateMs?: number;
  circuitBreakerProtected?: boolean;
}) {
  const {
    url,
    method = "GET",
    body,
    userLevel = false,
    correlationId = createCorrelationId(),
    timeoutMs = FETCH_TIMEOUT_MS,
    maxAttempts,
    priority,
    requestClass,
    cacheTtlMs,
    staleWhileRevalidateMs,
    circuitBreakerProtected,
  } = args;

  try {
    if (!userLevel) {
      const appToken = await getAppAccessToken();
      return await spotifyApiRequest<T>({
        url,
        method,
        body,
        accessToken: appToken,
        timeoutMs,
        maxAttempts,
        correlationId,
        userKey: "app",
        priority,
        requestClass,
        cacheTtlMs,
        staleWhileRevalidateMs,
        circuitBreakerProtected,
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
      return await spotifyApiRequest<T>({
        url,
        method,
        body,
        accessToken: tokenResult.accessToken,
        timeoutMs,
        maxAttempts,
        correlationId,
        userKey: appUserId,
        priority,
        requestClass,
        cacheTtlMs,
        staleWhileRevalidateMs,
        circuitBreakerProtected,
      });
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
        return await spotifyApiRequest<T>({
          url,
          method,
          body,
          accessToken: forced.accessToken,
          timeoutMs,
          maxAttempts,
          correlationId,
          userKey: appUserId,
          priority,
          requestClass,
          cacheTtlMs,
          staleWhileRevalidateMs,
          circuitBreakerProtected,
        });
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
