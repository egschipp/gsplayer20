import { requireEnv } from "@/lib/env";

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const FETCH_TIMEOUT_MS = Number(
  process.env.SPOTIFY_FETCH_TIMEOUT_MS || "15000"
);
const APP_REFRESH_SKEW_MS = Number(
  process.env.SPOTIFY_APP_REFRESH_SKEW_MS || "90000"
);
const APP_REFRESH_MIN_DELAY_MS = 15_000;
const APP_REFRESH_RETRY_BASE_MS = 10_000;
const APP_REFRESH_RETRY_MAX_MS = 5 * 60_000;

let appTokenCache: {
  accessToken: string;
  expiresAt: number;
} | null = null;
let appRefreshPromise: Promise<string> | null = null;
let appRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let appRefreshRetryMs = APP_REFRESH_RETRY_BASE_MS;
let appLastAttemptAt: number | null = null;
let appLastRefreshAt: number | null = null;
let appRefreshSuccessCount = 0;
let appRefreshFailureCount = 0;
let appLastError: string | null = null;
let appLastSource: string | null = null;

export function clearAppTokenCache() {
  if (appRefreshTimer) {
    clearTimeout(appRefreshTimer);
    appRefreshTimer = null;
  }
  appTokenCache = null;
  appRefreshPromise = null;
  appRefreshRetryMs = APP_REFRESH_RETRY_BASE_MS;
  appLastAttemptAt = null;
  appLastRefreshAt = null;
  appRefreshSuccessCount = 0;
  appRefreshFailureCount = 0;
  appLastError = null;
  appLastSource = null;
}

function basicAuthHeader() {
  const clientId = requireEnv("SPOTIFY_CLIENT_ID");
  const clientSecret = requireEnv("SPOTIFY_CLIENT_SECRET");
  const raw = `${clientId}:${clientSecret}`;
  const encoded = Buffer.from(raw).toString("base64");
  return `Basic ${encoded}`;
}

async function fetchWithTimeout(url: string, options: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function clearAppRefreshTimer() {
  if (!appRefreshTimer) return;
  clearTimeout(appRefreshTimer);
  appRefreshTimer = null;
}

function scheduleAppRefreshIn(delayMs: number) {
  clearAppRefreshTimer();
  const clampedDelay = Math.max(
    APP_REFRESH_MIN_DELAY_MS,
    Math.floor(delayMs || APP_REFRESH_MIN_DELAY_MS)
  );
  appRefreshTimer = setTimeout(() => {
    void ensureAppAccessToken("timer").catch(() => undefined);
  }, clampedDelay);
}

function scheduleAppRefreshFromCache() {
  if (!appTokenCache) return;
  const delay = appTokenCache.expiresAt - Date.now() - APP_REFRESH_SKEW_MS;
  scheduleAppRefreshIn(delay);
}

function scheduleAppRefreshRetry() {
  scheduleAppRefreshIn(appRefreshRetryMs);
  appRefreshRetryMs = Math.min(appRefreshRetryMs * 2, APP_REFRESH_RETRY_MAX_MS);
}

async function requestAppAccessToken() {
  const res = await fetchWithTimeout(SPOTIFY_TOKEN_URL, {
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
  return {
    accessToken: String(json.access_token || ""),
    expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
  };
}

async function ensureAppAccessToken(source = "demand") {
  if (appTokenCache && Date.now() < appTokenCache.expiresAt - APP_REFRESH_SKEW_MS) {
    scheduleAppRefreshFromCache();
    return appTokenCache.accessToken;
  }
  if (appRefreshPromise) {
    return appRefreshPromise;
  }

  appRefreshPromise = (async () => {
    appLastAttemptAt = Date.now();
    appLastSource = source;
    try {
      const next = await requestAppAccessToken();
      if (!next.accessToken || !next.expiresAt) {
        throw new Error("Spotify token error: missing_access_token");
      }
      appTokenCache = next;
      appRefreshSuccessCount += 1;
      appRefreshRetryMs = APP_REFRESH_RETRY_BASE_MS;
      appLastRefreshAt = Date.now();
      appLastError = null;
      scheduleAppRefreshFromCache();
      return next.accessToken;
    } catch (error) {
      appRefreshFailureCount += 1;
      appLastError = String(error).slice(0, 512);
      scheduleAppRefreshRetry();
      throw error;
    } finally {
      appRefreshPromise = null;
    }
  })();

  return appRefreshPromise;
}

export async function getAppAccessToken() {
  return ensureAppAccessToken("demand");
}

export function warmAppAccessToken() {
  if (appTokenCache && Date.now() < appTokenCache.expiresAt - APP_REFRESH_SKEW_MS) {
    scheduleAppRefreshFromCache();
    return;
  }
  if (!appRefreshPromise) {
    void ensureAppAccessToken("warmup").catch(() => undefined);
  }
}

export function getAppTokenStatus(now = Date.now()) {
  const expiresAt = appTokenCache?.expiresAt ?? null;
  const expiresInSec =
    typeof expiresAt === "number" && expiresAt > 0
      ? Math.max(0, Math.floor((expiresAt - now) / 1000))
      : null;

  let status: "MISSING" | "VALID" | "EXPIRING" | "EXPIRED" | "REFRESHING" | "ERROR";
  if (appRefreshPromise) {
    status = "REFRESHING";
  } else if (!appTokenCache) {
    status = appRefreshFailureCount > 0 ? "ERROR" : "MISSING";
  } else if ((expiresInSec ?? 0) <= 0) {
    status = "EXPIRED";
  } else if ((expiresInSec ?? 0) <= Math.ceil(APP_REFRESH_SKEW_MS / 1000)) {
    status = "EXPIRING";
  } else {
    status = "VALID";
  }

  return {
    status,
    expiresAt,
    expiresInSec,
    refreshSuccessCount: appRefreshSuccessCount,
    refreshFailureCount: appRefreshFailureCount,
    lastAttemptAt: appLastAttemptAt,
    lastRefreshAt: appLastRefreshAt,
    lastError: appLastError,
    lastSource: appLastSource,
    hasCachedToken: Boolean(appTokenCache?.accessToken),
  };
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

    const res = await fetchWithTimeout(SPOTIFY_TOKEN_URL, {
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
