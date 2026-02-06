import { Redis } from "@upstash/redis";

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();
let lastCleanupAt = 0;

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
let redis: Redis | null = null;

function getRedis() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  if (!redis) {
    redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
  }
  return redis;
}

function cleanupExpired(now: number) {
  if (now - lastCleanupAt < 60_000) return;
  lastCleanupAt = now;
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(key);
  }
}

export async function rateLimit(key: string, limit = 60, windowMs = 60_000) {
  const now = Date.now();
  const client = getRedis();

  if (client) {
    const windowId = Math.floor(now / windowMs);
    const redisKey = `rl:${key}:${windowId}`;
    const pipeline = client.pipeline();
    pipeline.incr(redisKey);
    pipeline.pttl(redisKey);
    const [countRaw, ttlRaw] = (await pipeline.exec()) as [number, number];
    const count = Number(countRaw ?? 0);
    const ttl = Number(ttlRaw ?? -1);
    if (count === 1) {
      await client.pexpire(redisKey, windowMs);
    }
    const resetAt = now + (ttl > 0 ? ttl : windowMs);
    if (count > limit) {
      return { allowed: false, remaining: 0, resetAt };
    }
    return { allowed: true, remaining: Math.max(limit - count, 0), resetAt };
  }

  cleanupExpired(now);
  const bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, resetAt: now + windowMs };
  }

  if (bucket.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
  }

  bucket.count += 1;
  return { allowed: true, remaining: limit - bucket.count, resetAt: bucket.resetAt };
}
