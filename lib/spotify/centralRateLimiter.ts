import { observeHistogram } from "@/lib/observability/metrics";

type EndpointState = {
  blockedUntil: number;
  inflight: number;
  lastDispatchAt: number;
};

type UserState = {
  blockedUntil: number;
  inflight: number;
  lastDispatchAt: number;
};

type LimiterState = {
  blockedUntil: number;
  inflight: number;
  lastDispatchAt: number;
  consecutive429: number;
  totalAcquires: number;
  totalWaitMs: number;
  endpoints: Map<string, EndpointState>;
  users: Map<string, UserState>;
  inflightByPriority: Record<"ui_critical" | "interactive" | "background", number>;
};

const MAX_BACKOFF_MS = Number(process.env.SPOTIFY_RETRY_AFTER_MAX_MS || "120000");
const GLOBAL_MAX_CONCURRENT = clampInt(process.env.SPOTIFY_GLOBAL_MAX_CONCURRENT, 4, 1, 24);
const ENDPOINT_MAX_CONCURRENT = clampInt(
  process.env.SPOTIFY_ENDPOINT_MAX_CONCURRENT,
  2,
  1,
  12
);
const GLOBAL_MIN_INTERVAL_MS = clampInt(
  process.env.SPOTIFY_GLOBAL_MIN_INTERVAL_MS,
  60,
  0,
  1000
);
const ENDPOINT_MIN_INTERVAL_MS = clampInt(
  process.env.SPOTIFY_ENDPOINT_MIN_INTERVAL_MS,
  140,
  0,
  1500
);
const USER_MAX_CONCURRENT = clampInt(process.env.SPOTIFY_USER_MAX_CONCURRENT, 2, 1, 8);
const USER_MIN_INTERVAL_MS = clampInt(process.env.SPOTIFY_USER_MIN_INTERVAL_MS, 80, 0, 1000);
const BACKGROUND_MAX_CONCURRENT = clampInt(
  process.env.SPOTIFY_BACKGROUND_MAX_CONCURRENT,
  1,
  1,
  6
);
const DEFAULT_429_BACKOFF_MS = clampInt(
  process.env.SPOTIFY_DEFAULT_429_BACKOFF_MS,
  8_000,
  1_000,
  MAX_BACKOFF_MS
);

const state: LimiterState = {
  blockedUntil: 0,
  inflight: 0,
  lastDispatchAt: 0,
  consecutive429: 0,
  totalAcquires: 0,
  totalWaitMs: 0,
  endpoints: new Map<string, EndpointState>(),
  users: new Map<string, UserState>(),
  inflightByPriority: {
    ui_critical: 0,
    interactive: 0,
    background: 0,
  },
};

function clampInt(
  valueRaw: string | number | undefined,
  fallback: number,
  min: number,
  max: number
) {
  const value = Number(valueRaw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeWaitMs(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeBackoffMs(value: number | null | undefined) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return DEFAULT_429_BACKOFF_MS;
  return Math.max(1_000, Math.min(MAX_BACKOFF_MS, Math.floor(Number(value))));
}

function wait(ms: number) {
  const safe = Math.max(5, Math.min(1000, Math.floor(ms)));
  return new Promise<void>((resolve) => setTimeout(resolve, safe));
}

function getEndpointState(endpoint: string) {
  const key = endpoint || "unknown";
  let entry = state.endpoints.get(key);
  if (!entry) {
    entry = {
      blockedUntil: 0,
      inflight: 0,
      lastDispatchAt: 0,
    };
    state.endpoints.set(key, entry);
  }
  return entry;
}

function cleanupEndpointStates(now = Date.now()) {
  for (const [key, entry] of state.endpoints.entries()) {
    const inactive =
      entry.inflight <= 0 &&
      entry.blockedUntil < now - 60_000 &&
      entry.lastDispatchAt < now - 300_000;
    if (inactive) {
      state.endpoints.delete(key);
    }
  }
}

function getUserState(userKey: string) {
  const key = userKey || "anonymous";
  let entry = state.users.get(key);
  if (!entry) {
    entry = {
      blockedUntil: 0,
      inflight: 0,
      lastDispatchAt: 0,
    };
    state.users.set(key, entry);
  }
  return entry;
}

function cleanupUserStates(now = Date.now()) {
  for (const [key, entry] of state.users.entries()) {
    const inactive =
      entry.inflight <= 0 &&
      entry.blockedUntil < now - 60_000 &&
      entry.lastDispatchAt < now - 300_000;
    if (inactive) {
      state.users.delete(key);
    }
  }
}

export async function acquireSpotifyRequestSlot(args: {
  endpointGroup: string;
  method: string;
  userKey?: string;
  priority?: "ui_critical" | "interactive" | "background";
}) {
  const priority = args.priority ?? "interactive";
  const endpoint = `${args.method}:${args.endpointGroup || "unknown"}`;
  const userKey = args.userKey || "anonymous";
  const started = Date.now();
  let waitedMs = 0;

  for (;;) {
    const now = Date.now();
    cleanupEndpointStates(now);
    cleanupUserStates(now);
    const endpointState = getEndpointState(endpoint);
    const userState = getUserState(userKey);

    const dynFactor = Math.min(3, 1 + state.consecutive429 * 0.2);
    const globalGapMs = Math.floor(GLOBAL_MIN_INTERVAL_MS * dynFactor);
    const endpointGapMs = Math.floor(ENDPOINT_MIN_INTERVAL_MS * dynFactor);

    const blockWait = Math.max(
      0,
      state.blockedUntil - now,
      endpointState.blockedUntil - now,
      userState.blockedUntil - now
    );
    const spacingWait = Math.max(
      0,
      state.lastDispatchAt + globalGapMs - now,
      endpointState.lastDispatchAt + endpointGapMs - now,
      userState.lastDispatchAt + USER_MIN_INTERVAL_MS - now
    );
    const concurrencyWait =
      state.inflight >= GLOBAL_MAX_CONCURRENT ||
      endpointState.inflight >= ENDPOINT_MAX_CONCURRENT ||
      userState.inflight >= USER_MAX_CONCURRENT
        ? 35
        : 0;
    const priorityWait =
      priority === "background" &&
      state.inflightByPriority.background >= BACKGROUND_MAX_CONCURRENT
        ? 45
        : 0;

    const sleepMs = Math.max(blockWait, spacingWait, concurrencyWait, priorityWait);
    if (sleepMs <= 0) {
      state.inflight += 1;
      endpointState.inflight += 1;
      userState.inflight += 1;
      state.inflightByPriority[priority] += 1;
      const dispatchNow = Date.now();
      state.lastDispatchAt = dispatchNow;
      endpointState.lastDispatchAt = dispatchNow;
      userState.lastDispatchAt = dispatchNow;
      state.totalAcquires += 1;
      break;
    }

    waitedMs += sleepMs;
    await wait(sleepMs);
  }

  if (waitedMs > 0) {
    state.totalWaitMs += waitedMs;
    observeHistogram("spotify_rate_limiter_wait_ms", waitedMs, {
      endpoint: args.endpointGroup || "unknown",
      method: args.method,
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const endpointState = getEndpointState(endpoint);
    const userState = getUserState(userKey);
    state.inflight = Math.max(0, state.inflight - 1);
    endpointState.inflight = Math.max(0, endpointState.inflight - 1);
    userState.inflight = Math.max(0, userState.inflight - 1);
    state.inflightByPriority[priority] = Math.max(0, state.inflightByPriority[priority] - 1);
    cleanupEndpointStates();
    cleanupUserStates();
    const holdMs = Date.now() - started;
    observeHistogram("spotify_rate_limiter_hold_ms", holdMs, {
      endpoint: args.endpointGroup || "unknown",
      method: args.method,
    });
  };
}

export function registerSpotifyRateLimitHit(args: {
  endpointGroup: string;
  method?: string;
  retryAfterMs?: number | null;
}) {
  const now = Date.now();
  const endpoint = `${String(args.method || "GET").toUpperCase()}:${
    args.endpointGroup || "unknown"
  }`;
  const endpointState = getEndpointState(endpoint);
  const backoffMs = normalizeBackoffMs(args.retryAfterMs);
  state.consecutive429 = Math.min(20, state.consecutive429 + 1);
  state.blockedUntil = Math.max(state.blockedUntil, now + backoffMs);
  endpointState.blockedUntil = Math.max(endpointState.blockedUntil, now + backoffMs);
}

export function registerSpotifyRequestOutcome(args: { status: number }) {
  if (args.status === 429) return;
  if (args.status >= 200 && args.status < 500) {
    state.consecutive429 = Math.max(0, state.consecutive429 - 1);
  }
}

export function getSpotifyCentralRateLimitSnapshot(now = Date.now()) {
  cleanupEndpointStates(now);
  cleanupUserStates(now);
  const backoffRemainingMs = Math.max(0, state.blockedUntil - now);
  return {
    globalBackoffRemainingMs: backoffRemainingMs,
    globalBackoffUntilTs: state.blockedUntil > 0 ? state.blockedUntil : null,
    inflightGlobal: state.inflight,
    maxConcurrentGlobal: GLOBAL_MAX_CONCURRENT,
    maxConcurrentPerEndpoint: ENDPOINT_MAX_CONCURRENT,
    minIntervalGlobalMs: GLOBAL_MIN_INTERVAL_MS,
    minIntervalPerEndpointMs: ENDPOINT_MIN_INTERVAL_MS,
    endpointStates: state.endpoints.size,
    userStates: state.users.size,
    userMaxConcurrent: USER_MAX_CONCURRENT,
    userMinIntervalMs: USER_MIN_INTERVAL_MS,
    backgroundMaxConcurrent: BACKGROUND_MAX_CONCURRENT,
    consecutive429: state.consecutive429,
    totalAcquires: state.totalAcquires,
    totalWaitMs: normalizeWaitMs(state.totalWaitMs),
    inflightByPriority: { ...state.inflightByPriority },
  };
}
