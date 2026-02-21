import crypto from "crypto";
import { getSqlite } from "@/lib/db/client";
import { decryptToken, encryptToken } from "@/lib/crypto";
import { refreshAccessToken } from "@/lib/spotify/tokens";
import { incCounter, observeHistogram } from "@/lib/observability/metrics";
import { logEvent } from "@/lib/observability/logger";

const REFRESH_SKEW_MS = 90_000;
const LOCK_TTL_MS = 12_000;
const LOCK_WAIT_TIMEOUT_MS = 4_000;
const LOCK_POLL_MS = 120;

type TokenResult =
  | {
      ok: true;
      accessToken: string;
      accessExpiresAt: number | null;
      scope: string | null;
    }
  | {
      ok: false;
      code:
        | "MISSING_REFRESH_TOKEN"
        | "LOCK_TIMEOUT"
        | "INVALID_GRANT"
        | "REFRESH_FAILED";
      rawError?: string;
    };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyRefreshError(rawError: string): "INVALID_GRANT" | "REFRESH_FAILED" {
  const lower = rawError.toLowerCase();
  if (lower.includes("invalid_grant")) return "INVALID_GRANT";
  return "REFRESH_FAILED";
}

function createLockTableIfNeeded() {
  const db = getSqlite();
  db.prepare(
    `CREATE TABLE IF NOT EXISTS token_refresh_locks (
      user_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`
  ).run();
  db.prepare(
    "CREATE INDEX IF NOT EXISTS token_refresh_locks_expires_idx ON token_refresh_locks(expires_at)"
  ).run();
}

function acquireRefreshLock(userId: string, ownerId: string) {
  const db = getSqlite();
  const now = Date.now();
  const expiresAt = now + LOCK_TTL_MS;

  db.prepare(
    `INSERT INTO token_refresh_locks (user_id, owner_id, expires_at, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       owner_id=excluded.owner_id,
       expires_at=excluded.expires_at,
       created_at=excluded.created_at
     WHERE token_refresh_locks.expires_at <= ? OR token_refresh_locks.owner_id = ?`
  ).run(userId, ownerId, expiresAt, now, now, ownerId);

  const row = db
    .prepare("SELECT owner_id, expires_at FROM token_refresh_locks WHERE user_id=?")
    .get(userId) as { owner_id?: string; expires_at?: number } | undefined;

  return Boolean(row?.owner_id === ownerId && Number(row?.expires_at ?? 0) > now);
}

function releaseRefreshLock(userId: string, ownerId: string) {
  const db = getSqlite();
  db.prepare("DELETE FROM token_refresh_locks WHERE user_id=? AND owner_id=?").run(
    userId,
    ownerId
  );
}

function getOauthRow(userId: string) {
  const db = getSqlite();
  return db
    .prepare(
      "SELECT refresh_token_enc, access_token, access_expires_at, scope FROM oauth_tokens WHERE user_id=?"
    )
    .get(userId) as
    | {
        refresh_token_enc: string;
        access_token: string | null;
        access_expires_at: number | null;
        scope: string | null;
      }
    | undefined;
}

function storeOauthRow(args: {
  userId: string;
  refreshToken: string;
  accessToken: string;
  accessExpiresAt: number;
  scope: string | null;
}) {
  const db = getSqlite();
  const encrypted = encryptToken(args.refreshToken);
  db.prepare(
    `UPDATE oauth_tokens
      SET refresh_token_enc=?,
          access_token=?,
          access_expires_at=?,
          scope=?,
          enc_key_version=?,
          updated_at=?
      WHERE user_id=?`
  ).run(
    encrypted.payload,
    args.accessToken,
    args.accessExpiresAt,
    args.scope,
    encrypted.keyVersion,
    Date.now(),
    args.userId
  );
}

function clearOauthRow(userId: string) {
  const db = getSqlite();
  db.prepare("DELETE FROM oauth_tokens WHERE user_id=?").run(userId);
}

function accessTokenStillValid(
  accessToken: string | null,
  accessExpiresAt: number | null
): accessToken is string {
  if (!accessToken || !accessExpiresAt) return false;
  return accessExpiresAt - REFRESH_SKEW_MS > Date.now();
}

export async function getValidAccessTokenForUser(args: {
  userId: string;
  correlationId?: string;
  forceRefresh?: boolean;
}): Promise<TokenResult> {
  createLockTableIfNeeded();
  const correlationId = args.correlationId || crypto.randomUUID();

  let row = getOauthRow(args.userId);
  if (!row) {
    return { ok: false, code: "MISSING_REFRESH_TOKEN" };
  }

  if (
    !args.forceRefresh &&
    accessTokenStillValid(row.access_token, row.access_expires_at)
  ) {
    return {
      ok: true,
      accessToken: row.access_token,
      accessExpiresAt: row.access_expires_at,
      scope: row.scope,
    };
  }

  const ownerId = crypto.randomUUID();
  const lockWaitStarted = Date.now();
  while (!acquireRefreshLock(args.userId, ownerId)) {
    if (Date.now() - lockWaitStarted > LOCK_WAIT_TIMEOUT_MS) {
      incCounter("spotify_token_refresh_total", { outcome: "lock_timeout" });
      return { ok: false, code: "LOCK_TIMEOUT" };
    }
    await sleep(LOCK_POLL_MS);
  }

  observeHistogram(
    "spotify_refresh_lock_wait_ms",
    Date.now() - lockWaitStarted,
    { source: "token_manager" }
  );

  try {
    row = getOauthRow(args.userId);
    if (!row) {
      return { ok: false, code: "MISSING_REFRESH_TOKEN" };
    }

    if (
      !args.forceRefresh &&
      accessTokenStillValid(row.access_token, row.access_expires_at)
    ) {
      return {
        ok: true,
        accessToken: row.access_token,
        accessExpiresAt: row.access_expires_at,
        scope: row.scope,
      };
    }

    const refreshToken = decryptToken(row.refresh_token_enc);
    const started = Date.now();
    const refreshed = await refreshAccessToken({
      refreshToken,
      accessToken: row.access_token ?? undefined,
      accessTokenExpires: row.access_expires_at ?? undefined,
      scope: row.scope ?? undefined,
    });
    observeHistogram("spotify_refresh_latency_ms", Date.now() - started, {
      source: "token_manager",
    });

    if ("error" in refreshed) {
      const code = classifyRefreshError(refreshed.error);
      incCounter("spotify_token_refresh_total", { outcome: code.toLowerCase() });

      if (code === "INVALID_GRANT") {
        clearOauthRow(args.userId);
      }

      logEvent({
        level: "error",
        event: "token_refresh_failed",
        correlationId,
        appUserId: args.userId,
        errorCode: code,
        errorMessage: refreshed.error.slice(0, 256),
      });

      return { ok: false, code, rawError: refreshed.error };
    }

    const nextRefreshToken = refreshed.refreshToken || refreshToken;
    const nextAccessToken = String(refreshed.accessToken ?? "");
    const nextExpiresAt =
      Number(refreshed.accessTokenExpires ?? Date.now() + 55 * 60 * 1000) || null;

    if (!nextAccessToken || !nextExpiresAt) {
      incCounter("spotify_token_refresh_total", { outcome: "refresh_failed" });
      return { ok: false, code: "REFRESH_FAILED", rawError: "missing_access_token" };
    }

    storeOauthRow({
      userId: args.userId,
      refreshToken: nextRefreshToken,
      accessToken: nextAccessToken,
      accessExpiresAt: nextExpiresAt,
      scope: (refreshed.scope as string | undefined) ?? row.scope,
    });

    incCounter("spotify_token_refresh_total", { outcome: "success" });

    return {
      ok: true,
      accessToken: nextAccessToken,
      accessExpiresAt: nextExpiresAt,
      scope: (refreshed.scope as string | undefined) ?? row.scope,
    };
  } finally {
    releaseRefreshLock(args.userId, ownerId);
  }
}

