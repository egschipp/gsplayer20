import { incCounter, observeHistogram } from "@/lib/observability/metrics";
import { logEvent } from "@/lib/observability/logger";
import type { SpotifyRequestPolicy } from "@/lib/spotify/requestPolicy";

type ManagedCacheEntry<T> = {
  value: T;
  freshUntil: number;
  staleUntil: number;
};

type ExecuteArgs<T> = {
  key: string;
  method: string;
  endpointGroup: string;
  policy: SpotifyRequestPolicy;
  correlationId: string;
  execute: () => Promise<T>;
};

const CACHE_MAX_ENTRIES = Number(process.env.SPOTIFY_REQUEST_CACHE_MAX_ENTRIES || "2000");
const CIRCUIT_FAILURE_THRESHOLD = Number(
  process.env.SPOTIFY_CIRCUIT_OPEN_THRESHOLD || "12"
);
const CIRCUIT_WINDOW_MS = Number(process.env.SPOTIFY_CIRCUIT_WINDOW_MS || "60000");
const CIRCUIT_OPEN_MS = Number(process.env.SPOTIFY_CIRCUIT_OPEN_MS || "30000");

const inflight = new Map<string, Promise<unknown>>();
const cache = new Map<string, ManagedCacheEntry<unknown>>();
const failureEvents: number[] = [];
const circuitState = {
  openUntil: 0,
};

function nowMs() {
  return Date.now();
}

function cleanupFailureEvents(now = nowMs()) {
  const cutoff = now - Math.max(5_000, CIRCUIT_WINDOW_MS);
  while (failureEvents.length && failureEvents[0] < cutoff) {
    failureEvents.shift();
  }
}

function recordFailure(now = nowMs()) {
  cleanupFailureEvents(now);
  failureEvents.push(now);
  if (failureEvents.length >= Math.max(1, CIRCUIT_FAILURE_THRESHOLD)) {
    circuitState.openUntil = Math.max(circuitState.openUntil, now + Math.max(5_000, CIRCUIT_OPEN_MS));
  }
}

function recordSuccess(now = nowMs()) {
  cleanupFailureEvents(now);
  if (circuitState.openUntil > 0 && circuitState.openUntil <= now) {
    circuitState.openUntil = 0;
  }
}

function shouldFailFast(policy: SpotifyRequestPolicy, now = nowMs()) {
  if (!policy.circuitBreakerProtected) return false;
  if (now >= circuitState.openUntil) return false;
  // Keep UI critical alive; fail fast non-critical during open circuit.
  return policy.priority !== "ui_critical";
}

function cleanupCache(now = nowMs()) {
  for (const [key, entry] of cache.entries()) {
    if (entry.staleUntil <= now) {
      cache.delete(key);
    }
  }
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const overflow = cache.size - CACHE_MAX_ENTRIES;
  let removed = 0;
  for (const key of cache.keys()) {
    cache.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
}

function getFromCache<T>(key: string, allowStale: boolean) {
  const now = nowMs();
  const entry = cache.get(key) as ManagedCacheEntry<T> | undefined;
  if (!entry) return null;
  if (entry.freshUntil > now) {
    return { value: entry.value, state: "fresh" as const };
  }
  if (allowStale && entry.staleUntil > now) {
    return { value: entry.value, state: "stale" as const };
  }
  cache.delete(key);
  return null;
}

function setCache<T>(key: string, value: T, policy: SpotifyRequestPolicy) {
  if (policy.cacheTtlMs <= 0) return;
  const now = nowMs();
  const fresh = Math.max(50, Math.floor(policy.cacheTtlMs));
  const stale = Math.max(fresh, fresh + Math.max(0, Math.floor(policy.staleWhileRevalidateMs)));
  cache.set(key, {
    value,
    freshUntil: now + fresh,
    staleUntil: now + stale,
  });
  cleanupCache(now);
}

function isRetryableFailure(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const anyErr = error as { status?: number; code?: string };
  if (anyErr.status === 429) return true;
  if (typeof anyErr.status === "number" && anyErr.status >= 500) return true;
  if (anyErr.status === 0) return true;
  return anyErr.code === "NETWORK_TIMEOUT" || anyErr.code === "NETWORK_TRANSIENT";
}

function shouldCoalesce(method: string, policy: SpotifyRequestPolicy) {
  return method === "GET" && policy.requestClass === "read";
}

export async function executeManagedSpotifyRequest<T>(args: ExecuteArgs<T>): Promise<T> {
  const started = nowMs();
  const method = args.method.toUpperCase();
  const coalesce = shouldCoalesce(method, args.policy);
  const cacheKey = args.key;

  if (coalesce) {
    const cached = getFromCache<T>(cacheKey, true);
    if (cached) {
      incCounter("spotify_request_manager_cache_hit_total", {
        endpoint: args.endpointGroup,
        state: cached.state,
      });
      return cached.value;
    }
    const existing = inflight.get(cacheKey);
    if (existing) {
      incCounter("spotify_request_manager_coalesced_total", {
        endpoint: args.endpointGroup,
      });
      return (await existing) as T;
    }
  }

  if (shouldFailFast(args.policy)) {
    incCounter("spotify_request_manager_circuit_failfast_total", {
      endpoint: args.endpointGroup,
      priority: args.policy.priority,
    });
    const retryAfterSec = Math.max(1, Math.ceil((circuitState.openUntil - nowMs()) / 1000));
    const error = new Error("CIRCUIT_OPEN");
    (error as Error & { status: number; code: string; retryAfterMs: number }).name =
      "SpotifyCircuitOpenError";
    (error as Error & { status: number; code: string; retryAfterMs: number }).status = 503;
    (error as Error & { status: number; code: string; retryAfterMs: number }).code =
      "SPOTIFY_CIRCUIT_OPEN";
    (error as Error & { status: number; code: string; retryAfterMs: number }).retryAfterMs =
      retryAfterSec * 1000;
    throw error;
  }

  const run = (async () => {
    try {
      const value = await args.execute();
      recordSuccess();
      setCache(cacheKey, value, args.policy);
      observeHistogram("spotify_request_manager_latency_ms", nowMs() - started, {
        endpoint: args.endpointGroup,
        method,
      });
      return value;
    } catch (error) {
      if (isRetryableFailure(error)) {
        recordFailure();
      }
      logEvent({
        level: "warn",
        event: "spotify_request_manager_error",
        correlationId: args.correlationId,
        endpointGroup: args.endpointGroup,
        errorCode:
          typeof (error as { code?: unknown })?.code === "string"
            ? (error as { code: string }).code
            : "REQUEST_MANAGER_ERROR",
        errorMessage: String((error as Error)?.message ?? error).slice(0, 220),
        data: {
          priority: args.policy.priority,
          method,
        },
      });
      throw error;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  if (coalesce) {
    inflight.set(cacheKey, run as Promise<unknown>);
  }
  return await run;
}

export function getSpotifyRequestManagerSnapshot(now = nowMs()) {
  cleanupCache(now);
  cleanupFailureEvents(now);
  return {
    inflightCount: inflight.size,
    cacheSize: cache.size,
    circuitOpen: circuitState.openUntil > now,
    circuitOpenUntilTs: circuitState.openUntil > now ? circuitState.openUntil : null,
    recentFailures: failureEvents.length,
  };
}

