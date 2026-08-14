import { z } from "zod";

const RuntimeEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).optional(),
  AUTH_SECRET: z.string().trim().min(1).optional(),
  NEXTAUTH_SECRET: z.string().trim().min(1).optional(),
  APP_PIN: z.string().trim().min(1).optional(),
  PIN_CODE: z.string().trim().min(1).optional(),
  TOKEN_ENCRYPTION_KEY: z.string().trim().optional(),
  SPOTIFY_CLIENT_ID: z.string().trim().optional(),
  SPOTIFY_CLIENT_SECRET: z.string().trim().optional(),
  SPOTIFY_REDIRECT_URI: z.string().trim().optional(),
  AUTH_URL: z.string().trim().optional(),
  NEXTAUTH_URL: z.string().trim().optional(),
  UPSTASH_REDIS_REST_URL: z.string().trim().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().trim().optional(),
});

export type RuntimeEnv = z.infer<typeof RuntimeEnvSchema>;

export function readRuntimeEnv(env: NodeJS.ProcessEnv = process.env): RuntimeEnv {
  return RuntimeEnvSchema.parse(env);
}

export function readRuntimeEnvSafe(env: NodeJS.ProcessEnv = process.env) {
  return RuntimeEnvSchema.safeParse(env);
}

export function resolveAuthSecret(env: NodeJS.ProcessEnv = process.env) {
  const secret = env.AUTH_SECRET || env.NEXTAUTH_SECRET;
  const trimmed = String(secret ?? "").trim();
  return trimmed || null;
}

export function resolvePinCode(env: NodeJS.ProcessEnv = process.env) {
  const pin = env.APP_PIN || env.PIN_CODE;
  const trimmed = String(pin ?? "").trim();
  return trimmed || null;
}

export function isValidTokenEncryptionKey(value: string | null | undefined) {
  if (!value) return false;
  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
}

export type SpotifyRedirectConfiguration =
  | { ok: true; redirectUri: string }
  | {
      ok: false;
      code:
        | "AUTH_URL_MISSING"
        | "AUTH_URL_INVALID"
        | "AUTH_URL_REQUIRES_HTTPS"
        | "SPOTIFY_REDIRECT_URI_MISSING"
        | "SPOTIFY_REDIRECT_URI_MISMATCH";
    };

export function checkSpotifyRedirectConfiguration(
  env: NodeJS.ProcessEnv = process.env
): SpotifyRedirectConfiguration {
  const rawBaseUrl = String(env.NEXTAUTH_URL || env.AUTH_URL || "").trim();
  if (!rawBaseUrl) return { ok: false, code: "AUTH_URL_MISSING" };

  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    return { ok: false, code: "AUTH_URL_INVALID" };
  }
  if (env.NODE_ENV === "production" && baseUrl.protocol !== "https:") {
    return { ok: false, code: "AUTH_URL_REQUIRES_HTTPS" };
  }

  const configured = String(env.SPOTIFY_REDIRECT_URI || "").trim();
  if (!configured) return { ok: false, code: "SPOTIFY_REDIRECT_URI_MISSING" };
  const expected = new URL("/api/auth/callback/spotify", baseUrl).toString();
  if (configured !== expected) {
    return { ok: false, code: "SPOTIFY_REDIRECT_URI_MISMATCH" };
  }
  return { ok: true, redirectUri: configured };
}
