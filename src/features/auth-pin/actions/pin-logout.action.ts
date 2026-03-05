import { PIN_COOKIE_NAME } from "@/src/features/auth-pin/types/pin-auth.types";

export function runPinLogoutAction() {
  return {
    status: 200 as const,
    body: { ok: true },
    clearCookie: {
      name: PIN_COOKIE_NAME,
    },
  };
}
