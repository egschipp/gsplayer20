import { z } from "zod";
import { executePinLoginUseCase } from "../domain/pin-login.use-case";
import {
  PIN_COOKIE_MAX_AGE_SEC,
  PIN_COOKIE_NAME,
  type PinLockRepository,
  type PinLoginActionResult,
} from "../types/pin-auth.types";
import { resolveAuthSecret, resolvePinCode } from "../../../shared/config/env";

const PinLoginSchema = z
  .object({
    pin: z.string().max(128),
  })
  .passthrough();

function parsePin(body: unknown) {
  const parsed = PinLoginSchema.safeParse(body);
  if (!parsed.success) {
    return "";
  }

  return parsed.data.pin;
}

export async function runPinLoginAction(args: {
  body: unknown;
  ipKey: string;
  userAgent: string;
  pinLockRepository: PinLockRepository;
  authSecret?: string | null;
  expectedPin?: string | null;
}): Promise<PinLoginActionResult> {
  const pin = parsePin(args.body);
  const secret = args.authSecret ?? resolveAuthSecret();
  const expectedPin = args.expectedPin ?? resolvePinCode();

  const result = await executePinLoginUseCase(
    {
      pin,
      ipKey: args.ipKey,
      userAgent: args.userAgent,
      secret,
      expectedPin,
    },
    {
      pinLockRepository: args.pinLockRepository,
    }
  );

  if (!result.ok) {
    if (result.code === "PIN_LOCKED") {
      return {
        status: 429,
        body: {
          error: "PIN_LOCKED",
          retryAfter: result.retryAfterSec,
        },
        retryAfterSec: result.retryAfterSec,
      };
    }

    if (result.code === "MISCONFIGURED") {
      return {
        status: 500,
        body: { error: "MISCONFIGURED" },
      };
    }

    return {
      status: 401,
      body: { error: "INVALID_PIN" },
    };
  }

  return {
    status: 200,
    body: { ok: true },
    cookie: {
      name: PIN_COOKIE_NAME,
      value: result.token,
      maxAgeSec: PIN_COOKIE_MAX_AGE_SEC,
    },
  };
}
