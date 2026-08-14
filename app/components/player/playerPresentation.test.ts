import assert from "node:assert/strict";
import test from "node:test";
import {
  formatPlaybackBootStateLabel,
  formatPlaybackTime,
  formatPlayerError,
} from "./playerPresentation";

test("presents stable playback boot states", () => {
  assert.equal(formatPlaybackBootStateLabel("idle"), "Waiting for session");
  assert.equal(formatPlaybackBootStateLabel("booting"), "Player is starting");
  assert.equal(
    formatPlaybackBootStateLabel("sdk_ready"),
    "Player ready, waiting for device"
  );
  assert.equal(formatPlaybackBootStateLabel("device_ready"), "Device is activating");
  assert.equal(formatPlaybackBootStateLabel("playable"), "Ready to play");
  assert.equal(formatPlaybackBootStateLabel("playing"), "Playback active");
});

test("formats playback duration safely", () => {
  assert.equal(formatPlaybackTime(), "0:00");
  assert.equal(formatPlaybackTime(-1), "0:00");
  assert.equal(formatPlaybackTime(Number.NaN), "0:00");
  assert.equal(formatPlaybackTime(61_999), "1:01");
});

test("maps authentication, scope and premium errors to useful messages", () => {
  assert.equal(formatPlayerError(null), null);
  assert.equal(
    formatPlayerError("insufficient_scope"),
    "Missing Spotify permissions. Reconnect."
  );
  assert.equal(
    formatPlayerError("request returned 401"),
    "Spotify session expired. Reconnect."
  );
  assert.equal(
    formatPlayerError("premium required"),
    "Spotify Premium is required for Web Playback."
  );
  assert.equal(formatPlayerError("custom failure"), "custom failure");
});
