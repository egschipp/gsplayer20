type CacheState = "hit" | "miss" | "coalesced" | "stale";

type CacheEntry<T> = {
  value: T;
  freshUntil: number;
  staleUntil: number;
  updatedAt: number;
};

type CacheMaps = {
  entries: Map<string, CacheEntry<unknown>>;
  inflight: Map<string, Promise<unknown>>;
  lastCleanupAt: number;
};

const cacheState: CacheMaps = {
  entries: new Map<string, CacheEntry<unknown>>(),
  inflight: new Map<string, Promise<unknown>>(),
  lastCleanupAt: 0,
};

const CLEANUP_INTERVAL_MS = 60_000;

function setEntry<T>(key: string, value: T, ttlMs: number, staleMs: number) {
  const now = Date.now();
  const safeTtl = Math.max(1_000, Math.floor(ttlMs));
  const safeStale = Math.max(safeTtl, Math.floor(staleMs));
  cacheState.entries.set(key, {
    value,
    freshUntil: now + safeTtl,
    staleUntil: now + safeStale,
    updatedAt: now,
  });
}

function cleanupExpired(now = Date.now()) {
  if (now - cacheState.lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  cacheState.lastCleanupAt = now;
  for (const [key, entry] of cacheState.entries) {
    if (entry.staleUntil <= now) {
      cacheState.entries.delete(key);
    }
  }
}

async function runLoaderWithInflight<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs: number,
  staleMs: number
) {
  const existing = cacheState.inflight.get(key);
  if (existing) {
    const value = (await existing) as T;
    return { value, cacheState: "coalesced" as CacheState };
  }

  const promise = loader();
  cacheState.inflight.set(key, promise as Promise<unknown>);
  try {
    const value = await promise;
    setEntry(key, value, ttlMs, staleMs);
    return { value, cacheState: "miss" as CacheState };
  } finally {
    cacheState.inflight.delete(key);
  }
}

function scheduleBackgroundRefresh<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs: number,
  staleMs: number
) {
  if (cacheState.inflight.has(key)) return;
  const promise = loader();
  cacheState.inflight.set(key, promise as Promise<unknown>);
  void promise
    .then((value) => {
      setEntry(key, value, ttlMs, staleMs);
    })
    .catch(() => undefined)
    .finally(() => {
      cacheState.inflight.delete(key);
    });
}

export async function getCachedValue<T>(args: {
  key: string;
  ttlMs: number;
  staleMs: number;
  forceRefresh?: boolean;
  loader: () => Promise<T>;
}) {
  const { key, ttlMs, staleMs, loader, forceRefresh = false } = args;
  cleanupExpired();
  const now = Date.now();
  const entry = cacheState.entries.get(key) as CacheEntry<T> | undefined;
  const existingInflight = cacheState.inflight.get(key);

  if (!forceRefresh && entry && now < entry.freshUntil) {
    return { value: entry.value, cacheState: "hit" as CacheState };
  }

  if (!forceRefresh && existingInflight) {
    const value = (await existingInflight) as T;
    return { value, cacheState: "coalesced" as CacheState };
  }

  if (!forceRefresh && entry && now < entry.staleUntil) {
    scheduleBackgroundRefresh(key, loader, ttlMs, staleMs);
    return { value: entry.value, cacheState: "stale" as CacheState };
  }

  try {
    return await runLoaderWithInflight(key, loader, ttlMs, staleMs);
  } catch (error) {
    if (!forceRefresh && entry && now < entry.staleUntil) {
      return { value: entry.value, cacheState: "stale" as CacheState };
    }
    throw error;
  }
}

export function getRecommendationsCacheSize() {
  cleanupExpired();
  return {
    entries: cacheState.entries.size,
    inflight: cacheState.inflight.size,
  };
}
