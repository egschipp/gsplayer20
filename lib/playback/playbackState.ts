import {
  resolvePlaybackFocusStatus,
  type PlaybackFocus,
  type PlaybackFocusSource,
  type PlaybackFocusStatus,
} from "@/app/components/player/playbackFocus";
import type {
  PlayerCommandType,
  PlayerPlaybackStatus,
} from "./playerControllerTypes";

const STABLE_TRACK_SNAPSHOT_GRACE_MS = 4_500;

export type PlaybackSnapshot = {
  currentTrackId: string | null;
  matchTrackIds: string[];
  status: PlaybackFocusStatus;
  uiStatus: "empty" | "loading" | "ready" | "error";
  verifiedPlayable: boolean;
  reason:
    | "ok"
    | "no_track"
    | "missing_match"
    | "controller_initializing"
    | "controller_error";
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
  let reason: PlaybackSnapshot["reason"] = "ok";
  let verifiedPlayable = false;
  let uiStatus: PlaybackSnapshot["uiStatus"] = "empty";

  let nextStableFocus = lastStableFocus;

  const hasControllerError = Boolean(controllerError || runtimeError);
  const hasActiveTrack = Boolean(currentId && matchTrackIds.length > 0);
  const stableMatchTrackIds = normalizeMatchTrackIds(
    lastStableFocus.trackId,
    lastStableFocus.matchTrackIds
  );
  const hasStableTrack = Boolean(lastStableFocus.trackId && stableMatchTrackIds.length > 0);
  const stableUpdatedAt = Number.isFinite(lastStableFocus.updatedAt)
    ? lastStableFocus.updatedAt
    : 0;
  const stableAgeMs = Math.max(0, now - stableUpdatedAt);
  const stableTrackFresh = hasStableTrack && stableAgeMs <= STABLE_TRACK_SNAPSHOT_GRACE_MS;
  const initializing =
    pendingCommand === "play" ||
    pendingCommand === "toggle" ||
    pendingCommand === "transfer" ||
    controllerStatus === "loading";

  if (hasControllerError && !hasActiveTrack) {
    status = "error";
    uiStatus = "error";
    verifiedPlayable = false;
    reason = "controller_error";
    errorMessage = controllerError || runtimeError;
    currentId = null;
    matchTrackIds = [];
    stale = false;
  } else if (!hasActiveTrack) {
    const shouldHoldStableTrack =
      stableTrackFresh &&
      (initializing || focus.source !== "system" || Boolean(focus.stale));
    if (shouldHoldStableTrack) {
      currentId = lastStableFocus.trackId;
      matchTrackIds = stableMatchTrackIds;
      stale = true;
      status = initializing
        ? "loading"
        : lastStableFocus.isPlaying === false
        ? "paused"
        : "loading";
      uiStatus = status === "loading" ? "loading" : "ready";
      verifiedPlayable = true;
      reason = initializing ? "controller_initializing" : "missing_match";
      errorMessage = hasControllerError ? errorMessage : null;
      positionMs = clampMs(lastStableFocus.positionMs);
      durationMs = clampMs(lastStableFocus.durationMs);
      nextStableFocus = {
        ...lastStableFocus,
        trackId: currentId,
        matchTrackIds,
        status,
        stale: true,
        source,
        positionMs,
        durationMs,
        errorMessage,
        updatedAt,
      };
    } else {
      if (initializing) {
        status = "loading";
        uiStatus = "loading";
        verifiedPlayable = false;
        reason = "controller_initializing";
      } else {
        status = "idle";
        uiStatus = "empty";
        verifiedPlayable = false;
        reason = currentId ? "missing_match" : "no_track";
      }
      currentId = null;
      matchTrackIds = [];
      stale = false;
      errorMessage = hasControllerError ? errorMessage : null;
      positionMs = 0;
      durationMs = 0;
    }
  } else {
    verifiedPlayable = true;
    stale = Boolean(focus.stale);
    reason = "ok";
    if (status === "error") {
      uiStatus = "error";
      verifiedPlayable = false;
      currentId = null;
      matchTrackIds = [];
    } else if (status === "loading") {
      uiStatus = "loading";
    } else if (stale) {
      uiStatus = "ready";
      if (status === "idle" || status === "ended") {
        status = focus.isPlaying === false ? "paused" : "loading";
      }
    } else {
      uiStatus = "ready";
      if (status === "idle" || status === "ended") {
        status = focus.isPlaying === false ? "paused" : "playing";
      }
    }
    nextStableFocus = {
      ...focus,
      trackId: currentId,
      matchTrackIds,
      status,
      stale,
      positionMs,
      durationMs,
      errorMessage,
      updatedAt,
    };
  }

  return {
    snapshot: {
      currentTrackId: currentId,
      matchTrackIds: normalizeMatchTrackIds(currentId, matchTrackIds),
      status,
      uiStatus,
      verifiedPlayable,
      reason,
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
