import crypto from "crypto";

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

export function createPinSessionToken(args: {
  secret: string;
  userAgent: string;
  issuedAtMs?: number;
}) {
  const payload = JSON.stringify({
    iat: args.issuedAtMs ?? Date.now(),
    ua: sha256(args.userAgent),
  });

  return `${base64Url(Buffer.from(payload, "utf8"))}.${sign(payload, args.secret)}`;
}
