import { Redis } from "@upstash/redis";

type LockState = {
  fails: number;
  lockedUntil: number;
  lastFailAt: number;
};

const locks = new Map<string, LockState>();
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const RESET_AFTER_MS = 10 * 60_000;

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

function redisKey(key: string) {
  return `pin_lock:${key}`;
}

async function getRedisLockState(key: string): Promise<LockState | null> {
  const client = getRedis();
  if (!client) return null;
  const row = await client.hgetall<Record<string, string | number>>(redisKey(key));
  if (!row) return null;
  const fails = Number(row.fails ?? 0);
  const lockedUntil = Number(row.lockedUntil ?? 0);
  const lastFailAt = Number(row.lastFailAt ?? 0);
  if (!Number.isFinite(fails) || !Number.isFinite(lockedUntil) || !Number.isFinite(lastFailAt)) {
    return null;
  }
  return {
    fails,
    lockedUntil,
    lastFailAt,
  };
}

async function setRedisLockState(key: string, state: LockState): Promise<void> {
  const client = getRedis();
  if (!client) return;
  const ttlMs = Math.max(1, state.lockedUntil - Date.now() + RESET_AFTER_MS);
  const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
  const lockKey = redisKey(key);
  await client.hset(lockKey, {
    fails: state.fails,
    lockedUntil: state.lockedUntil,
    lastFailAt: state.lastFailAt,
  });
  await client.expire(lockKey, ttlSec);
}

async function clearRedisLockState(key: string): Promise<void> {
  const client = getRedis();
  if (!client) return;
  await client.del(redisKey(key));
}

function getInMemoryLockState(key: string): LockState | null {
  return locks.get(key) ?? null;
}

function setInMemoryLockState(key: string, state: LockState): void {
  locks.set(key, state);
}

function clearInMemoryLockState(key: string): void {
  locks.delete(key);
}

export async function getPinLock(key: string) {
  const now = Date.now();
  const state = (await getRedisLockState(key)) ?? getInMemoryLockState(key);
  if (!state) return { locked: false, retryAfterSec: 0 };
  if (now - state.lastFailAt > RESET_AFTER_MS) {
    clearInMemoryLockState(key);
    await clearRedisLockState(key);
    return { locked: false, retryAfterSec: 0 };
  }
  if (now < state.lockedUntil) {
    const retryAfterSec = Math.max(1, Math.ceil((state.lockedUntil - now) / 1000));
    return { locked: true, retryAfterSec };
  }
  return { locked: false, retryAfterSec: 0 };
}

export async function recordPinFailure(key: string) {
  const now = Date.now();
  const state = (await getRedisLockState(key)) ?? getInMemoryLockState(key);
  const fails = state ? state.fails + 1 : 1;
  const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (fails - 1));
  const next: LockState = {
    fails,
    lockedUntil: now + backoff,
    lastFailAt: now,
  };
  setInMemoryLockState(key, next);
  await setRedisLockState(key, next);
  return { lockedUntil: next.lockedUntil, fails: next.fails };
}

export async function clearPinLock(key: string) {
  clearInMemoryLockState(key);
  await clearRedisLockState(key);
}
