import { incCounter, observeHistogram } from "@/lib/observability/metrics";
import { logEvent } from "@/lib/observability/logger";
import { createCorrelationId } from "@/lib/observability/correlation";
import { recordSpotifyRateLimitBackoff } from "@/lib/observability/rateLimit";
import {
  registerSpotifyRateLimit,
  registerSpotifyRequestFailure,
  registerSpotifyRequestSuccess,
  scheduleSpotifyRequest,
  SpotifyRateLimitError,
} from "@/lib/spotify/rateLimitManager";
import { coalesceInflight, getCachedValue, setCachedValue } from "@/lib/spotify/requestCache";
import { inferSpotifyRequestPriority, type SpotifyRequestPriority } from "@/lib/spotify/requestPriority";

const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = Number(
  process.env.SPOTIFY_RETRY_AFTER_MAX_MS || "120000"
);

export class SpotifyApiError extends Error {
  status: number;
  code: string;
  body: string;
  retryAfterMs: number | null;
  retryable: boolean;
  correlationId: string;

  constructor(args: {
    status: number;
    code: string;
    body?: string;
    retryAfterMs?: number | null;
    retryable?: boolean;
    correlationId?: string;
  }) {
    super(`${args.code}:${args.status}`);
    this.name = "SpotifyApiError";
    this.status = args.status;
    this.code = args.code;
    this.body = args.body || "";
    this.retryAfterMs = args.retryAfterMs ?? null;
    this.retryable = Boolean(args.retryable);
    this.correlationId = args.correlationId || createCorrelationId();
  }
}

function normalizeRetryAfterMs(valueMs: number | null): number | null {
  if (valueMs == null || !Number.isFinite(valueMs)) return null;
  return Math.max(
    RETRY_AFTER_MIN_MS,
    Math.min(RETRY_AFTER_MAX_MS, Math.floor(valueMs))
  );
}

function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after") || res.headers.get("Retry-After");
  if (!raw) return null;
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds) && asSeconds > 0) {
    return normalizeRetryAfterMs(asSeconds * 1000);
  }
  const parsedDate = Date.parse(raw);
  if (Number.isFinite(parsedDate)) {
    const fromNow = parsedDate - Date.now();
    if (fromNow > 0) {
      return normalizeRetryAfterMs(fromNow);
    }
  }
  return null;
}

function classifyCode(
  status: number,
  body: string,
  endpointGroup: string,
  method: string
): string {
  const lower = body.toLowerCase();
  if (status === 401) {
    if (lower.includes("invalid_grant")) return "INVALID_GRANT";
    return "UNAUTHENTICATED";
  }
  if (status === 403) {
    if (
      endpointGroup === "me_player" &&
      /restriction\s+violated/i.test(body)
    ) {
      return "RESTRICTION_VIOLATED";
    }
    return "FORBIDDEN";
  }
  if (status === 404) {
    if (endpointGroup === "me_player") {
      return method === "GET" ? "NO_ACTIVE_DEVICE" : "PLAYER_NOT_FOUND";
    }
    if (endpointGroup === "me_player_devices") return "NO_CONNECT_DEVICE";
    return "NOT_FOUND";
  }
  if (status === 429) return "RATE_LIMIT";
  if (status >= 500) return "SPOTIFY_UPSTREAM";
  return "SPOTIFY_REQUEST_FAILED";
}

function isExpectedHttpCondition(args: {
  status: number;
  endpointGroup: string;
  method: string;
  errorCode: string;
}): boolean {
  const { status, endpointGroup, method, errorCode } = args;
  if (
    status === 404 &&
    endpointGroup === "me_player" &&
    method === "GET" &&
    errorCode === "NO_ACTIVE_DEVICE"
  ) {
    return true;
  }
  if (
    status === 404 &&
    endpointGroup === "me_player_devices" &&
    errorCode === "NO_CONNECT_DEVICE"
  ) {
    return true;
  }
  if (
    status === 403 &&
    endpointGroup === "me_player" &&
    errorCode === "RESTRICTION_VIOLATED"
  ) {
    return true;
  }
  return false;
}

function shouldRetryStatus(status: number): boolean {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function jitterMs(baseMs: number): number {
  return Math.max(10, Math.round(baseMs * (0.5 + Math.random() * 0.5)));
}

function waitWithRetryAfterJitter(baseMs: number): number {
  return Math.min(
    RETRY_AFTER_MAX_MS,
    Math.max(baseMs, Math.round(baseMs * (1 + Math.random() * 0.15)))
  );
}

function endpointGroup(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/v1/me/player/devices")) return "me_player_devices";
    if (parsed.pathname.startsWith("/v1/me/player")) return "me_player";
    if (parsed.pathname.startsWith("/v1/me/tracks")) return "me_tracks";
    if (parsed.pathname.startsWith("/v1/me/playlists")) return "me_playlists";
    if (parsed.pathname.startsWith("/api/token")) return "oauth_token";
    const parts = parsed.pathname.split("/").filter(Boolean).slice(0, 3);
    return parts.join("_") || "unknown";
  } catch {
    return "unknown";
  }
}

function stableStringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries
      .map(([key, val]) => `${key}:${stableStringify(val)}`)
      .join(",")}}`;
  }
  return String(value);
}

function requestCacheKey(params: {
  method: string;
  url: string;
  body?: unknown;
  userKey: string;
}): string {
  return `${params.userKey}|${params.method}|${params.url}|${stableStringify(params.body)}`;
}

function defaultCacheTtlMs(method: string, url: string): number {
  if (method !== "GET") return 0;
  try {
    const path = new URL(url).pathname;
    if (path.startsWith("/v1/me/player")) return 0;
    if (path.startsWith("/v1/me/player/devices")) return 2_000;
    if (path.startsWith("/v1/me/tracks")) return 8_000;
    if (path.startsWith("/v1/me/playlists")) return 10_000;
    if (path.startsWith("/v1/me/top")) return 20_000;
    if (path.startsWith("/v1/me/player/recently-played")) return 15_000;
    return 5_000;
  } catch {
    return 0;
  }
}

function defaultDedupeWindowMs(method: string, url: string): number {
  if (method !== "GET") return 300;
  try {
    const path = new URL(url).pathname;
    if (path.startsWith("/v1/me/player")) return 250;
    return 1_200;
  } catch {
    return 1_000;
  }
}

export async function spotifyApiRequest<T>(params: {
  url: string;
  accessToken: string;
  correlationId?: string;
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  maxAttempts?: number;
  userKey?: string;
  priority?: SpotifyRequestPriority;
  cacheTtlMs?: number;
  dedupeWindowMs?: number;
  bypassCache?: boolean;
}): Promise<T | undefined> {
  const correlationId = params.correlationId || createCorrelationId();
  const method = String(params.method || "GET").toUpperCase();
  const timeoutMs = params.timeoutMs ?? 15_000;
  const maxAttempts = params.maxAttempts ?? 3;
  const group = endpointGroup(params.url);
  const userKey = params.userKey || "anonymous";
  const priority = params.priority || inferSpotifyRequestPriority({ method, url: params.url });
  const cacheTtlMs =
    typeof params.cacheTtlMs === "number"
      ? Math.max(0, Math.floor(params.cacheTtlMs))
      : defaultCacheTtlMs(method, params.url);
  const dedupeWindowMs =
    typeof params.dedupeWindowMs === "number"
      ? Math.max(1, Math.floor(params.dedupeWindowMs))
      : defaultDedupeWindowMs(method, params.url);
  const cacheKey = requestCacheKey({
    method,
    url: params.url,
    body: params.body,
    userKey,
  });

  if (!params.bypassCache && cacheTtlMs > 0) {
    const cached = getCachedValue<T>(cacheKey);
    if (cached != null) {
      incCounter("spotify_cache_hits_total", {
        endpoint: group,
      });
      return cached;
    }
    incCounter("spotify_cache_misses_total", {
      endpoint: group,
    });
  }

  return coalesceInflight<T | undefined>(cacheKey, dedupeWindowMs, async () => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const started = Date.now();

      try {
        const result = await scheduleSpotifyRequest({
          userKey,
          endpoint: group,
          priority,
          run: async () => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            try {
              return await fetch(params.url, {
                method,
                headers: {
                  Authorization: `Bearer ${params.accessToken}`,
                  "Content-Type": "application/json",
                  "x-correlation-id": correlationId,
                },
                body: params.body ? JSON.stringify(params.body) : undefined,
                signal: controller.signal,
              });
            } finally {
              clearTimeout(timeout);
            }
          },
        });

        const durationMs = Date.now() - started;
        observeHistogram("spotify_api_latency_ms", durationMs, { endpoint: group, method });
        incCounter("spotify_api_requests_total", {
          endpoint: group,
          method,
          status_class: `${Math.floor(result.status / 100)}xx`,
          status_code: String(result.status),
        });

        if (result.ok) {
          registerSpotifyRequestSuccess(userKey);

          if (result.status === 204 || result.status === 205) {
            return undefined as T;
          }
          const text = await result.text();
          if (!text) return undefined as T;
          const contentType = result.headers.get("Content-Type") ?? "";
          const isJson =
            contentType.includes("application/json") ||
            text.trim().startsWith("{") ||
            text.trim().startsWith("[");
          const parsed = (isJson ? JSON.parse(text) : text) as T;
          if (!params.bypassCache && cacheTtlMs > 0 && method === "GET") {
            setCachedValue(cacheKey, parsed, cacheTtlMs);
          }
          return parsed;
        }

        const text = await result.text();
        const retryAfterMs = parseRetryAfterMs(result);
        const code = classifyCode(result.status, text, group, method);
        const retryable = shouldRetryStatus(result.status);
        const retryWaitMs =
          normalizeRetryAfterMs(retryAfterMs) ??
          Math.min(500 * attempt * attempt, 5_000);
        incCounter("spotify_api_errors_total", {
          endpoint: group,
          method,
          status_code: String(result.status),
          code,
        });
        const expected = isExpectedHttpCondition({
          status: result.status,
          endpointGroup: group,
          method,
          errorCode: code,
        });

        logEvent({
          level: retryable || expected ? "warn" : "error",
          event: "spotify_api_http_error",
          correlationId,
          endpointGroup: group,
          status: result.status,
          durationMs,
          errorCode: code,
          errorMessage: text.slice(0, 256),
          data: { attempt, retryAfterMs },
        });

        if (result.status === 429) {
          const waitMs = retryAfterMs ?? retryWaitMs;
          recordSpotifyRateLimitBackoff(waitMs);
          registerSpotifyRateLimit(userKey, waitMs, group);
        } else if (result.status >= 500) {
          registerSpotifyRequestFailure(userKey, group);
        }

        if (retryable && attempt < maxAttempts) {
          const waitMs =
            retryAfterMs != null
              ? waitWithRetryAfterJitter(retryWaitMs)
              : jitterMs(retryWaitMs);
          incCounter("spotify_api_retries_total", {
            endpoint: group,
            reason: code,
          });
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }

        throw new SpotifyApiError({
          status: result.status,
          code,
          body: text,
          retryAfterMs,
          retryable,
          correlationId,
        });
      } catch (error) {
        if (error instanceof SpotifyApiError) {
          throw error;
        }

        if (error instanceof SpotifyRateLimitError) {
          throw new SpotifyApiError({
            status: 429,
            code: "LOCAL_RATE_LIMIT",
            body: error.message,
            retryAfterMs: error.retryAfterMs,
            retryable: true,
            correlationId,
          });
        }

        const durationMs = Date.now() - started;
        const isAbort = error instanceof DOMException && error.name === "AbortError";
        const message = String((error as Error)?.message ?? error);
        const retryable =
          isAbort ||
          message.toLowerCase().includes("fetch") ||
          message.toLowerCase().includes("network") ||
          message.toLowerCase().includes("timeout");
        const networkCode = isAbort
          ? "NETWORK_TIMEOUT"
          : retryable
          ? "NETWORK_TRANSIENT"
          : "NETWORK_FATAL";

        logEvent({
          level: retryable ? "warn" : "error",
          event: "spotify_api_network_error",
          correlationId,
          endpointGroup: group,
          durationMs,
          errorCode: networkCode,
          errorMessage: message.slice(0, 256),
          data: { attempt },
        });

        registerSpotifyRequestFailure(userKey, group);

        if (retryable && attempt < maxAttempts) {
          incCounter("spotify_api_retries_total", {
            endpoint: group,
            reason: "NETWORK_TRANSIENT",
          });
          const base = Math.min(350 * attempt * attempt, 4_000);
          await new Promise((resolve) => setTimeout(resolve, jitterMs(base)));
          continue;
        }

        throw new SpotifyApiError({
          status: 0,
          code: networkCode,
          body: message,
          retryable,
          correlationId,
        });
      }
    }

    throw new SpotifyApiError({
      status: 0,
      code: "RETRY_EXHAUSTED",
      correlationId,
      retryable: false,
    });
  });
}
