type SpotifyRateLimitState = {
  backoffUntilTs: number;
  lastRetryAfterMs: number;
  lastTriggeredAt: number;
  retryAfterSamplesMs: number[];
};

const RETRY_AFTER_SAMPLE_LIMIT = 12;
const MAX_RECORDED_BACKOFF_MS = Number(
  process.env.SPOTIFY_RETRY_AFTER_MAX_MS || "120000"
);

const state: SpotifyRateLimitState = {
  backoffUntilTs: 0,
  lastRetryAfterMs: 0,
  lastTriggeredAt: 0,
  retryAfterSamplesMs: [],
};

function normalizeBackoffMs(value: number): number {
  if (!Number.isFinite(value)) return 1000;
  return Math.max(1000, Math.min(MAX_RECORDED_BACKOFF_MS, Math.floor(value)));
}

export function recordSpotifyRateLimitBackoff(retryAfterMs: number, now = Date.now()): void {
  const waitMs = normalizeBackoffMs(retryAfterMs);
  const until = now + waitMs;
  state.backoffUntilTs = Math.max(state.backoffUntilTs, until);
  state.lastRetryAfterMs = waitMs;
  state.lastTriggeredAt = now;

  state.retryAfterSamplesMs.unshift(waitMs);
  if (state.retryAfterSamplesMs.length > RETRY_AFTER_SAMPLE_LIMIT) {
    state.retryAfterSamplesMs.length = RETRY_AFTER_SAMPLE_LIMIT;
  }
}

export function getSpotifyRateLimitSnapshot(now = Date.now()) {
  if (state.backoffUntilTs > now + MAX_RECORDED_BACKOFF_MS) {
    state.backoffUntilTs = now + MAX_RECORDED_BACKOFF_MS;
  }
  const backoffRemainingMs = Math.max(0, state.backoffUntilTs - now);
  const backoffState =
    backoffRemainingMs > 0 ? "backoff_active" : state.lastTriggeredAt > 0 ? "cooldown" : "normal";

  return {
    backoffState,
    backoffRemainingMs,
    backoffUntilTs: state.backoffUntilTs > 0 ? state.backoffUntilTs : null,
    lastRetryAfterMs: state.lastRetryAfterMs > 0 ? state.lastRetryAfterMs : null,
    lastTriggeredAt: state.lastTriggeredAt > 0 ? state.lastTriggeredAt : null,
    retryAfterObservationsSec: state.retryAfterSamplesMs.map((ms) =>
      Number((ms / 1000).toFixed(1))
    ),
  };
}
