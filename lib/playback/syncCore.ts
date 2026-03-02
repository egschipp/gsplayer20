export type PlaybackIngestSource =
  | "sdk"
  | "sse"
  | "poll"
  | "verify"
  | "bootstrap"
  | "command";

export type PlaybackSyncEvent = {
  source: PlaybackIngestSource;
  seq: number;
  atMs: number;
  deviceId: string | null;
  trackId: string | null;
  isPlaying: boolean | null;
  force?: boolean;
};

export type PlaybackSyncState = {
  lastSeq: number;
  lastAtMs: number;
  lastSource: PlaybackIngestSource;
  lastDeviceId: string | null;
  lastTrackId: string | null;
  lastAppliedAtMs: number;
};

export const INITIAL_PLAYBACK_SYNC_STATE: PlaybackSyncState = {
  lastSeq: 0,
  lastAtMs: 0,
  lastSource: "bootstrap",
  lastDeviceId: null,
  lastTrackId: null,
  lastAppliedAtMs: 0,
};

const SOURCE_PRIORITY: Record<PlaybackIngestSource, number> = {
  sdk: 6,
  command: 5,
  verify: 4,
  poll: 3,
  sse: 2,
  bootstrap: 1,
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function clampEvent(event: PlaybackSyncEvent): PlaybackSyncEvent {
  return {
    ...event,
    seq: isFiniteNumber(event.seq) ? Math.max(0, Math.floor(event.seq)) : 0,
    atMs: isFiniteNumber(event.atMs) ? Math.max(0, Math.floor(event.atMs)) : 0,
    deviceId: event.deviceId ? String(event.deviceId) : null,
    trackId: event.trackId ? String(event.trackId) : null,
    isPlaying:
      typeof event.isPlaying === "boolean"
        ? event.isPlaying
        : event.isPlaying === null
        ? null
        : null,
    force: event.force === true,
  };
}

export function shouldApplyPlaybackEvent(
  state: PlaybackSyncState,
  input: PlaybackSyncEvent
): { apply: boolean; reason: string } {
  const event = clampEvent(input);
  const hasEventSeq = event.seq > 0;
  const hasStateSeq = state.lastSeq > 0;
  const nextPriority = SOURCE_PRIORITY[event.source];
  const currentPriority = SOURCE_PRIORITY[state.lastSource];

  if (event.force) {
    return { apply: true, reason: "forced" };
  }

  if (hasEventSeq && hasStateSeq && event.seq < state.lastSeq) {
    return { apply: false, reason: "seq_older" };
  }

  if (hasEventSeq && hasStateSeq && event.seq === state.lastSeq) {
    if (event.atMs > 0 && event.atMs < state.lastAtMs) {
      return { apply: false, reason: "same_seq_older_time" };
    }
    if (nextPriority < currentPriority) {
      return { apply: false, reason: "same_seq_lower_priority" };
    }
  }

  if (!hasEventSeq) {
    if (event.atMs + 350 < state.lastAtMs && nextPriority <= currentPriority) {
      return { apply: false, reason: "older_time_lower_or_equal_priority" };
    }
    if (
      hasStateSeq &&
      event.atMs <= state.lastAtMs &&
      nextPriority < currentPriority
    ) {
      return { apply: false, reason: "unsequenced_lower_priority" };
    }
  }

  return { apply: true, reason: "accepted" };
}

export function reducePlaybackSyncState(
  state: PlaybackSyncState,
  input: PlaybackSyncEvent
): PlaybackSyncState {
  const event = clampEvent(input);
  const verdict = shouldApplyPlaybackEvent(state, event);
  if (!verdict.apply) {
    return state;
  }
  return {
    lastSeq: event.seq > 0 ? Math.max(state.lastSeq, event.seq) : state.lastSeq,
    lastAtMs: Math.max(state.lastAtMs, event.atMs),
    lastSource: event.source,
    lastDeviceId: event.deviceId,
    lastTrackId: event.trackId,
    lastAppliedAtMs: Date.now(),
  };
}
