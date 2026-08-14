import { getSqlite } from "@/lib/db/client";

const WINDOW_MS = 30_000;

function configuredLimit(): number {
  const raw = Number(process.env.SPOTIFY_APP_REQUESTS_PER_30S || "90");
  return Number.isFinite(raw) ? Math.max(10, Math.floor(raw)) : 90;
}

export function reserveSharedSpotifyRequest(args: {
  source: "foreground" | "default" | "background";
  now?: number;
}): { allowed: true } | { allowed: false; retryAfterMs: number; reason: string } {
  const sqlite = getSqlite();
  const now = args.now ?? Date.now();
  const limit = configuredLimit();
  const sourceLimit =
    args.source === "background" ? Math.max(1, Math.floor(limit * 0.65)) : limit;

  return sqlite.transaction(() => {
    const state = sqlite
      .prepare("SELECT blocked_until, reason FROM spotify_rate_state WHERE id=1")
      .get() as { blocked_until?: number; reason?: string | null } | undefined;
    const blockedUntil = Number(state?.blocked_until || 0);
    if (blockedUntil > now) {
      return {
        allowed: false as const,
        retryAfterMs: blockedUntil - now,
        reason: state?.reason || "SPOTIFY_SHARED_BACKOFF",
      };
    }

    sqlite
      .prepare("DELETE FROM spotify_request_events WHERE requested_at <= ?")
      .run(now - WINDOW_MS);
    const countRow = sqlite
      .prepare(
        "SELECT count(*) AS count, min(requested_at) AS oldest FROM spotify_request_events"
      )
      .get() as { count?: number; oldest?: number | null };
    const count = Number(countRow?.count || 0);
    if (count >= sourceLimit) {
      const oldest = Number(countRow?.oldest || now);
      return {
        allowed: false as const,
        retryAfterMs: Math.max(1_000, oldest + WINDOW_MS - now),
        reason: "SPOTIFY_SHARED_BUDGET",
      };
    }
    sqlite
      .prepare("INSERT INTO spotify_request_events (requested_at, source) VALUES (?, ?)")
      .run(now, args.source);
    return { allowed: true as const };
  })();
}

export function blockSharedSpotifyRequests(args: {
  retryAfterMs: number;
  reason: string;
  now?: number;
}): void {
  const sqlite = getSqlite();
  const now = args.now ?? Date.now();
  const blockedUntil = now + Math.max(1_000, Math.floor(args.retryAfterMs));
  sqlite
    .prepare(
      `INSERT INTO spotify_rate_state (id, blocked_until, reason, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         blocked_until=max(spotify_rate_state.blocked_until, excluded.blocked_until),
         reason=excluded.reason,
         updated_at=excluded.updated_at`
    )
    .run(blockedUntil, args.reason.slice(0, 64), now);
}
