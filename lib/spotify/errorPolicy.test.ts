import assert from "node:assert/strict";
import test from "node:test";
import { classifySpotifyErrorCode, shouldRetrySpotifyRequest } from "./errorPolicy";

test("distinguishes an extended-quota response from a rolling rate limit", () => {
  assert.equal(
    classifySpotifyErrorCode(
      429,
      JSON.stringify({ error: { reason: "QUOTA_EXCEEDED" } }),
      "me_player",
      "GET"
    ),
    "QUOTA_EXCEEDED"
  );
  assert.equal(classifySpotifyErrorCode(429, "", "me_player", "GET"), "RATE_LIMIT");
});

test("does not automatically repeat non-idempotent Spotify commands", () => {
  assert.equal(shouldRetrySpotifyRequest(503, "POST", "SPOTIFY_UPSTREAM"), false);
  assert.equal(shouldRetrySpotifyRequest(429, "POST", "RATE_LIMIT"), false);
  assert.equal(shouldRetrySpotifyRequest(503, "GET", "SPOTIFY_UPSTREAM"), true);
  assert.equal(shouldRetrySpotifyRequest(429, "PUT", "RATE_LIMIT"), true);
  assert.equal(shouldRetrySpotifyRequest(429, "GET", "QUOTA_EXCEEDED"), false);
});
