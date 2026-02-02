import { requireEnv } from "@/lib/env";

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

let appTokenCache: {
  accessToken: string;
  expiresAt: number;
} | null = null;

function basicAuthHeader() {
  const clientId = requireEnv("SPOTIFY_CLIENT_ID");
  const clientSecret = requireEnv("SPOTIFY_CLIENT_SECRET");
  const raw = `${clientId}:${clientSecret}`;
  const encoded = Buffer.from(raw).toString("base64");
  return `Basic ${encoded}`;
}

export async function getAppAccessToken() {
  if (appTokenCache && Date.now() < appTokenCache.expiresAt - 60_000) {
    return appTokenCache.accessToken;
  }

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify token error: ${res.status} ${text}`);
  }

  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  appTokenCache = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };

  return appTokenCache.accessToken;
}

export async function refreshAccessToken(token: {
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpires?: number;
  scope?: string;
}) {
  try {
    const refreshToken = token.refreshToken;
    if (!refreshToken) {
      return { ...token, error: "MissingRefreshToken" } as const;
    }

    const res = await fetch(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basicAuthHeader(),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { ...token, error: `RefreshFailed:${res.status}:${text}` } as const;
    }

    const json = (await res.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
      scope?: string;
    };

    return {
      ...token,
      accessToken: json.access_token,
      accessTokenExpires: Date.now() + json.expires_in * 1000,
      refreshToken: json.refresh_token ?? token.refreshToken,
      scope: json.scope ?? token.scope,
    } as const;
  } catch (error) {
    return { ...token, error: `RefreshFailed:${String(error)}` } as const;
  }
}
