import test from "node:test";
import assert from "node:assert/strict";
import { runPinLoginAction } from "../actions/pin-login.action";
import type { PinLockRepository } from "../types/pin-auth.types";

const unlockedPinLockRepository: PinLockRepository = {
  async getLock() {
    return {
      locked: false,
      retryAfterSec: 0,
    };
  },
  async recordFailure() {
    return undefined;
  },
  async clear() {
    return undefined;
  },
};

async function withEnv(temp: Partial<NodeJS.ProcessEnv>, fn: () => Promise<void> | void) {
  const previous = new Map<string, string | undefined>();

  for (const key of Object.keys(temp)) {
    previous.set(key, process.env[key]);
    const next = temp[key];
    if (typeof next === "undefined") {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (typeof value === "undefined") {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("pin login action returns MISCONFIGURED when env is incomplete", async () => {
  await withEnv(
    {
      AUTH_SECRET: undefined,
      NEXTAUTH_SECRET: undefined,
      APP_PIN: undefined,
      PIN_CODE: undefined,
    },
    async () => {
      const result = await runPinLoginAction({
        body: { pin: "1234" },
        ipKey: `misconfigured-${Date.now()}`,
        userAgent: "integration-test",
        pinLockRepository: unlockedPinLockRepository,
      });

      assert.deepEqual(result, {
        status: 500,
        body: { error: "MISCONFIGURED" },
      });
    }
  );
});

test("pin login action returns INVALID_PIN for wrong pin", async () => {
  await withEnv(
    {
      AUTH_SECRET: "test-secret",
      APP_PIN: "2468",
    },
    async () => {
      const result = await runPinLoginAction({
        body: { pin: "0000" },
        ipKey: `invalid-${Date.now()}`,
        userAgent: "integration-test",
        pinLockRepository: unlockedPinLockRepository,
      });

      assert.deepEqual(result, {
        status: 401,
        body: { error: "INVALID_PIN" },
      });
    }
  );
});

test("pin login action returns cookie payload on success", async () => {
  await withEnv(
    {
      AUTH_SECRET: "test-secret",
      APP_PIN: "2468",
    },
    async () => {
      const result = await runPinLoginAction({
        body: { pin: "2468" },
        ipKey: `success-${Date.now()}`,
        userAgent: "integration-test",
        pinLockRepository: unlockedPinLockRepository,
      });

      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { ok: true });
      assert.equal("cookie" in result, true);
      if ("cookie" in result) {
        assert.equal(result.cookie.name, "gs_pin");
        assert.match(result.cookie.value, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      }
    }
  );
});
