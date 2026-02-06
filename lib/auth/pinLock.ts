type LockState = {
  fails: number;
  lockedUntil: number;
  lastFailAt: number;
};

const locks = new Map<string, LockState>();
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const RESET_AFTER_MS = 10 * 60_000;

export function getPinLock(key: string) {
  const now = Date.now();
  const state = locks.get(key);
  if (!state) return { locked: false, retryAfterSec: 0 };
  if (now - state.lastFailAt > RESET_AFTER_MS) {
    locks.delete(key);
    return { locked: false, retryAfterSec: 0 };
  }
  if (now < state.lockedUntil) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((state.lockedUntil - now) / 1000)
    );
    return { locked: true, retryAfterSec };
  }
  return { locked: false, retryAfterSec: 0 };
}

export function recordPinFailure(key: string) {
  const now = Date.now();
  const state = locks.get(key);
  const fails = state ? state.fails + 1 : 1;
  const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (fails - 1));
  const lockedUntil = now + backoff;
  locks.set(key, { fails, lockedUntil, lastFailAt: now });
  return { lockedUntil, fails };
}

export function clearPinLock(key: string) {
  locks.delete(key);
}
