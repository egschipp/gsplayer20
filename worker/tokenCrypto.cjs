const crypto = require("node:crypto");

function createTokenCrypto({ legacyKey = "", keyRingValue = "", keyVersion = 1 }) {
  const keyRing = new Map();
  for (const entry of String(keyRingValue)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const match = entry.match(/^(\d+):(.+)$/);
    if (!match) throw new Error("Invalid token encryption key ring entry");
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error("Invalid token encryption key version");
    }
    keyRing.set(version, match[2]);
  }
  if (legacyKey && !keyRing.has(1)) keyRing.set(1, legacyKey);
  if (keyRing.size === 0) throw new Error("Missing TOKEN_ENCRYPTION_KEY(S)");

  function tokenKey(version = 1) {
    const encoded = keyRing.get(Number(version));
    if (!encoded) throw new Error(`Missing token encryption key version ${version}`);
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new Error(`Token encryption key version ${version} must decode to 32 bytes`);
    }
    return key;
  }

  function decryptToken(payload, version = 1) {
    const key = tokenKey(version);
    const data = Buffer.from(payload, "base64");
    if (data.length < 29) throw new Error("Invalid encrypted token payload");
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const encrypted = data.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }

  function encryptToken(value) {
    const requestedVersion = Number(keyVersion);
    const version = keyRing.has(requestedVersion)
      ? requestedVersion
      : Math.max(...keyRing.keys());
    const key = tokenKey(version);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      payload: Buffer.concat([iv, tag, encrypted]).toString("base64"),
      version,
    };
  }

  function encryptStoredToken(value) {
    const encrypted = encryptToken(value);
    return `enc:v${encrypted.version}:${encrypted.payload}`;
  }

  function decryptStoredToken(value) {
    if (!value || !String(value).startsWith("enc:v")) return value;
    const match = String(value).match(/^enc:v(\d+):(.+)$/);
    if (!match) throw new Error("Invalid encrypted token format");
    return decryptToken(match[2], Number(match[1]));
  }

  // Keep the key ring private so callers cannot accidentally log key material.
  return { decryptStoredToken, decryptToken, encryptStoredToken, encryptToken };
}

module.exports = { createTokenCrypto };
