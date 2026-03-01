import {
  DEFAULT_PLAYBACK_FOCUS,
  resolvePlaybackFocusStatus,
  type PlaybackFocus,
  type PlaybackFocusSource,
  type PlaybackFocusStatus,
} from "@/app/components/player/playbackFocus";
import type {
  PlayerCommandType,
  PlayerPlaybackStatus,
} from "./playerControllerTypes";

export type PlaybackSnapshot = {
  currentTrackId: string | null;
  matchTrackIds: string[];
  status: PlaybackFocusStatus;
  stale: boolean;
  source: PlaybackFocusSource;
  updatedAt: number;
  positionMs: number;
  durationMs: number;
  errorMessage: string | null;
};

export type DerivePlaybackSnapshotInput = {
  focus: PlaybackFocus;
  lastStableFocus: PlaybackFocus;
  controllerStatus: PlayerPlaybackStatus;
  pendingCommand: PlayerCommandType | null;
  controllerError: string | null;
  runtimeError: string | null;
  now?: number;
  latchWindowMs?: number;
  activePlaybackLatchMs?: number;
};

function clampMs(value: number | null | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : 0;
}

function normalizeMatchTrackIds(
  currentTrackId: string | null,
  values: string[] | null | undefined
) {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const id = value.trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  if (Array.isArray(values)) {
    for (const value of values) push(value);
  }
  push(currentTrackId);
  return out;
}

export function derivePlaybackSnapshot({
  focus,
  lastStableFocus,
  controllerStatus,
  pendingCommand,
  controllerError,
  runtimeError,
  now = Date.now(),
  latchWindowMs = 2500,
  activePlaybackLatchMs = 15 * 60 * 1000,
}: DerivePlaybackSnapshotInput): {
  snapshot: PlaybackSnapshot;
  nextStableFocus: PlaybackFocus;
} {
  const baseStatus = resolvePlaybackFocusStatus(
    focus.status,
    focus.isPlaying,
    Boolean(focus.trackId)
  );
  let currentId = focus.trackId;
  let matchTrackIds = normalizeMatchTrackIds(focus.trackId, focus.matchTrackIds);
  let status: PlaybackFocusStatus = baseStatus;
  let stale = Boolean(focus.stale);
  let source: PlaybackFocusSource = focus.source;
  let updatedAt = Number.isFinite(focus.updatedAt) ? focus.updatedAt : now;
  let positionMs = clampMs(focus.positionMs);
  let durationMs = clampMs(focus.durationMs);
  let errorMessage = focus.errorMessage || controllerError || runtimeError || null;

  let nextStableFocus = lastStableFocus;
  if (currentId) {
    nextStableFocus = {
      ...focus,
      status,
      positionMs,
      durationMs,
      errorMessage,
      updatedAt,
    };
  } else {
    const playbackLikelyActive =
      focus.isPlaying === true ||
      focus.status === "playing" ||
      focus.status === "paused" ||
      focus.status === "loading" ||
      controllerStatus === "playing" ||
      controllerStatus === "paused" ||
      pendingCommand === "play" ||
      pendingCommand === "toggle" ||
      pendingCommand === "transfer";
    const withinLatchWindow =
      Boolean(lastStableFocus.trackId) &&
      now - Math.max(0, lastStableFocus.updatedAt) <= latchWindowMs;
    const withinActivePlaybackLatchWindow =
      Boolean(lastStableFocus.trackId) &&
      now - Math.max(0, lastStableFocus.updatedAt) <= activePlaybackLatchMs;
    const transientState =
      playbackLikelyActive || controllerStatus === "initializing" || status === "loading";
    const shouldLatch =
      lastStableFocus.trackId &&
      transientState &&
      (withinLatchWindow || (playbackLikelyActive && withinActivePlaybackLatchWindow));
    if (shouldLatch) {
      currentId = lastStableFocus.trackId;
      matchTrackIds = normalizeMatchTrackIds(
        lastStableFocus.trackId,
        lastStableFocus.matchTrackIds
      );
      stale = true;
      source = lastStableFocus.source;
      updatedAt = now;
      positionMs = clampMs(lastStableFocus.positionMs);
      durationMs = clampMs(lastStableFocus.durationMs);
      if (status !== "error") {
        status = lastStableFocus.status;
      }
    } else if (!withinLatchWindow && !withinActivePlaybackLatchWindow) {
      nextStableFocus = DEFAULT_PLAYBACK_FOCUS;
    }
  }

  const hasControllerError = Boolean(controllerError || runtimeError);
  const hasActiveTrack = Boolean(currentId);
  if (
    hasControllerError &&
    (!hasActiveTrack || status === "idle" || status === "ended")
  ) {
    status = "error";
    errorMessage = controllerError || runtimeError;
  } else if (
    (pendingCommand === "play" ||
      pendingCommand === "toggle" ||
      pendingCommand === "transfer") &&
    (status === "idle" || status === "paused" || status === "ended")
  ) {
    status = "loading";
  } else if (status === "idle" && controllerStatus === "playing") {
    status = "playing";
  } else if (status === "idle" && controllerStatus === "paused") {
    status = "paused";
  }

  return {
    snapshot: {
      currentTrackId: currentId,
      matchTrackIds: normalizeMatchTrackIds(currentId, matchTrackIds),
      status,
      stale,
      source,
      updatedAt,
      positionMs,
      durationMs,
      errorMessage,
    },
    nextStableFocus,
  };
}
