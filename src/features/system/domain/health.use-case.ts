import {
  isValidTokenEncryptionKey,
  resolveAuthSecret,
  resolvePinCode,
} from "../../../shared/config/env";
import type { HealthPayload, HealthProbe } from "../types/system.types";

export function evaluateHealth(args: {
  probe: HealthProbe;
  now?: number;
}): HealthPayload {
  const missing: string[] = [];

  const authSecret = resolveAuthSecret();
  if (!authSecret) {
    missing.push("AUTH_SECRET/NEXTAUTH_SECRET");
  } else if (Buffer.byteLength(authSecret, "utf8") < 32) {
    missing.push("AUTH_SECRET_TOO_SHORT");
  }

  const pinCode = resolvePinCode();
  if (!pinCode) {
    missing.push("APP_PIN/PIN_CODE");
  } else if (pinCode.length < 6) {
    missing.push("APP_PIN_TOO_SHORT");
  }

  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    missing.push("TOKEN_ENCRYPTION_KEY");
  }

  if (!process.env.SPOTIFY_CLIENT_ID) {
    missing.push("SPOTIFY_CLIENT_ID");
  }

  if (!process.env.SPOTIFY_CLIENT_SECRET) {
    missing.push("SPOTIFY_CLIENT_SECRET");
  }

  if (
    process.env.TOKEN_ENCRYPTION_KEY &&
    !isValidTokenEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY)
  ) {
    missing.push("TOKEN_ENCRYPTION_KEY_INVALID_LENGTH");
  }

  return {
    ok: missing.length === 0 && args.probe.dbOk,
    missing,
    db: args.probe.dbOk ? "OK" : "ERROR",
    worker: args.probe.workerStatus,
    now: args.now ?? Date.now(),
  };
}
