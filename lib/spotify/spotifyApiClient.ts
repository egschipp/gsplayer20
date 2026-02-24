import { incCounter, observeHistogram } from "@/lib/observability/metrics";
import { logEvent } from "@/lib/observability/logger";
import { createCorrelationId } from "@/lib/observability/correlation";
import { recordSpotifyRateLimitBackoff } from "@/lib/observability/rateLimit";

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
  if (
    endpointGroup === "v1_recommendations" &&
    (status === 400 || status === 404)
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

export async function spotifyApiRequest<T>(params: {
  url: string;
  accessToken: string;
  correlationId?: string;
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  maxAttempts?: number;
}): Promise<T | undefined> {
  const correlationId = params.correlationId || createCorrelationId();
  const method = String(params.method || "GET").toUpperCase();
  const timeoutMs = params.timeoutMs ?? 15_000;
  const maxAttempts = params.maxAttempts ?? 3;
  const group = endpointGroup(params.url);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(params.url, {
        method,
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          "Content-Type": "application/json",
          "x-correlation-id": correlationId,
        },
        body: params.body ? JSON.stringify(params.body) : undefined,
        signal: controller.signal,
      });

      const durationMs = Date.now() - started;
      observeHistogram("spotify_api_latency_ms", durationMs, { endpoint: group, method });
      incCounter("spotify_api_requests_total", {
        endpoint: group,
        method,
        status_class: `${Math.floor(res.status / 100)}xx`,
        status_code: String(res.status),
      });

      if (res.ok) {
        if (res.status === 204 || res.status === 205) {
          return undefined as T;
        }
        const text = await res.text();
        if (!text) return undefined as T;
        const contentType = res.headers.get("Content-Type") ?? "";
        const isJson =
          contentType.includes("application/json") ||
          text.trim().startsWith("{") ||
          text.trim().startsWith("[");
        return (isJson ? JSON.parse(text) : text) as T;
      }

      const text = await res.text();
      const retryAfterMs = parseRetryAfterMs(res);
      const code = classifyCode(res.status, text, group, method);
      const retryable = shouldRetryStatus(res.status);
      const retryWaitMs =
        normalizeRetryAfterMs(retryAfterMs) ??
        Math.min(500 * attempt * attempt, 5_000);
      incCounter("spotify_api_errors_total", {
        endpoint: group,
        method,
        status_code: String(res.status),
        code,
      });
      const expected = isExpectedHttpCondition({
        status: res.status,
        endpointGroup: group,
        method,
        errorCode: code,
      });

      logEvent({
        level: retryable || expected ? "warn" : "error",
        event: "spotify_api_http_error",
        correlationId,
        endpointGroup: group,
        status: res.status,
        durationMs,
        errorCode: code,
        errorMessage: text.slice(0, 256),
        data: { attempt, retryAfterMs },
      });

      if (retryable && attempt < maxAttempts) {
        const waitMs =
          retryAfterMs != null
            ? waitWithRetryAfterJitter(retryWaitMs)
            : jitterMs(retryWaitMs);
        if (res.status === 429) {
          recordSpotifyRateLimitBackoff(waitMs);
        }
        incCounter("spotify_api_retries_total", {
          endpoint: group,
          reason: code,
        });
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      if (res.status === 429) {
        recordSpotifyRateLimitBackoff(retryWaitMs);
      }

      throw new SpotifyApiError({
        status: res.status,
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
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new SpotifyApiError({
    status: 0,
    code: "RETRY_EXHAUSTED",
    correlationId,
    retryable: false,
  });
}
