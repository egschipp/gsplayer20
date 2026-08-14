import assert from "node:assert/strict";
import test from "node:test";
import {
  describeEndpoint,
  describeErrorCode,
  describeRecentErrorMessage,
  normalizeEndpointKey,
  normalizeRecentErrorMessage,
} from "./errorPresentation";

test("presents known and unknown Spotify endpoints safely", () => {
  assert.equal(describeEndpoint("me_player").label, "Player controls");
  assert.equal(describeEndpoint("/v1/me/albums").label, "Albums");
  assert.equal(describeEndpoint("").label, "Unknown endpoint");
  assert.equal(normalizeEndpointKey("  ME_PLAYER "), "me_player");
});

test("normalizes structured and plain-text Spotify errors", () => {
  assert.equal(
    normalizeRecentErrorMessage('{"error":{"status":429,"message":"Slow down"}}'),
    "Slow down (429)"
  );
  assert.equal(normalizeRecentErrorMessage("network unavailable"), "network unavailable");
  assert.equal(normalizeRecentErrorMessage(""), "No detail available.");
  assert.equal(
    normalizeRecentErrorMessage('{"error":"session expired"}'),
    "session expired"
  );
  assert.equal(
    normalizeRecentErrorMessage('{"error":{"message":"Bad request"}}'),
    "Bad request"
  );
  assert.equal(normalizeRecentErrorMessage("{}"), "{}");
});

test("maps operational error codes to actionable copy", () => {
  assert.deepEqual(describeErrorCode("RATE_LIMIT"), {
    label: "Rate limit",
    tone: "warn",
    help: "Too many requests at once; backoff is active.",
  });
  assert.equal(describeErrorCode("unexpected").tone, "error");
  for (const code of [
    "NO_ACTIVE_DEVICE",
    "NO_CONNECT_DEVICE",
    "NETWORK_TIMEOUT",
    "NETWORK_TRANSIENT",
    "UNAUTHENTICATED",
    "SPOTIFY_UPSTREAM",
    "NOT_FOUND",
    "PLAYER_NOT_FOUND",
    "NETWORK_FATAL",
  ]) {
    assert.ok(describeErrorCode(code).help.length > 0);
  }
  assert.equal(
    describeRecentErrorMessage({
      code: "NOT_FOUND",
      endpointRaw: "me_player",
      message: "ignored",
    }),
    "No active player found. Start music on a device and try again."
  );
  assert.equal(
    describeRecentErrorMessage({
      code: "NO_CONNECT_DEVICE",
      endpointRaw: "me_player_devices",
      message: "ignored",
    }),
    "No Spotify Connect devices are available."
  );
  assert.equal(
    describeRecentErrorMessage({
      code: "NETWORK_FATAL",
      endpointRaw: "me_player",
      message: "offline",
    }),
    "offline"
  );
});
