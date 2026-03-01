import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PLAYBACK_FOCUS, type PlaybackFocus } from "@/app/components/player/playbackFocus";
import { derivePlaybackSnapshot } from "./playbackState";

const TRACK_A = "1111111111111111111111";
const TRACK_B = "2222222222222222222222";

function createFocus(overrides: Partial<PlaybackFocus> = {}): PlaybackFocus {
  return {
    ...DEFAULT_PLAYBACK_FOCUS,
    updatedAt: 1_000,
    ...overrides,
  };
}

test("derivePlaybackSnapshot reflects active playing track state", () => {
  const focus = createFocus({
    trackId: TRACK_A,
    isPlaying: true,
    status: "playing",
    positionMs: 12_500,
    durationMs: 200_000,
    source: "sdk",
  });
  const { snapshot } = derivePlaybackSnapshot({
    focus,
    lastStableFocus: DEFAULT_PLAYBACK_FOCUS,
    controllerStatus: "playing",
    pendingCommand: null,
    controllerError: null,
    runtimeError: null,
    now: 2_000,
  });
  assert.equal(snapshot.currentTrackId, TRACK_A);
  assert.equal(snapshot.status, "playing");
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.positionMs, 12_500);
  assert.equal(snapshot.durationMs, 200_000);
});

test("derivePlaybackSnapshot latches recent track when transiently missing", () => {
  const focus = createFocus({
    trackId: null,
    isPlaying: null,
    status: "idle",
    source: "api_poll",
    updatedAt: 1_300,
  });
  const lastStable = createFocus({
    trackId: TRACK_A,
    isPlaying: true,
    status: "playing",
    source: "sdk",
    updatedAt: 1_000,
    positionMs: 43_000,
    durationMs: 180_000,
  });
  const { snapshot } = derivePlaybackSnapshot({
    focus,
    lastStableFocus: lastStable,
    controllerStatus: "playing",
    pendingCommand: "play",
    controllerError: null,
    runtimeError: null,
    now: 2_200,
  });
  assert.equal(snapshot.currentTrackId, TRACK_A);
  assert.equal(snapshot.status, "playing");
  assert.equal(snapshot.stale, true);
});

test("derivePlaybackSnapshot clears stale latch after timeout", () => {
  const focus = createFocus({
    trackId: null,
    status: "idle",
    updatedAt: 20_000,
  });
  const lastStable = createFocus({
    trackId: TRACK_B,
    status: "paused",
    updatedAt: 10_000,
  });
  const { snapshot } = derivePlaybackSnapshot({
    focus,
    lastStableFocus: lastStable,
    controllerStatus: "ready",
    pendingCommand: null,
    controllerError: null,
    runtimeError: null,
    now: 30_000,
  });
  assert.equal(snapshot.currentTrackId, null);
  assert.equal(snapshot.status, "idle");
});

test("derivePlaybackSnapshot marks paused state as loading while play command is pending", () => {
  const focus = createFocus({
    trackId: TRACK_B,
    isPlaying: false,
    status: "paused",
  });
  const { snapshot } = derivePlaybackSnapshot({
    focus,
    lastStableFocus: DEFAULT_PLAYBACK_FOCUS,
    controllerStatus: "initializing",
    pendingCommand: "play",
    controllerError: null,
    runtimeError: null,
    now: 5_000,
  });
  assert.equal(snapshot.currentTrackId, TRACK_B);
  assert.equal(snapshot.status, "loading");
});

test("derivePlaybackSnapshot forces error state when controller reports an error", () => {
  const focus = createFocus({
    trackId: TRACK_A,
    isPlaying: true,
    status: "playing",
    errorMessage: null,
  });
  const { snapshot } = derivePlaybackSnapshot({
    focus,
    lastStableFocus: DEFAULT_PLAYBACK_FOCUS,
    controllerStatus: "playing",
    pendingCommand: null,
    controllerError: "NETWORK_TIMEOUT",
    runtimeError: null,
    now: 8_000,
  });
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.errorMessage, "NETWORK_TIMEOUT");
});
