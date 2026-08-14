import assert from "node:assert/strict";
import test from "node:test";
import {
  detectWebplayerPlatform,
  getWebPlaybackSdkSupport,
  resolveDeviceTypeIcon,
} from "./playerEnvironment";

test("detects supported player platforms including touch iPads", () => {
  assert.equal(detectWebplayerPlatform(undefined), "");
  assert.equal(detectWebplayerPlatform({ userAgent: "iPhone" }), "iPhone");
  assert.equal(detectWebplayerPlatform({ userAgent: "Android" }), "Android");
  assert.equal(detectWebplayerPlatform({ userAgent: "Windows NT" }), "Windows");
  assert.equal(detectWebplayerPlatform({ userAgent: "Mac OS X" }), "Mac");
  assert.equal(
    detectWebplayerPlatform({ userAgent: "Macintosh", maxTouchPoints: 5 }),
    "iPad"
  );
});

test("requires a secure browser with Spotify playback primitives", () => {
  assert.equal(getWebPlaybackSdkSupport(undefined).supported, false);
  assert.match(
    getWebPlaybackSdkSupport({ isSecureContext: false }).reason ?? "",
    /HTTPS/
  );
  assert.equal(
    getWebPlaybackSdkSupport({
      isSecureContext: true,
      AudioContext: class {},
    }).supported,
    false
  );
  assert.deepEqual(
    getWebPlaybackSdkSupport({
      isSecureContext: true,
      webkitAudioContext: class {},
      MediaSource: class {},
    }),
    { supported: true, reason: null }
  );
});

test("maps Spotify device types to accessible visual hints", () => {
  assert.equal(resolveDeviceTypeIcon("Smartphone"), "📱");
  assert.equal(resolveDeviceTypeIcon("Computer"), "💻");
  assert.equal(resolveDeviceTypeIcon("Speaker"), "🔊");
  assert.equal(resolveDeviceTypeIcon("Headphones"), "🎧");
  assert.equal(resolveDeviceTypeIcon("TV"), "📺");
  assert.equal(resolveDeviceTypeIcon("AVR"), "📻");
  assert.equal(resolveDeviceTypeIcon("AudioDongle"), "🎛️");
  assert.equal(resolveDeviceTypeIcon("unknown"), "🎵");
});
