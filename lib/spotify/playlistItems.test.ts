import assert from "node:assert/strict";
import test from "node:test";
import {
  mapLivePlaylistItems,
  normalizeSpotifyTotal,
  normalizeTrackId,
} from "./playlistItems";

const TRACK_ID = "0123456789ABCDEFGHIJKL";
const PLAYLIST_ID = "ZYXWVUTSRQPONMLKJIHGFE";

test("normalizes Spotify track identifiers from supported forms", () => {
  assert.equal(normalizeTrackId(TRACK_ID), TRACK_ID);
  assert.equal(normalizeTrackId(`spotify:track:${TRACK_ID}`), TRACK_ID);
  assert.equal(
    normalizeTrackId(`https://open.spotify.com/track/${TRACK_ID}?si=example`),
    TRACK_ID
  );
  assert.equal(normalizeTrackId("https://example.com/track/not-valid"), null);
  assert.equal(normalizeTrackId(null), null);
});

test("maps current Spotify playlist item responses", () => {
  const [item] = mapLivePlaylistItems(
    [
      {
        added_at: "2025-01-02T03:04:05.000Z",
        added_by: { id: "spotify-user" },
        item: {
          id: TRACK_ID,
          name: "Track",
          duration_ms: 1234,
          explicit: true,
          is_local: false,
          linked_from: { id: "ZYXWVUTSRQPONMLKJIHGFE" },
          restrictions: { reason: "market" },
          popularity: 42,
          album: {
            id: "album",
            name: "Album",
            release_date: "2025-01-01",
            images: [{ url: "https://i.scdn.co/image/example" }],
          },
          artists: [{ name: "Artist" }, { name: "Guest" }],
        },
      },
    ],
    PLAYLIST_ID,
    10
  );
  assert.equal(item.itemId, `${PLAYLIST_ID}:10:${TRACK_ID}`);
  assert.equal(item.releaseYear, 2025);
  assert.equal(item.explicit, 1);
  assert.equal(item.isLocal, 0);
  assert.equal(item.artists, "Artist, Guest");
  assert.equal(item.position, 10);
  assert.equal(item.playlists[0].id, PLAYLIST_ID);
});

test("supports legacy track responses and absent metadata", () => {
  const [legacy] = mapLivePlaylistItems([{ track: { name: "Legacy" } }], PLAYLIST_ID, 0);
  assert.equal(legacy.name, "Legacy");
  assert.equal(legacy.trackId, null);
  assert.equal(legacy.releaseYear, null);
  assert.equal(legacy.addedAt, null);
  assert.deepEqual(mapLivePlaylistItems(undefined, PLAYLIST_ID, 0), []);
});

test("normalizes upstream totals", () => {
  assert.equal(normalizeSpotifyTotal(10.8), 10);
  assert.equal(normalizeSpotifyTotal(-1), 0);
  assert.equal(normalizeSpotifyTotal(Number.NaN), null);
  assert.equal(normalizeSpotifyTotal("10"), null);
});
