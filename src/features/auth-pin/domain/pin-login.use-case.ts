import { createPinSessionToken } from "./pin-session-token";
import type {
  PinLockRepository,
  PinLoginUseCaseInput,
  PinLoginUseCaseResult,
} from "../types/pin-auth.types";

export async function executePinLoginUseCase(
  input: PinLoginUseCaseInput,
  deps: {
    pinLockRepository: PinLockRepository;
  }
): Promise<PinLoginUseCaseResult> {
  const lock = await deps.pinLockRepository.getLock(input.ipKey);
  if (lock.locked) {
    return {
      ok: false,
      code: "PIN_LOCKED",
      retryAfterSec: lock.retryAfterSec,
    };
  }

  if (!input.secret || !input.expectedPin) {
    return {
      ok: false,
      code: "MISCONFIGURED",
    };
  }

  if (!input.pin || input.pin !== input.expectedPin) {
    await deps.pinLockRepository.recordFailure(input.ipKey);
    return {
      ok: false,
      code: "INVALID_PIN",
    };
  }

  await deps.pinLockRepository.clear(input.ipKey);

  return {
    ok: true,
    token: createPinSessionToken({
      secret: input.secret,
      userAgent: input.userAgent,
    }),
  };
}
