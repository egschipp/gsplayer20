import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PLAYBACK_FOCUS } from "@/app/components/player/playbackFocus";
import type { PlaybackSnapshot } from "./playbackState";
import { derivePlaybackViewModel } from "./viewModel";

const TRACK_A = "1111111111111111111111";

function createSnapshot(overrides: Partial<PlaybackSnapshot> = {}): PlaybackSnapshot {
  return {
    currentTrackId: TRACK_A,
    matchTrackIds: [TRACK_A],
    status: "playing",
    uiStatus: "ready",
    verifiedPlayable: true,
    reason: "ok",
    stale: false,
    source: "sdk",
    updatedAt: 1000,
    positionMs: 3000,
    durationMs: 200000,
    errorMessage: null,
    ...overrides,
  };
}

test("derives active track ids from focus and snapshot", () => {
  const model = derivePlaybackViewModel({
    focus: {
      ...DEFAULT_PLAYBACK_FOCUS,
      trackId: TRACK_A,
      matchTrackIds: [TRACK_A],
      isPlaying: true,
      status: "playing",
      source: "sdk",
      updatedAt: 1200,
    },
    snapshot: createSnapshot(),
    controllerStatus: "ready",
    pendingCommand: null,
    runtime: {
      deviceId: "dev1",
      isActiveDevice: true,
      sdkReady: true,
      mode: "local_sdk",
      lastError: null,
    },
    controllerError: null,
  });
  assert.equal(model.activeTrackId, TRACK_A);
  assert.equal(model.activeTrackIds.includes(TRACK_A), true);
  assert.equal(model.transientGap, false);
});

test("marks transient gap when stale loading snapshot still has active ids", () => {
  const model = derivePlaybackViewModel({
    focus: {
      ...DEFAULT_PLAYBACK_FOCUS,
      trackId: TRACK_A,
      matchTrackIds: [TRACK_A],
      stale: true,
      source: "api_poll",
      updatedAt: 5000,
    },
    snapshot: createSnapshot({
      uiStatus: "loading",
      reason: "missing_match",
      stale: true,
      source: "api_poll",
      status: "loading",
    }),
    controllerStatus: "loading",
    pendingCommand: "play",
    runtime: {
      deviceId: null,
      isActiveDevice: false,
      sdkReady: true,
      mode: "degraded",
      lastError: null,
    },
    controllerError: null,
  });
  assert.equal(model.transientGap, true);
  assert.equal(model.activeTrackId, TRACK_A);
});
