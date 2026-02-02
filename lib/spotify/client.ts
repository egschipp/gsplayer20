import { getAppAccessToken, refreshAccessToken } from "@/lib/spotify/tokens";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";

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

  const session = await getServerSession(authOptions);
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

  const refreshed = await refreshAccessToken({
    accessToken: accessToken,
    refreshToken: session?.refreshToken as string | undefined,
    accessTokenExpires: session?.expiresAt as number | undefined,
    scope: session?.scope as string | undefined,
  });

  if ("error" in refreshed) {
    throw new Error("RefreshFailed");
  }

  return await doFetch<T>(url, method, body, refreshed.accessToken as string);
}

async function doFetch<T>(
  url: string,
  method: string,
  body: unknown,
  accessToken: string
) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SpotifyFetchError:${res.status}:${text}`);
  }

  return (await res.json()) as T;
}
