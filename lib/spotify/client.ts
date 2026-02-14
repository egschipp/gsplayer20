import { getAppAccessToken, refreshAccessToken } from "@/lib/spotify/tokens";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { getRefreshToken, upsertTokens } from "@/lib/db/queries";
import { SpotifyFetchError } from "@/lib/spotify/errors";

const FETCH_TIMEOUT_MS = Number(
  process.env.SPOTIFY_FETCH_TIMEOUT_MS || "15000"
);

export async function spotifyFetch<T>(args: {
  url: string;
  method?: string;
  body?: unknown;
  userLevel?: boolean;
}) {
  const { url, method = "GET", body, userLevel = false } = args;

  if (!userLevel) {
    const appToken = await getAppAccessToken();
    return await doFetch<T>(url, method, body, appToken);
  }

  const session = await getServerSession(getAuthOptions());
  const accessToken = session?.accessToken as string | undefined;

  if (!accessToken) {
    throw new Error("UserNotAuthenticated");
  }

  try {
    return await doFetch<T>(url, method, body, accessToken);
  } catch (error) {
    if (error instanceof SpotifyFetchError) {
      if (error.status !== 401) throw error;
    } else if (!String(error).includes("401")) {
      throw error;
    }
  }

  if (!session?.appUserId) {
    throw new Error("UserNotAuthenticated");
  }

  const storedRefresh = await getRefreshToken(session.appUserId as string);
  const refreshed = await refreshAccessToken({
    accessToken: accessToken,
    refreshToken: storedRefresh ?? undefined,
    accessTokenExpires: session?.expiresAt as number | undefined,
    scope: session?.scope as string | undefined,
  });

  if ("error" in refreshed) {
    throw new Error("RefreshFailed");
  }

  if (refreshed.refreshToken) {
    await upsertTokens({
      userId: session.appUserId as string,
      refreshToken: refreshed.refreshToken,
      accessToken: refreshed.accessToken,
      accessExpiresAt: refreshed.accessTokenExpires,
      scope: refreshed.scope,
    });
  }

  return await doFetch<T>(url, method, body, refreshed.accessToken as string);
}

async function doFetch<T>(
  url: string,
  method: string,
  body: unknown,
  accessToken: string
) {
  const maxAttempts = 3;
  let attempt = 0;
  let lastError: SpotifyFetchError | Error | null = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      if (res.status === 204 || res.status === 205) {
        return undefined as T;
      }
      const text = await res.text();
      if (!text) {
        return undefined as T;
      }
      const contentType = res.headers.get("Content-Type") ?? "";
      const looksJson =
        contentType.includes("application/json") ||
        text.trim().startsWith("{") ||
        text.trim().startsWith("[");
      if (looksJson) {
        return JSON.parse(text) as T;
      }
      return text as T;
    }

    const retryAfter = res.headers.get("Retry-After");
    const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : null;
    const text = await res.text();
    lastError = new SpotifyFetchError(res.status, text);

    const shouldRetry =
      res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503;

    if (!shouldRetry || attempt >= maxAttempts) {
      break;
    }

    const waitMs = retryAfterMs ?? Math.min(1000 * attempt * attempt, 4000);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  if (lastError) throw lastError;
  throw new SpotifyFetchError(500, "SpotifyFetchError:unknown");
}
