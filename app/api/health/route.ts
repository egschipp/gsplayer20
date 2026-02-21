import { getSqlite } from "@/lib/db/client";

export const runtime = "nodejs";

export async function GET() {
  const missing: string[] = [];
  if (!process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET) {
    missing.push("AUTH_SECRET/NEXTAUTH_SECRET");
  }
  if (!process.env.APP_PIN && !process.env.PIN_CODE) {
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

  if (process.env.TOKEN_ENCRYPTION_KEY) {
    try {
      const decoded = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, "base64");
      if (decoded.length !== 32) {
        missing.push("TOKEN_ENCRYPTION_KEY_INVALID_LENGTH");
      }
    } catch {
      missing.push("TOKEN_ENCRYPTION_KEY_INVALID_BASE64");
    }
  }

  let dbOk = false;
  let workerStatus = "UNKNOWN";
  try {
    const sqlite = getSqlite();
    sqlite.prepare("SELECT 1").get();
    dbOk = true;
    const heartbeat = sqlite
      .prepare("SELECT updated_at FROM worker_heartbeat WHERE id='worker'")
      .get() as { updated_at?: number } | undefined;
    const staleAfterMs = 30_000;
    if (!heartbeat?.updated_at) {
      workerStatus = "MISSING";
    } else if (Date.now() - heartbeat.updated_at > staleAfterMs) {
      workerStatus = "STALE";
    } else {
      workerStatus = "OK";
    }
  } catch {
    dbOk = false;
    workerStatus = "UNKNOWN";
  }

  const ok = missing.length === 0 && dbOk;

  const payload = {
    ok,
    missing,
    db: dbOk ? "OK" : "ERROR",
    worker: workerStatus,
    now: Date.now(),
  };

  if (missing.length) {
    return Response.json(payload, { status: 500 });
  }

  if (!dbOk) {
    return Response.json(payload, { status: 500 });
  }

  return Response.json(payload, { status: 200 });
}
