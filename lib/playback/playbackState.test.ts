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
    controllerStatus: "ready",
    pendingCommand: null,
    controllerError: null,
    runtimeError: null,
    now: 2_000,
  });
  assert.equal(snapshot.currentTrackId, TRACK_A);
  assert.equal(snapshot.status, "playing");
  assert.equal(snapshot.uiStatus, "ready");
  assert.equal(snapshot.verifiedPlayable, true);
  assert.equal(snapshot.reason, "ok");
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.positionMs, 12_500);
  assert.equal(snapshot.durationMs, 200_000);
});

test("derivePlaybackSnapshot returns loading when playback command is pending but track is unknown", () => {
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
    controllerStatus: "loading",
    pendingCommand: "play",
    controllerError: null,
    runtimeError: null,
    now: 2_200,
  });
  assert.equal(snapshot.currentTrackId, TRACK_A);
  assert.equal(snapshot.status, "loading");
  assert.equal(snapshot.uiStatus, "loading");
  assert.equal(snapshot.verifiedPlayable, true);
  assert.equal(snapshot.reason, "controller_initializing");
  assert.equal(snapshot.stale, true);
});

test("derivePlaybackSnapshot keeps empty when no track exists", () => {
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
  assert.equal(snapshot.uiStatus, "empty");
  assert.equal(snapshot.verifiedPlayable, false);
  assert.equal(snapshot.reason, "no_track");
  assert.equal(snapshot.stale, false);
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
    controllerStatus: "loading",
    pendingCommand: "play",
    controllerError: null,
    runtimeError: null,
    now: 5_000,
  });
  assert.equal(snapshot.currentTrackId, TRACK_B);
  assert.equal(snapshot.status, "loading");
  assert.equal(snapshot.uiStatus, "loading");
  assert.equal(snapshot.verifiedPlayable, true);
});

test("derivePlaybackSnapshot keeps active playback status despite controller error", () => {
  const focus = createFocus({
    trackId: TRACK_A,
    isPlaying: true,
    status: "playing",
    errorMessage: null,
  });
  const { snapshot } = derivePlaybackSnapshot({
    focus,
    lastStableFocus: DEFAULT_PLAYBACK_FOCUS,
    controllerStatus: "ready",
    pendingCommand: null,
    controllerError: "NETWORK_TIMEOUT",
    runtimeError: null,
    now: 8_000,
  });
  assert.equal(snapshot.status, "playing");
  assert.equal(snapshot.uiStatus, "ready");
  assert.equal(snapshot.verifiedPlayable, true);
  assert.equal(snapshot.errorMessage, "NETWORK_TIMEOUT");
});

test("derivePlaybackSnapshot preserves stale active track without dropping highlight", () => {
  const focus = createFocus({
    trackId: TRACK_A,
    matchTrackIds: [TRACK_A],
    isPlaying: true,
    status: "playing",
    stale: true,
    source: "api_stream",
    positionMs: 10_000,
    durationMs: 200_000,
  });
  const { snapshot } = derivePlaybackSnapshot({
    focus,
    lastStableFocus: DEFAULT_PLAYBACK_FOCUS,
    controllerStatus: "ready",
    pendingCommand: null,
    controllerError: null,
    runtimeError: null,
    now: 20_000,
  });
  assert.equal(snapshot.currentTrackId, TRACK_A);
  assert.equal(snapshot.uiStatus, "ready");
  assert.equal(snapshot.verifiedPlayable, true);
  assert.equal(snapshot.stale, true);
});

test("derivePlaybackSnapshot reports error when no active track exists", () => {
  const focus = createFocus({
    trackId: null,
    isPlaying: null,
    status: "idle",
  });
  const { snapshot } = derivePlaybackSnapshot({
    focus,
    lastStableFocus: DEFAULT_PLAYBACK_FOCUS,
    controllerStatus: "ready",
    pendingCommand: null,
    controllerError: "PLAYER_UNAVAILABLE",
    runtimeError: null,
    now: 9_000,
  });
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.uiStatus, "error");
  assert.equal(snapshot.currentTrackId, null);
  assert.equal(snapshot.verifiedPlayable, false);
  assert.equal(snapshot.reason, "controller_error");
  assert.equal(snapshot.errorMessage, "PLAYER_UNAVAILABLE");
});

test("derivePlaybackSnapshot keeps stable track during transient controller error", () => {
  const focus = createFocus({
    trackId: null,
    isPlaying: null,
    status: "idle",
    source: "api_poll",
    updatedAt: 1_900,
  });
  const lastStable = createFocus({
    trackId: TRACK_A,
    matchTrackIds: [TRACK_A],
    isPlaying: true,
    status: "playing",
    source: "sdk",
    updatedAt: 1_000,
    positionMs: 12_000,
    durationMs: 180_000,
  });
  const { snapshot } = derivePlaybackSnapshot({
    focus,
    lastStableFocus: lastStable,
    controllerStatus: "ready",
    pendingCommand: null,
    controllerError: "PLAYER_UNAVAILABLE",
    runtimeError: null,
    now: 2_300,
  });
  assert.equal(snapshot.currentTrackId, TRACK_A);
  assert.equal(snapshot.status, "loading");
  assert.equal(snapshot.uiStatus, "ready");
  assert.equal(snapshot.verifiedPlayable, true);
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.reason, "controller_error");
  assert.equal(snapshot.errorMessage, "PLAYER_UNAVAILABLE");
});

test("derivePlaybackSnapshot keeps last stable track for transient source gaps", () => {
  const focus = createFocus({
    trackId: null,
    isPlaying: null,
    status: "idle",
    source: "api_sync",
    updatedAt: 2_000,
  });
  const lastStable = createFocus({
    trackId: TRACK_B,
    matchTrackIds: [TRACK_B],
    isPlaying: false,
    status: "paused",
    source: "sdk",
    updatedAt: 1_000,
    positionMs: 33_000,
    durationMs: 180_000,
  });
  const { snapshot } = derivePlaybackSnapshot({
    focus,
    lastStableFocus: lastStable,
    controllerStatus: "ready",
    pendingCommand: null,
    controllerError: null,
    runtimeError: null,
    now: 3_500,
  });
  assert.equal(snapshot.currentTrackId, TRACK_B);
  assert.equal(snapshot.status, "paused");
  assert.equal(snapshot.uiStatus, "ready");
  assert.equal(snapshot.verifiedPlayable, true);
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.positionMs, 33_000);
  assert.equal(snapshot.durationMs, 180_000);
});

test("derivePlaybackSnapshot clears stale track after grace window expires", () => {
  const focus = createFocus({
    trackId: null,
    isPlaying: null,
    status: "idle",
    source: "api_poll",
    updatedAt: 20_000,
  });
  const lastStable = createFocus({
    trackId: TRACK_A,
    matchTrackIds: [TRACK_A],
    isPlaying: true,
    status: "playing",
    source: "sdk",
    updatedAt: 1_000,
    positionMs: 5_000,
    durationMs: 200_000,
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
  assert.equal(snapshot.uiStatus, "empty");
  assert.equal(snapshot.verifiedPlayable, false);
  assert.equal(snapshot.reason, "no_track");
});

test("derivePlaybackSnapshot keeps stable track while transfer is pending", () => {
  const focus = createFocus({
    trackId: null,
    isPlaying: null,
    status: "idle",
    source: "api_verify",
    updatedAt: 2_000,
  });
  const lastStable = createFocus({
    trackId: TRACK_B,
    matchTrackIds: [TRACK_B],
    isPlaying: false,
    status: "paused",
    source: "api_sync",
    updatedAt: 1_200,
    positionMs: 44_000,
    durationMs: 240_000,
  });
  const { snapshot } = derivePlaybackSnapshot({
    focus,
    lastStableFocus: lastStable,
    controllerStatus: "loading",
    pendingCommand: "transfer",
    controllerError: null,
    runtimeError: null,
    now: 4_000,
  });
  assert.equal(snapshot.currentTrackId, TRACK_B);
  assert.equal(snapshot.status, "loading");
  assert.equal(snapshot.uiStatus, "loading");
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.verifiedPlayable, true);
  assert.equal(snapshot.reason, "controller_initializing");
});
