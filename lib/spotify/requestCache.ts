import { Redis } from "@upstash/redis";
import { createHash, randomUUID } from "crypto";
import { incCounter, observeHistogram } from "@/lib/observability/metrics";

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  staleUntil: number;
};

type InflightEntry<T> = {
  promise: Promise<T>;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, InflightEntry<unknown>>();
let lastCleanupAt = 0;

const CLEANUP_INTERVAL_MS = 10_000;
const WAIT_POLL_MS = 50;
const CROSS_INSTANCE_WAIT_MAX_MS = 2_500;
const USER_CACHE_VERSION_TTL_MS = 5_000;
const DEFAULT_STALE_RETENTION_MS = Number(
  process.env.SPOTIFY_CACHE_STALE_IF_ERROR_MS || "30000"
);

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
let redis: Redis | null = null;
const userCacheVersion = new Map<string, CacheEntry<number>>();

function getRedis(): Redis | null {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  if (!redis) {
    redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
  }
  return redis;
}

function hashKey(key: string): string {
  return createHash("sha1").update(key).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanup(now = Date.now()) {
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;

  for (const [key, entry] of cache.entries()) {
    if (entry.staleUntil <= now) {
      cache.delete(key);
    }
  }

  for (const [key, entry] of inflight.entries()) {
    if (entry.expiresAt <= now) {
      inflight.delete(key);
    }
  }

  for (const [key, entry] of userCacheVersion.entries()) {
    if (entry.expiresAt <= now) {
      userCacheVersion.delete(key);
    }
  }
}

export function getCachedValue<T>(key: string, now = Date.now()): T | null {
  cleanup(now);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    return null;
  }
  return entry.value as T;
}

export function getCachedStaleValue<T>(
  key: string,
  now = Date.now()
): { value: T; staleByMs: number } | null {
  cleanup(now);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt > now) return null;
  if (entry.staleUntil <= now) {
    cache.delete(key);
    return null;
  }
  return {
    value: entry.value as T,
    staleByMs: Math.max(0, now - entry.expiresAt),
  };
}

export function setCachedValue<T>(
  key: string,
  value: T,
  ttlMs: number,
  now = Date.now(),
  options?: {
    staleTtlMs?: number;
  }
): void {
  cleanup(now);
  const normalizedTtl = Math.max(1, Math.floor(ttlMs));
  const staleTtlMsRaw =
    typeof options?.staleTtlMs === "number"
      ? Math.max(0, Math.floor(options.staleTtlMs))
      : Math.max(0, Math.floor(DEFAULT_STALE_RETENTION_MS));
  const expiresAt = now + normalizedTtl;
  const staleUntil = expiresAt + staleTtlMsRaw;
  cache.set(key, { value, expiresAt, staleUntil });
}

function getLocalUserCacheVersion(userKey: string, now = Date.now()): number | null {
  const local = userCacheVersion.get(userKey);
  if (!local) return null;
  if (local.expiresAt <= now) {
    userCacheVersion.delete(userKey);
    return null;
  }
  return local.value;
}

function setLocalUserCacheVersion(
  userKey: string,
  version: number,
  ttlMs = USER_CACHE_VERSION_TTL_MS
): void {
  const expiresAt = Date.now() + Math.max(1_000, Math.floor(ttlMs));
  userCacheVersion.set(userKey, {
    value: Math.max(0, Math.floor(version)),
    expiresAt,
    staleUntil: expiresAt,
  });
}

export async function getUserCacheVersion(userKey: string): Promise<number> {
  const normalizedUserKey = String(userKey || "anonymous");
  const localVersion = getLocalUserCacheVersion(normalizedUserKey);
  if (localVersion != null) return localVersion;

  const client = getRedis();
  if (!client) {
    setLocalUserCacheVersion(normalizedUserKey, 0);
    return 0;
  }

  const key = `spotify:cache:version:${normalizedUserKey}`;
  try {
    const raw = await client.get<number | string>(key);
    const parsed =
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
        ? Number(raw)
        : 0;
    const version = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    setLocalUserCacheVersion(normalizedUserKey, version);
    return version;
  } catch {
    setLocalUserCacheVersion(normalizedUserKey, 0, 1_000);
    return 0;
  }
}

export async function bumpUserCacheVersion(userKey: string): Promise<number> {
  const normalizedUserKey = String(userKey || "anonymous");
  const client = getRedis();
  let nextVersion = (getLocalUserCacheVersion(normalizedUserKey) ?? 0) + 1;

  if (client) {
    const key = `spotify:cache:version:${normalizedUserKey}`;
    try {
      const redisNext = await client.incr(key);
      await client.expire(key, 60 * 60 * 24 * 7);
      const parsed = Number(redisNext);
      if (Number.isFinite(parsed)) {
        nextVersion = Math.max(0, Math.floor(parsed));
      }
    } catch {
      // keep local fallback version
    }
  }

  setLocalUserCacheVersion(normalizedUserKey, nextVersion);
  incCounter("spotify_cache_version_bumps_total", {
    user_scope: normalizedUserKey === "app" ? "app" : "user",
  });
  return nextVersion;
}

export async function coalesceInflight<T>(
  key: string,
  dedupeWindowMs: number,
  factory: () => Promise<T>,
  options?: {
    crossInstance?: boolean;
  }
): Promise<T> {
  cleanup();
  const existing = inflight.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    incCounter("spotify_coalesce_inflight_hits_total", { source: "memory" });
    return existing.promise as Promise<T>;
  }

  const ttl = Math.max(1, Math.floor(dedupeWindowMs));
  const crossInstance = Boolean(options?.crossInstance);
  const redisClient = crossInstance ? getRedis() : null;

  if (redisClient) {
    const hashed = hashKey(key);
    const lockKey = `spotify:coalesce:lock:${hashed}`;
    const resultKey = `spotify:coalesce:result:${hashed}`;
    const owner = randomUUID();
    const cachedRaw = await redisClient.get<string>(resultKey);
    if (typeof cachedRaw === "string" && cachedRaw.length > 0) {
      try {
        incCounter("spotify_coalesce_shared_hits_total", { source: "redis" });
        return JSON.parse(cachedRaw) as T;
      } catch {
        // continue; stale malformed value
      }
    }

    const lockSet = await redisClient.set(lockKey, owner, {
      nx: true,
      px: ttl,
    });
    const hasLock = Boolean(lockSet);
    if (hasLock) {
      try {
        incCounter("spotify_coalesce_lock_owner_total", { outcome: "owner" });
        const value = await factory();
        try {
          await redisClient.set(resultKey, JSON.stringify(value), {
            px: ttl,
          });
        } catch {
          // ignore redis set errors
        }
        return value;
      } finally {
        try {
          const currentOwner = await redisClient.get<string>(lockKey);
          if (currentOwner === owner) {
            await redisClient.del(lockKey);
          }
        } catch {
          // ignore redis lock cleanup errors
        }
      }
    }

    const waitUntil = Date.now() + Math.min(CROSS_INSTANCE_WAIT_MAX_MS, ttl);
    const waitStartedAt = Date.now();
    while (Date.now() < waitUntil) {
      const sharedRaw = await redisClient.get<string>(resultKey);
      if (typeof sharedRaw === "string" && sharedRaw.length > 0) {
        try {
          incCounter("spotify_coalesce_shared_hits_total", { source: "wait" });
          observeHistogram(
            "spotify_coalesce_wait_ms",
            Date.now() - waitStartedAt,
            { outcome: "hit" }
          );
          return JSON.parse(sharedRaw) as T;
        } catch {
          break;
        }
      }
      await sleep(WAIT_POLL_MS);
    }
    observeHistogram("spotify_coalesce_wait_ms", Date.now() - waitStartedAt, {
      outcome: "miss",
    });
  }

  const promise = factory()
    .finally(() => {
      const current = inflight.get(key);
      if (current?.promise === promise) {
        inflight.delete(key);
      }
    });

  inflight.set(key, {
    promise,
    expiresAt: Date.now() + ttl,
  });

  return promise;
}
