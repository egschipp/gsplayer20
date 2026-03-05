import test from "node:test";
import assert from "node:assert/strict";
import { executePinLoginUseCase } from "../domain/pin-login.use-case";
import type { PinLockRepository } from "../types/pin-auth.types";

function createRepo(state?: { locked?: boolean; retryAfterSec?: number }) {
  let failures = 0;
  let clears = 0;

  const repo: PinLockRepository = {
    async getLock() {
      return {
        locked: Boolean(state?.locked),
        retryAfterSec: state?.retryAfterSec ?? 0,
      };
    },
    async recordFailure() {
      failures += 1;
    },
    async clear() {
      clears += 1;
    },
  };

  return {
    repo,
    get failures() {
      return failures;
    },
    get clears() {
      return clears;
    },
  };
}

test("returns PIN_LOCKED when lock is active", async () => {
  const deps = createRepo({ locked: true, retryAfterSec: 11 });
  const result = await executePinLoginUseCase(
    {
      pin: "1234",
      ipKey: "ip-locked",
      userAgent: "test-agent",
      secret: "secret",
      expectedPin: "1234",
    },
    {
      pinLockRepository: deps.repo,
    }
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "PIN_LOCKED");
    assert.equal(result.retryAfterSec, 11);
  }
  assert.equal(deps.failures, 0);
  assert.equal(deps.clears, 0);
});

test("returns MISCONFIGURED when secret or expected pin is missing", async () => {
  const deps = createRepo();
  const result = await executePinLoginUseCase(
    {
      pin: "1234",
      ipKey: "ip-misconfigured",
      userAgent: "test-agent",
      secret: null,
      expectedPin: "1234",
    },
    {
      pinLockRepository: deps.repo,
    }
  );

  assert.deepEqual(result, {
    ok: false,
    code: "MISCONFIGURED",
  });
  assert.equal(deps.failures, 0);
  assert.equal(deps.clears, 0);
});

test("returns INVALID_PIN and records failure", async () => {
  const deps = createRepo();
  const result = await executePinLoginUseCase(
    {
      pin: "0000",
      ipKey: "ip-invalid",
      userAgent: "test-agent",
      secret: "secret",
      expectedPin: "1234",
    },
    {
      pinLockRepository: deps.repo,
    }
  );

  assert.deepEqual(result, {
    ok: false,
    code: "INVALID_PIN",
  });
  assert.equal(deps.failures, 1);
  assert.equal(deps.clears, 0);
});

test("returns token and clears lock on successful login", async () => {
  const deps = createRepo();
  const result = await executePinLoginUseCase(
    {
      pin: "1234",
      ipKey: "ip-success",
      userAgent: "test-agent",
      secret: "secret",
      expectedPin: "1234",
    },
    {
      pinLockRepository: deps.repo,
    }
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  }
  assert.equal(deps.failures, 0);
  assert.equal(deps.clears, 1);
});
