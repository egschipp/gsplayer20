export const PIN_COOKIE_NAME = "gs_pin";
export const PIN_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30;

export type PinLockState = {
  locked: boolean;
  retryAfterSec: number;
};

export interface PinLockRepository {
  getLock(key: string): Promise<PinLockState>;
  recordFailure(key: string): Promise<void>;
  clear(key: string): Promise<void>;
}

export type PinLoginUseCaseInput = {
  pin: string;
  ipKey: string;
  userAgent: string;
  secret: string | null;
  expectedPin: string | null;
};

export type PinLoginUseCaseResult =
  | { ok: true; token: string }
  | { ok: false; code: "PIN_LOCKED"; retryAfterSec: number }
  | { ok: false; code: "MISCONFIGURED" }
  | { ok: false; code: "INVALID_PIN" };

export type PinLoginActionResult =
  | {
      status: 200;
      body: { ok: true };
      cookie: {
        name: string;
        value: string;
        maxAgeSec: number;
      };
    }
  | {
      status: 401;
      body: { error: "INVALID_PIN" };
    }
  | {
      status: 429;
      body: { error: "PIN_LOCKED"; retryAfter: number };
      retryAfterSec: number;
    }
  | {
      status: 500;
      body: { error: "MISCONFIGURED" };
    };
