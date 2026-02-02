import { getAppAccessToken, refreshAccessToken } from "@/lib/spotify/tokens";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { getRefreshToken, upsertTokens } from "@/lib/db/queries";

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
    if (!String(error).includes("401")) {
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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SpotifyFetchError:${res.status}:${text}`);
  }

  return (await res.json()) as T;
}
