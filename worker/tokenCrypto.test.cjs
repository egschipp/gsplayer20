const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { createTokenCrypto } = require("./tokenCrypto.cjs");

const KEY_V1 = crypto.randomBytes(32).toString("base64");
const KEY_V2 = crypto.randomBytes(32).toString("base64");

test("encrypts with the selected key version and decrypts round trips", () => {
  const tokens = createTokenCrypto({
    legacyKey: KEY_V1,
    keyRingValue: `2:${KEY_V2}`,
    keyVersion: 2,
  });
  const encrypted = tokens.encryptToken("access-token");
  assert.equal(encrypted.version, 2);
  assert.notEqual(encrypted.payload, "access-token");
  assert.equal(tokens.decryptToken(encrypted.payload, encrypted.version), "access-token");

  const stored = tokens.encryptStoredToken("stored-token");
  assert.match(stored, /^enc:v2:/);
  assert.equal(tokens.decryptStoredToken(stored), "stored-token");
});

test("supports legacy plaintext during migration", () => {
  const tokens = createTokenCrypto({ legacyKey: KEY_V1 });
  assert.equal(tokens.decryptStoredToken("legacy-plaintext"), "legacy-plaintext");
  assert.equal(tokens.decryptStoredToken(null), null);
});

test("falls back to the newest available key version", () => {
  const tokens = createTokenCrypto({
    keyRingValue: `1:${KEY_V1},2:${KEY_V2}`,
    keyVersion: 99,
  });
  assert.equal(tokens.encryptToken("token").version, 2);
});

test("rejects missing, malformed and incorrectly sized keys", () => {
  assert.throws(() => createTokenCrypto({}), /Missing TOKEN_ENCRYPTION_KEY/);
  assert.throws(
    () => createTokenCrypto({ keyRingValue: "invalid" }),
    /Invalid token encryption key ring entry/
  );
  const tokens = createTokenCrypto({
    legacyKey: Buffer.from("short").toString("base64"),
  });
  assert.throws(() => tokens.encryptToken("token"), /must decode to 32 bytes/);
});

test("rejects malformed and tampered encrypted tokens", () => {
  const tokens = createTokenCrypto({ legacyKey: KEY_V1 });
  assert.throws(
    () => tokens.decryptStoredToken("enc:v1:"),
    /Invalid encrypted token format/
  );
  assert.throws(() => tokens.decryptToken("AA==", 1), /Invalid encrypted token payload/);

  const encrypted = tokens.encryptToken("token");
  const tampered = Buffer.from(encrypted.payload, "base64");
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => tokens.decryptToken(tampered.toString("base64"), 1));
});
