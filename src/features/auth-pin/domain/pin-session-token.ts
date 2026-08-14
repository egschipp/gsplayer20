import crypto from "crypto";
import { PIN_COOKIE_MAX_AGE_SEC } from "../types/pin-auth.types";

function base64Url(input: Buffer) {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sha256(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function sign(payload: string, secret: string) {
  const sig = crypto.createHmac("sha256", secret).update(payload).digest();
  return base64Url(sig);
}

const PIN_SESSION_MAX_AGE_MS = PIN_COOKIE_MAX_AGE_SEC * 1000;

export function createPinSessionToken(args: {
  secret: string;
  userAgent: string;
  issuedAtMs?: number;
}) {
  const issuedAt = args.issuedAtMs ?? Date.now();
  const payload = JSON.stringify({
    v: 1,
    aud: "gsplayer-pin-session",
    iat: issuedAt,
    exp: issuedAt + PIN_SESSION_MAX_AGE_MS,
    ua: sha256(args.userAgent),
  });

  return `${base64Url(Buffer.from(payload, "utf8"))}.${sign(payload, args.secret)}`;
}
