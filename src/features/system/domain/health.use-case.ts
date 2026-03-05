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

  if (!resolveAuthSecret()) {
    missing.push("AUTH_SECRET/NEXTAUTH_SECRET");
  }

  if (!resolvePinCode()) {
    missing.push("APP_PIN/PIN_CODE");
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
