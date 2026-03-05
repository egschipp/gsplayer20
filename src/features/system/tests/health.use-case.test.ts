import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHealth } from "../domain/health.use-case";

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

test("health use-case reports healthy payload when required env and probe are valid", async () => {
  await withEnv(
    {
      AUTH_SECRET: "secret",
      APP_PIN: "1234",
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
      SPOTIFY_CLIENT_ID: "spotify-client-id",
      SPOTIFY_CLIENT_SECRET: "spotify-client-secret",
    },
    async () => {
      const result = evaluateHealth({
        probe: {
          dbOk: true,
          workerStatus: "OK",
        },
        now: 123,
      });

      assert.deepEqual(result, {
        ok: true,
        missing: [],
        db: "OK",
        worker: "OK",
        now: 123,
      });
    }
  );
});

test("health use-case reports missing env and db failure", async () => {
  await withEnv(
    {
      AUTH_SECRET: undefined,
      NEXTAUTH_SECRET: undefined,
      APP_PIN: undefined,
      PIN_CODE: undefined,
      TOKEN_ENCRYPTION_KEY: "invalid-base64",
      SPOTIFY_CLIENT_ID: undefined,
      SPOTIFY_CLIENT_SECRET: undefined,
    },
    async () => {
      const result = evaluateHealth({
        probe: {
          dbOk: false,
          workerStatus: "UNKNOWN",
        },
        now: 456,
      });

      assert.equal(result.ok, false);
      assert.equal(result.db, "ERROR");
      assert.equal(result.worker, "UNKNOWN");
      assert.equal(result.now, 456);
      assert.deepEqual(
        result.missing,
        [
          "AUTH_SECRET/NEXTAUTH_SECRET",
          "APP_PIN/PIN_CODE",
          "SPOTIFY_CLIENT_ID",
          "SPOTIFY_CLIENT_SECRET",
          "TOKEN_ENCRYPTION_KEY_INVALID_LENGTH",
        ]
      );
    }
  );
});
