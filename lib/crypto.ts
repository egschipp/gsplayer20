import crypto from "crypto";

const DEFAULT_KEY_VERSION = 1;
const STORED_TOKEN_PREFIX = "enc:v";

function parseKey(raw: string, label: string) {
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`${label} must decode to 32 bytes`);
  return key;
}

function keyRing() {
  const keys = new Map<number, Buffer>();
  const configuredRing = String(process.env.TOKEN_ENCRYPTION_KEYS || "").trim();
  for (const entry of configuredRing.split(",").map((value) => value.trim())) {
    if (!entry) continue;
    const separator = entry.indexOf(":");
    const version = Number(entry.slice(0, separator));
    const encoded = entry.slice(separator + 1);
    if (!Number.isInteger(version) || version < 1 || !encoded) {
      throw new Error("TOKEN_ENCRYPTION_KEYS must use version:base64 entries");
    }
    keys.set(version, parseKey(encoded, `TOKEN_ENCRYPTION_KEYS version ${version}`));
  }

  const legacy = process.env.TOKEN_ENCRYPTION_KEY;
  if (legacy && !keys.has(DEFAULT_KEY_VERSION)) {
    keys.set(DEFAULT_KEY_VERSION, parseKey(legacy, "TOKEN_ENCRYPTION_KEY"));
  }
  if (keys.size === 0) throw new Error("Missing TOKEN_ENCRYPTION_KEY(S)");
  return keys;
}

function currentKeyVersion(keys: Map<number, Buffer>) {
  const configured = Number(process.env.TOKEN_ENCRYPTION_KEY_VERSION || "");
  if (Number.isInteger(configured) && keys.has(configured)) return configured;
  return Math.max(...keys.keys());
}

export function encryptToken(plain: string) {
  const keys = keyRing();
  const keyVersion = currentKeyVersion(keys);
  const key = keys.get(keyVersion)!;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]).toString("base64");
  return { payload, keyVersion };
}

export function decryptToken(payload: string, keyVersion = DEFAULT_KEY_VERSION) {
  const key = keyRing().get(keyVersion);
  if (!key) throw new Error(`Missing token encryption key version ${keyVersion}`);
  const data = Buffer.from(payload, "base64");
  if (data.length < 29) throw new Error("Invalid encrypted token payload");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

export function encryptStoredToken(plain: string) {
  const encrypted = encryptToken(plain);
  return `${STORED_TOKEN_PREFIX}${encrypted.keyVersion}:${encrypted.payload}`;
}

export function decryptStoredToken(value: string | null | undefined) {
  if (!value) return null;
  if (!value.startsWith(STORED_TOKEN_PREFIX)) return value;
  const separator = value.indexOf(":", STORED_TOKEN_PREFIX.length);
  const version = Number(value.slice(STORED_TOKEN_PREFIX.length, separator));
  const payload = value.slice(separator + 1);
  if (!Number.isInteger(version) || !payload) throw new Error("Invalid stored token");
  return decryptToken(payload, version);
}
