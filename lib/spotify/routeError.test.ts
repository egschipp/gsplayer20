import assert from "node:assert/strict";
import test from "node:test";
import { SpotifyFetchError } from "./errors";
import { mapSpotifyRouteError } from "./routeError";

test("maps known Spotify response statuses to stable route errors", () => {
  assert.deepEqual(mapSpotifyRouteError(new SpotifyFetchError(401, "auth")), {
    code: "UNAUTHENTICATED",
    status: 401,
  });
  assert.deepEqual(mapSpotifyRouteError(new SpotifyFetchError(403, "scope")), {
    code: "FORBIDDEN",
    status: 403,
  });
  assert.deepEqual(
    mapSpotifyRouteError(new SpotifyFetchError(404, "missing"), {
      notFoundCode: "PLAYLIST_NOT_FOUND",
    }),
    { code: "PLAYLIST_NOT_FOUND", status: 404 }
  );
  assert.deepEqual(mapSpotifyRouteError(new SpotifyFetchError(429, "limited")), {
    code: "SPOTIFY_RATE_LIMIT",
    status: 429,
  });
  assert.deepEqual(mapSpotifyRouteError(new SpotifyFetchError(503, "down")), {
    code: "SPOTIFY_UPSTREAM",
    status: 502,
  });
});

test("maps missing sessions and unknown failures safely", () => {
  assert.deepEqual(mapSpotifyRouteError(new Error("UserNotAuthenticated")), {
    code: "UNAUTHENTICATED",
    status: 401,
  });
  assert.deepEqual(mapSpotifyRouteError(new Error("secret internal failure")), {
    code: "SPOTIFY_UPSTREAM",
    status: 502,
  });
});
