import { clearPinLock, getPinLock, recordPinFailure } from "@/lib/auth/pinLock";
import type { PinLockRepository } from "@/src/features/auth-pin/types/pin-auth.types";

export const pinLockRepository: PinLockRepository = {
  async getLock(key: string) {
    const state = await getPinLock(key);
    return {
      locked: state.locked,
      retryAfterSec: state.retryAfterSec,
    };
  },
  async recordFailure(key: string) {
    await recordPinFailure(key);
  },
  async clear(key: string) {
    await clearPinLock(key);
  },
};
