import { incCounter, observeHistogram } from "@/lib/observability/metrics";
import { logEvent } from "@/lib/observability/logger";
import { createCorrelationId } from "@/lib/observability/correlation";

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

function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after") || res.headers.get("Retry-After");
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 1000);
}

function classifyCode(status: number, body: string): string {
  const lower = body.toLowerCase();
  if (status === 401) {
    if (lower.includes("invalid_grant")) return "INVALID_GRANT";
    return "UNAUTHENTICATED";
  }
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMIT";
  if (status >= 500) return "SPOTIFY_UPSTREAM";
  return "SPOTIFY_REQUEST_FAILED";
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
      const code = classifyCode(res.status, text);
      const retryable = shouldRetryStatus(res.status);

      logEvent({
        level: retryable ? "warn" : "error",
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
        incCounter("spotify_api_retries_total", {
          endpoint: group,
          reason: code,
        });
        const base = retryAfterMs ?? Math.min(500 * attempt * attempt, 5_000);
        await new Promise((resolve) => setTimeout(resolve, jitterMs(base)));
        continue;
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
      const durationMs = Date.now() - started;
      const isAbort = error instanceof DOMException && error.name === "AbortError";
      const message = String((error as Error)?.message ?? error);
      const retryable =
        isAbort ||
        message.toLowerCase().includes("fetch") ||
        message.toLowerCase().includes("network") ||
        message.toLowerCase().includes("timeout");

      logEvent({
        level: retryable ? "warn" : "error",
        event: "spotify_api_network_error",
        correlationId,
        endpointGroup: group,
        durationMs,
        errorCode: retryable ? "NETWORK_TRANSIENT" : "NETWORK_FATAL",
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

      if (error instanceof SpotifyApiError) {
        throw error;
      }
      throw new SpotifyApiError({
        status: 0,
        code: "NETWORK_ERROR",
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
