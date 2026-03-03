import assert from "node:assert/strict";
import test from "node:test";
import { projectPlaybackStatusForUi } from "./statusMatrix";

test("maps hidden error to playing for active track", () => {
  const status = projectPlaybackStatusForUi({
    status: "error",
    isPlaying: true,
    isActiveTrack: true,
    isRemoteSource: true,
    stale: false,
    transientGap: false,
    errorVisible: false,
    hideLoadingForRemoteActiveTrack: true,
  });
  assert.equal(status, "loading");
});

test("suppresses loading for remote active track", () => {
  const status = projectPlaybackStatusForUi({
    status: "loading",
    isPlaying: true,
    isActiveTrack: true,
    isRemoteSource: true,
    stale: true,
    transientGap: true,
    errorVisible: true,
    hideLoadingForRemoteActiveTrack: true,
  });
  assert.equal(status, "playing");
});

test("returns idle for non-active track", () => {
  const status = projectPlaybackStatusForUi({
    status: "playing",
    isPlaying: true,
    isActiveTrack: false,
    isRemoteSource: false,
    stale: false,
    transientGap: false,
    errorVisible: true,
    hideLoadingForRemoteActiveTrack: true,
  });
  assert.equal(status, "idle");
});

