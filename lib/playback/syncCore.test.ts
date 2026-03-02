import assert from "node:assert/strict";
import test from "node:test";
import {
  INITIAL_PLAYBACK_SYNC_STATE,
  reducePlaybackSyncState,
  shouldApplyPlaybackEvent,
  type PlaybackSyncState,
} from "./syncCore";

function baseState(overrides: Partial<PlaybackSyncState> = {}): PlaybackSyncState {
  return {
    ...INITIAL_PLAYBACK_SYNC_STATE,
    lastSeq: 10,
    lastAtMs: 10_000,
    lastSource: "poll",
    ...overrides,
  };
}

test("rejects older sequence events", () => {
  const verdict = shouldApplyPlaybackEvent(
    baseState({ lastSeq: 12 }),
    {
      source: "sse",
      seq: 11,
      atMs: 10_200,
      deviceId: "d1",
      trackId: "t1",
      isPlaying: true,
    }
  );
  assert.equal(verdict.apply, false);
  assert.equal(verdict.reason, "seq_older");
});

test("prefers higher priority source on same seq", () => {
  const state = baseState({ lastSeq: 20, lastSource: "sse", lastAtMs: 2000 });
  const verdict = shouldApplyPlaybackEvent(state, {
    source: "verify",
    seq: 20,
    atMs: 2000,
    deviceId: "d1",
    trackId: "t2",
    isPlaying: true,
  });
  assert.equal(verdict.apply, true);
});

test("keeps stable state when lower priority and older time", () => {
  const verdict = shouldApplyPlaybackEvent(
    baseState({ lastSeq: 0, lastAtMs: 3000, lastSource: "verify" }),
    {
      source: "sse",
      seq: 0,
      atMs: 2000,
      deviceId: "d1",
      trackId: "t1",
      isPlaying: false,
    }
  );
  assert.equal(verdict.apply, false);
  assert.equal(verdict.reason, "older_time_lower_or_equal_priority");
});

test("forced events always apply", () => {
  const verdict = shouldApplyPlaybackEvent(baseState({ lastSeq: 99 }), {
    source: "command",
    seq: 1,
    atMs: 1,
    deviceId: "d2",
    trackId: "t3",
    isPlaying: true,
    force: true,
  });
  assert.equal(verdict.apply, true);
  assert.equal(verdict.reason, "forced");
});

test("reducer updates state for accepted events", () => {
  const next = reducePlaybackSyncState(baseState({ lastSeq: 5, lastAtMs: 1000 }), {
    source: "poll",
    seq: 6,
    atMs: 1200,
    deviceId: "d3",
    trackId: "t3",
    isPlaying: true,
  });
  assert.equal(next.lastSeq, 6);
  assert.equal(next.lastAtMs, 1200);
  assert.equal(next.lastDeviceId, "d3");
  assert.equal(next.lastTrackId, "t3");
});
