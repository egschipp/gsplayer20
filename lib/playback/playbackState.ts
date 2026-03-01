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
};

function clampMs(value: number | null | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : 0;
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
    const withinLatchWindow =
      Boolean(lastStableFocus.trackId) &&
      now - Math.max(0, lastStableFocus.updatedAt) <= latchWindowMs;
    const transientState =
      pendingCommand === "play" ||
      pendingCommand === "toggle" ||
      pendingCommand === "transfer" ||
      controllerStatus === "playing" ||
      controllerStatus === "paused" ||
      controllerStatus === "initializing" ||
      status === "loading";
    if (withinLatchWindow && transientState && lastStableFocus.trackId) {
      currentId = lastStableFocus.trackId;
      stale = true;
      source = lastStableFocus.source;
      updatedAt = now;
      positionMs = clampMs(lastStableFocus.positionMs);
      durationMs = clampMs(lastStableFocus.durationMs);
      if (status !== "error") {
        status = lastStableFocus.status;
      }
    } else if (!withinLatchWindow) {
      nextStableFocus = DEFAULT_PLAYBACK_FOCUS;
    }
  }

  if (controllerError || runtimeError) {
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
