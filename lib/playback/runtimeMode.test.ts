import assert from "node:assert/strict";
import test from "node:test";
import {
  resolvePlaybackExecutionMode,
  resolvePlaybackSyncOwnership,
} from "./runtimeMode";

test("prefers local sdk when the active device matches the sdk device", () => {
  assert.equal(
    resolvePlaybackExecutionMode({
      activeDeviceId: "sdk-device",
      sdkDeviceId: "sdk-device",
      sdkReady: true,
    }),
    "local_sdk"
  );
});

test("returns remote connect when a different active device is selected", () => {
  assert.equal(
    resolvePlaybackExecutionMode({
      activeDeviceId: "remote-device",
      sdkDeviceId: "sdk-device",
      sdkReady: true,
    }),
    "remote_connect"
  );
});

test("returns handoff pending while a device switch is still in flight", () => {
  assert.equal(
    resolvePlaybackExecutionMode({
      activeDeviceId: "sdk-device",
      sdkDeviceId: "sdk-device",
      pendingDeviceId: "remote-device",
      sdkReady: true,
    }),
    "handoff_pending"
  );
});

test("returns idle only when neither sdk nor active playback state exists", () => {
  assert.equal(
    resolvePlaybackExecutionMode({
      activeDeviceId: null,
      sdkDeviceId: null,
      sdkReady: false,
    }),
    "idle"
  );
});

test("returns degraded when sdk identity exists but readiness is incomplete", () => {
  assert.equal(
    resolvePlaybackExecutionMode({
      activeDeviceId: null,
      sdkDeviceId: "sdk-device",
      sdkReady: false,
    }),
    "degraded"
  );
});

test("keeps follower tabs passive when they only have a local sdk session but no active sdk device", () => {
  assert.deepEqual(
    resolvePlaybackSyncOwnership({
      executionMode: "local_sdk",
      isLeader: false,
      activeDeviceId: null,
      sdkDeviceId: "sdk-device",
    }),
    {
      shouldOwnPlaybackSync: false,
      shouldRunPlaybackStream: false,
    }
  );
});

test("allows a tab to own sync when its sdk device is the active playback device", () => {
  assert.deepEqual(
    resolvePlaybackSyncOwnership({
      executionMode: "local_sdk",
      isLeader: false,
      activeDeviceId: "sdk-device",
      sdkDeviceId: "sdk-device",
    }),
    {
      shouldOwnPlaybackSync: true,
      shouldRunPlaybackStream: false,
    }
  );
});
