import { incCounter, observeHistogram } from "@/lib/observability/metrics";
import { logEvent } from "@/lib/observability/logger";
import { type SpotifyRequestPriority } from "@/lib/spotify/requestPriority";
import { Redis } from "@upstash/redis";

type BucketState = {
  tokens: number;
  lastRefillAt: number;
};

type QueueTask<T> = {
  id: string;
  userKey: string;
  endpoint: string;
  priority: SpotifyRequestPriority;
  enqueuedAt: number;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type Config = {
  globalConcurrency: number;
  perUserConcurrency: number;
  maxQueueSize: number;
  perUserBurst: number;
  perUserRefillPerSec: number;
  queueTimeoutMs: number;
  circuitMaxConsecutiveFailures: number;
  circuitOpenMs: number;
};

type CircuitState = {
  consecutiveFailures: number;
  openUntil: number;
};

export class SpotifyRateLimitError extends Error {
  retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "SpotifyRateLimitError";
    this.retryAfterMs = Math.max(1000, Math.floor(retryAfterMs));
  }
}

const config: Config = {
  globalConcurrency: Number(process.env.SPOTIFY_GLOBAL_CONCURRENCY || "8"),
  perUserConcurrency: Number(process.env.SPOTIFY_PER_USER_CONCURRENCY || "3"),
  maxQueueSize: Number(process.env.SPOTIFY_QUEUE_MAX_SIZE || "500"),
  perUserBurst: Number(process.env.SPOTIFY_PER_USER_BURST || "12"),
  perUserRefillPerSec: Number(process.env.SPOTIFY_PER_USER_REFILL_PER_SEC || "4"),
  queueTimeoutMs: Number(process.env.SPOTIFY_QUEUE_TIMEOUT_MS || "12000"),
  circuitMaxConsecutiveFailures: Number(process.env.SPOTIFY_CIRCUIT_FAILURE_THRESHOLD || "6"),
  circuitOpenMs: Number(process.env.SPOTIFY_CIRCUIT_OPEN_MS || "12000"),
};

const queueByPriority: Record<SpotifyRequestPriority, Array<QueueTask<unknown>>> = {
  foreground: [],
  default: [],
  background: [],
};

const bucketByUser = new Map<string, BucketState>();
const inFlightByUser = new Map<string, number>();
const circuitByUser = new Map<string, CircuitState>();
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
let redis: Redis | null = null;

let globalInFlight = 0;
let taskSeq = 0;
let drainScheduled = false;

function getRedis() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  if (!redis) {
    redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
  }
  return redis;
}

function circuitKey(userKey: string) {
  return `spotify:circuit:${userKey}`;
}

async function readSharedCircuit(userKey: string): Promise<CircuitState | null> {
  const client = getRedis();
  if (!client) return null;
  const data = await client.hgetall<Record<string, string | number>>(circuitKey(userKey));
  if (!data) return null;
  const consecutiveFailures = Number(data.consecutiveFailures ?? 0);
  const openUntil = Number(data.openUntil ?? 0);
  if (!Number.isFinite(consecutiveFailures) || !Number.isFinite(openUntil)) return null;
  return { consecutiveFailures, openUntil };
}

async function writeSharedCircuit(userKey: string, state: CircuitState): Promise<void> {
  const client = getRedis();
  if (!client) return;
  const key = circuitKey(userKey);
  const ttlSec = Math.max(60, Math.ceil((Math.max(0, state.openUntil - nowMs()) + 300_000) / 1000));
  await client.hset(key, {
    consecutiveFailures: state.consecutiveFailures,
    openUntil: state.openUntil,
  });
  await client.expire(key, ttlSec);
}

function nowMs(): number {
  return Date.now();
}

function taskId(): string {
  taskSeq += 1;
  return `spotify_task_${taskSeq}`;
}

function totalQueueDepth(): number {
  return (
    queueByPriority.foreground.length +
    queueByPriority.default.length +
    queueByPriority.background.length
  );
}

function getBucket(userKey: string): BucketState {
  const now = nowMs();
  const existing = bucketByUser.get(userKey);
  if (!existing) {
    const created: BucketState = {
      tokens: config.perUserBurst,
      lastRefillAt: now,
    };
    bucketByUser.set(userKey, created);
    return created;
  }

  const elapsedSec = Math.max(0, (now - existing.lastRefillAt) / 1000);
  if (elapsedSec > 0) {
    const refill = elapsedSec * config.perUserRefillPerSec;
    existing.tokens = Math.min(config.perUserBurst, existing.tokens + refill);
    existing.lastRefillAt = now;
  }

  return existing;
}

function hasToken(userKey: string): boolean {
  const bucket = getBucket(userKey);
  return bucket.tokens >= 1;
}

function consumeToken(userKey: string): void {
  const bucket = getBucket(userKey);
  bucket.tokens = Math.max(0, bucket.tokens - 1);
}

function canRunTask(task: QueueTask<unknown>): boolean {
  if (globalInFlight >= config.globalConcurrency) return false;
  const userInflight = inFlightByUser.get(task.userKey) || 0;
  if (userInflight >= config.perUserConcurrency) return false;
  if (!hasToken(task.userKey)) return false;

  const circuit = circuitByUser.get(task.userKey);
  if (circuit && circuit.openUntil > nowMs()) return false;

  return true;
}

function scheduleDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  setTimeout(() => {
    drainScheduled = false;
    void drainQueue();
  }, 25);
}

function popNextRunnable(): QueueTask<unknown> | null {
  const priorities: SpotifyRequestPriority[] = ["foreground", "default", "background"];

  for (const priority of priorities) {
    const queue = queueByPriority[priority];
    for (let i = 0; i < queue.length; i += 1) {
      const candidate = queue[i];
      const age = nowMs() - candidate.enqueuedAt;
      if (age > config.queueTimeoutMs) {
        queue.splice(i, 1);
        i -= 1;
        incCounter("spotify_queue_rejected_total", {
          reason: "timeout",
          priority,
        });
        candidate.reject(new SpotifyRateLimitError("QUEUE_TIMEOUT", 2_000));
        continue;
      }

      if (!canRunTask(candidate)) continue;
      queue.splice(i, 1);
      return candidate;
    }
  }

  return null;
}

async function runTask(task: QueueTask<unknown>): Promise<void> {
  consumeToken(task.userKey);
  globalInFlight += 1;
  inFlightByUser.set(task.userKey, (inFlightByUser.get(task.userKey) || 0) + 1);

  const startedAt = nowMs();
  observeHistogram("spotify_queue_wait_ms", startedAt - task.enqueuedAt, {
    priority: task.priority,
    endpoint: task.endpoint,
  });

  try {
    const result = await task.run();
    task.resolve(result);
  } catch (error) {
    task.reject(error);
  } finally {
    globalInFlight = Math.max(0, globalInFlight - 1);
    const userInflight = Math.max(0, (inFlightByUser.get(task.userKey) || 1) - 1);
    if (userInflight === 0) inFlightByUser.delete(task.userKey);
    else inFlightByUser.set(task.userKey, userInflight);

    observeHistogram("spotify_execution_ms", nowMs() - startedAt, {
      priority: task.priority,
      endpoint: task.endpoint,
    });
    scheduleDrain();
  }
}

async function drainQueue(): Promise<void> {
  while (globalInFlight < config.globalConcurrency) {
    const task = popNextRunnable();
    if (!task) break;
    void runTask(task);
  }
  incCounter("spotify_queue_depth_samples_total", {
    depth: String(totalQueueDepth()),
  });
}

async function checkCircuit(userKey: string): Promise<void> {
  const state = circuitByUser.get(userKey);
  const shared = await readSharedCircuit(userKey);
  const merged: CircuitState | null =
    state && shared
      ? {
          consecutiveFailures: Math.max(state.consecutiveFailures, shared.consecutiveFailures),
          openUntil: Math.max(state.openUntil, shared.openUntil),
        }
      : state || shared || null;
  if (!merged) return;
  circuitByUser.set(userKey, merged);
  const now = nowMs();
  if (merged.openUntil > now) {
    const retryAfterMs = merged.openUntil - now;
    throw new SpotifyRateLimitError("CIRCUIT_OPEN", retryAfterMs);
  }
}

export async function scheduleSpotifyRequest<T>(args: {
  userKey: string;
  endpoint: string;
  priority: SpotifyRequestPriority;
  run: () => Promise<T>;
}): Promise<T> {
  await checkCircuit(args.userKey);

  if (totalQueueDepth() >= config.maxQueueSize) {
    incCounter("spotify_queue_rejected_total", { reason: "queue_full", priority: args.priority });
    throw new SpotifyRateLimitError("QUEUE_FULL", 2_000);
  }

  return new Promise<T>((resolve, reject) => {
    const task: QueueTask<T> = {
      id: taskId(),
      userKey: args.userKey,
      endpoint: args.endpoint,
      priority: args.priority,
      enqueuedAt: nowMs(),
      run: args.run,
      resolve,
      reject,
    };

    queueByPriority[args.priority].push(task as QueueTask<unknown>);
    observeHistogram("spotify_queue_depth", totalQueueDepth(), {
      priority: args.priority,
    });
    scheduleDrain();
  });
}

export async function registerSpotifyRateLimit(
  userKey: string,
  retryAfterMs: number,
  endpoint: string
): Promise<void> {
  const now = nowMs();
  const current = circuitByUser.get(userKey) || {
    consecutiveFailures: 0,
    openUntil: 0,
  };
  current.consecutiveFailures += 1;
  current.openUntil = Math.max(
    current.openUntil,
    now + Math.max(1_000, Math.min(120_000, Math.floor(retryAfterMs)))
  );
  circuitByUser.set(userKey, current);
  await writeSharedCircuit(userKey, current);

  incCounter("spotify_rate_limit_events_total", { endpoint });
  logEvent({
    level: "warn",
    event: "spotify_rate_limit_manager_backoff",
    endpointGroup: endpoint,
    data: {
      userKey,
      retryAfterMs,
      openUntil: current.openUntil,
      consecutiveFailures: current.consecutiveFailures,
    },
  });
}

export async function registerSpotifyRequestSuccess(userKey: string): Promise<void> {
  const current = circuitByUser.get(userKey);
  if (!current) return;
  current.consecutiveFailures = 0;
  if (current.openUntil <= nowMs()) {
    circuitByUser.delete(userKey);
    const client = getRedis();
    if (client) await client.del(circuitKey(userKey));
  } else {
    circuitByUser.set(userKey, current);
    await writeSharedCircuit(userKey, current);
  }
}

export async function registerSpotifyRequestFailure(
  userKey: string,
  endpoint: string
): Promise<void> {
  const now = nowMs();
  const current = circuitByUser.get(userKey) || {
    consecutiveFailures: 0,
    openUntil: 0,
  };
  current.consecutiveFailures += 1;

  if (current.consecutiveFailures >= config.circuitMaxConsecutiveFailures) {
    current.openUntil = now + config.circuitOpenMs;
    logEvent({
      level: "warn",
      event: "spotify_rate_limit_manager_circuit_open",
      endpointGroup: endpoint,
      data: {
        userKey,
        openUntil: current.openUntil,
        failures: current.consecutiveFailures,
      },
    });
  }

  circuitByUser.set(userKey, current);
  await writeSharedCircuit(userKey, current);
}

export function getSpotifyRateLimiterSnapshot() {
  return {
    queueDepth: totalQueueDepth(),
    globalInFlight,
    usersInFlight: inFlightByUser.size,
    circuitsOpen: Array.from(circuitByUser.values()).filter((item) => item.openUntil > nowMs())
      .length,
    config,
  };
}
