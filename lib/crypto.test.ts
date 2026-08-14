import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";

test("stored OAuth tokens are encrypted and round-trip", async () => {
  process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  process.env.TOKEN_ENCRYPTION_KEY_VERSION = "1";
  const { decryptStoredToken, encryptStoredToken } = await import("./crypto");
  const plaintext = "spotify-secret-token";
  const encrypted = encryptStoredToken(plaintext);
  assert.notEqual(encrypted, plaintext);
  assert.match(encrypted, /^enc:v1:/);
  assert.equal(decryptStoredToken(encrypted), plaintext);
});

test("legacy plaintext access tokens remain readable during migration", async () => {
  const { decryptStoredToken } = await import("./crypto");
  assert.equal(decryptStoredToken("legacy-token"), "legacy-token");
});
