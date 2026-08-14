import assert from "node:assert/strict";
import test from "node:test";
import {
  findBestQueueMatchIndex,
  mapQueueTrackItem,
  normalizePlaybackTrackId,
  parseSpotifyPlayerApiUrl,
  readJsonSafely,
  readSyncServerSeq,
} from "./spotifyPlayerTransport";

const TRACK_ID = "0123456789ABCDEFGHIJKL";

test("normalizes supported Spotify track identifiers", () => {
  assert.equal(normalizePlaybackTrackId(TRACK_ID), TRACK_ID);
  assert.equal(normalizePlaybackTrackId(`spotify:track:${TRACK_ID}`), TRACK_ID);
  assert.equal(
    normalizePlaybackTrackId(`https://open.spotify.com/track/${TRACK_ID}?si=test`),
    TRACK_ID
  );
  assert.equal(normalizePlaybackTrackId("spotify:album:invalid"), null);
});

test("only accepts Spotify player API URLs", () => {
  assert.deepEqual(
    parseSpotifyPlayerApiUrl("https://api.spotify.com/v1/me/player/play?device_id=x"),
    { endpoint: "/play", search: "?device_id=x" }
  );
  assert.equal(parseSpotifyPlayerApiUrl("https://example.com/v1/me/player"), null);
  assert.equal(parseSpotifyPlayerApiUrl("https://api.spotify.com/v1/me/tracks"), null);
});

test("maps queue tracks and matches linked identifiers", () => {
  const item = mapQueueTrackItem({
    id: TRACK_ID,
    uri: `spotify:track:${TRACK_ID}`,
    name: "Track",
    artists: [{ name: "Artist" }],
    duration_ms: 1234.9,
  });
  assert.equal(item.durationMs, 1234);
  assert.equal(item.artists, "Artist");
  assert.equal(findBestQueueMatchIndex([item], new Set([TRACK_ID])), 0);
});

test("reads empty and malformed JSON responses safely", async () => {
  assert.equal(await readJsonSafely(new Response(null, { status: 204 })), null);
  assert.equal(await readJsonSafely(new Response("not json")), null);
  assert.deepEqual(await readJsonSafely(new Response('{"ok":true}')), { ok: true });
});

test("normalizes server sequence numbers", () => {
  assert.equal(readSyncServerSeq({ sync: { serverSeq: 4.9 } }), 4);
  assert.equal(readSyncServerSeq({ serverSeq: -2 }), 0);
  assert.equal(readSyncServerSeq({ serverSeq: "4" }), 0);
});
