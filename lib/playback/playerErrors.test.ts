import assert from "node:assert/strict";
import test from "node:test";
import {
  getPlayerErrorMessage,
  normalizePlayerError,
} from "./playerErrors";

test("normalizes spotify status codes into typed player errors", () => {
  const details = normalizePlayerError({
    status: 401,
  });
  assert.equal(details.code, "UNAUTHENTICATED");
  assert.equal(details.message, "Spotify session expired. Sign in again.");
});

test("keeps retry timing when rate limited", () => {
  const details = normalizePlayerError({
    status: 429,
    retryAfterSec: 7,
  });
  assert.equal(details.code, "RATE_LIMITED");
  assert.equal(details.retryAfterSec, 7);
  assert.equal(details.message, "Spotify is busy. Try again in 7s.");
});

test("recognizes explicit player-not-ready messages", () => {
  const details = normalizePlayerError({
    message: "PLAYER_NOT_READY",
  });
  assert.equal(details.code, "PLAYER_NOT_READY");
  assert.equal(
    details.message,
    "Spotify player is not ready yet. Try again in a few seconds."
  );
});

test("provides a stable fallback for unknown errors", () => {
  assert.equal(
    getPlayerErrorMessage("UNKNOWN"),
    "Playback is unavailable right now."
  );
});
