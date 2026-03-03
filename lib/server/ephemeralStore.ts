import { Redis } from "@upstash/redis";

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
let redis: Redis | null = null;

type MemoryEntry = {
  value: unknown;
  expiresAt: number;
};

const memoryStore = new Map<string, MemoryEntry>();
let lastMemoryCleanupAt = 0;

function getRedis() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  if (!redis) redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
  return redis;
}

function cleanupMemory(now = Date.now()) {
  if (now - lastMemoryCleanupAt < 15_000) return;
  lastMemoryCleanupAt = now;
  for (const [key, entry] of memoryStore.entries()) {
    if (entry.expiresAt <= now) {
      memoryStore.delete(key);
    }
  }
}

export async function ephemeralGetJson<T>(key: string): Promise<T | null> {
  const client = getRedis();
  if (client) {
    try {
      const value = await client.get(key);
      return (value as T | null) ?? null;
    } catch {
      // fallback below
    }
  }
  cleanupMemory();
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value as T;
}

export async function ephemeralSetJson(
  key: string,
  value: unknown,
  ttlMs: number
): Promise<void> {
  const safeTtlMs = Math.max(1_000, Math.floor(ttlMs));
  const client = getRedis();
  if (client) {
    try {
      await client.set(key, value, { px: safeTtlMs });
      return;
    } catch {
      // fallback below
    }
  }
  cleanupMemory();
  memoryStore.set(key, {
    value,
    expiresAt: Date.now() + safeTtlMs,
  });
}

export async function ephemeralDelete(key: string): Promise<void> {
  const client = getRedis();
  if (client) {
    try {
      await client.del(key);
      return;
    } catch {
      // fallback below
    }
  }
  memoryStore.delete(key);
}

export async function ephemeralIncrWithTtl(key: string, ttlMs: number): Promise<number> {
  const safeTtlMs = Math.max(1_000, Math.floor(ttlMs));
  const client = getRedis();
  if (client) {
    try {
      const pipeline = client.pipeline();
      pipeline.incr(key);
      pipeline.pttl(key);
      const [countRaw, ttlRaw] = (await pipeline.exec()) as [number, number];
      const count = Number(countRaw ?? 0);
      const ttl = Number(ttlRaw ?? -1);
      if (count === 1 || ttl < 0) {
        await client.pexpire(key, safeTtlMs);
      }
      return count;
    } catch {
      // fallback below
    }
  }
  cleanupMemory();
  const now = Date.now();
  const entry = memoryStore.get(key);
  const current =
    entry && entry.expiresAt > now && typeof entry.value === "number"
      ? Number(entry.value)
      : 0;
  const next = current + 1;
  memoryStore.set(key, { value: next, expiresAt: now + safeTtlMs });
  return next;
}

export async function ephemeralDecr(key: string): Promise<number> {
  const client = getRedis();
  if (client) {
    try {
      const next = await client.decr(key);
      if (Number(next) <= 0) {
        await client.del(key);
        return 0;
      }
      return Number(next);
    } catch {
      // fallback below
    }
  }
  cleanupMemory();
  const entry = memoryStore.get(key);
  if (!entry || entry.expiresAt <= Date.now() || typeof entry.value !== "number") {
    memoryStore.delete(key);
    return 0;
  }
  const next = Math.max(0, Number(entry.value) - 1);
  if (next <= 0) {
    memoryStore.delete(key);
    return 0;
  }
  memoryStore.set(key, { ...entry, value: next });
  return next;
}

