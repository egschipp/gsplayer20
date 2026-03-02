import assert from "node:assert/strict";
import test from "node:test";
import {
  INITIAL_PLAYBACK_VERSION,
  resolvePlaybackAuthorityMode,
  shouldApplyPlaybackVersion,
  shouldIngestSourceForAuthority,
} from "./authority";

test("resolvePlaybackAuthorityMode prefers handoff while pending device differs", () => {
  const mode = resolvePlaybackAuthorityMode({
    activeDeviceId: "dev-a",
    sdkDeviceId: "sdk-a",
    pendingDeviceId: "dev-b",
    sdkReady: true,
  });
  assert.equal(mode, "handoff_pending");
});

test("resolvePlaybackAuthorityMode marks remote when active differs from sdk", () => {
  const mode = resolvePlaybackAuthorityMode({
    activeDeviceId: "speaker-1",
    sdkDeviceId: "sdk-a",
    pendingDeviceId: null,
    sdkReady: true,
  });
  assert.equal(mode, "remote_primary");
});

test("authority gate rejects sdk ingest while remote is authoritative", () => {
  const verdict = shouldIngestSourceForAuthority({
    authorityMode: "remote_primary",
    source: "sdk",
    eventDeviceId: "sdk-a",
    activeDeviceId: "speaker-1",
    sdkDeviceId: "sdk-a",
  });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, "authority_remote_rejects_sdk");
});

test("versioning rejects older epoch", () => {
  const current = {
    ...INITIAL_PLAYBACK_VERSION,
    deviceEpoch: 4,
    serverSeq: 20,
    serverTime: 10_000,
    receivedMonoMs: 500,
  };
  const verdict = shouldApplyPlaybackVersion(current, {
    deviceEpoch: 3,
    seq: 25,
    atMs: 11_000,
    receivedMonoMs: 600,
  });
  assert.equal(verdict.apply, false);
  assert.equal(verdict.reason, "epoch_older");
});

test("versioning accepts newer seq in same epoch", () => {
  const current = {
    ...INITIAL_PLAYBACK_VERSION,
    deviceEpoch: 2,
    serverSeq: 10,
    serverTime: 8_000,
    receivedMonoMs: 100,
  };
  const verdict = shouldApplyPlaybackVersion(current, {
    deviceEpoch: 2,
    seq: 11,
    atMs: 8_200,
    receivedMonoMs: 140,
  });
  assert.equal(verdict.apply, true);
  assert.equal(verdict.reason, "version_ok");
  assert.equal(verdict.next.serverSeq, 11);
});
