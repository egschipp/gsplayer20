import test from "node:test";
import assert from "node:assert/strict";
import { isLocalSdkPlaybackTarget, shouldBlockPlayPause } from "./deviceControlPolicy";

test("restricted remote devices block play and pause", () => {
  assert.equal(
    shouldBlockPlayPause({
      activeDeviceId: "speaker",
      selectedDeviceId: "speaker",
      sdkDeviceId: "web-player",
      restricted: true,
    }),
    true
  );
});

test("restricted local SDK devices retain local play and pause", () => {
  const state = {
    activeDeviceId: "web-player",
    selectedDeviceId: "web-player",
    sdkDeviceId: "web-player",
    restricted: true,
  };

  assert.equal(isLocalSdkPlaybackTarget(state), true);
  assert.equal(shouldBlockPlayPause(state), false);
});

test("SDK readiness without a selected device resolves to local control", () => {
  assert.equal(
    shouldBlockPlayPause({
      activeDeviceId: null,
      selectedDeviceId: null,
      sdkDeviceId: "web-player",
      restricted: true,
    }),
    false
  );
});
