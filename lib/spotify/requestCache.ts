type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

type InflightEntry<T> = {
  promise: Promise<T>;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, InflightEntry<unknown>>();
let lastCleanupAt = 0;

const CLEANUP_INTERVAL_MS = 10_000;

function cleanup(now = Date.now()) {
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;

  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }

  for (const [key, entry] of inflight.entries()) {
    if (entry.expiresAt <= now) {
      inflight.delete(key);
    }
  }
}

export function getCachedValue<T>(key: string, now = Date.now()): T | null {
  cleanup(now);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  return entry.value as T;
}

export function setCachedValue<T>(key: string, value: T, ttlMs: number, now = Date.now()): void {
  cleanup(now);
  const normalizedTtl = Math.max(1, Math.floor(ttlMs));
  cache.set(key, { value, expiresAt: now + normalizedTtl });
}

export async function coalesceInflight<T>(
  key: string,
  dedupeWindowMs: number,
  factory: () => Promise<T>
): Promise<T> {
  cleanup();
  const existing = inflight.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    return existing.promise as Promise<T>;
  }

  const ttl = Math.max(1, Math.floor(dedupeWindowMs));
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
