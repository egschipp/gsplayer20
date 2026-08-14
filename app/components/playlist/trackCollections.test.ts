import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeTrackItems,
  mergeTrackOptions,
  mergeTrackPlaylists,
  mergeTrackRows,
} from "./trackCollections";
import type { TrackItem, TrackRow } from "./types";

const baseItem: TrackItem = {
  id: "0123456789ABCDEFGHIJKL",
  trackId: null,
  name: "Track",
  artists: [{ id: "artist-1", name: "Artist" }],
  album: { id: null, name: "Album", images: [], release_date: null },
  durationMs: null,
  playlists: [],
};

test("merges playlist membership without duplicates", () => {
  const merged = mergeTrackPlaylists(
    [{ id: "b", name: "Beta", spotifyUrl: "" }],
    [
      { id: "a", name: "Alpha", spotifyUrl: "https://example.test/a" },
      { id: "b", name: "", spotifyUrl: "https://example.test/b" },
    ]
  );
  assert.deepEqual(
    merged?.map((playlist) => playlist.id),
    ["a", "b"]
  );
  assert.equal(merged?.[1].name, "Beta");
  assert.equal(mergeTrackPlaylists(), undefined);
});

test("fills missing row metadata without overwriting established values", () => {
  const existing: TrackRow = {
    trackId: "0123456789ABCDEFGHIJKL",
    name: "Existing",
    artists: null,
    durationMs: null,
  };
  const incoming: TrackRow = {
    trackId: "ignored",
    name: "Incoming",
    artists: "Artist",
    durationMs: 1234,
    popularity: 80,
  };
  const merged = mergeTrackRows(existing, incoming);
  assert.equal(merged.trackId, existing.trackId);
  assert.equal(merged.name, "Existing");
  assert.equal(merged.artists, "Artist");
  assert.equal(merged.durationMs, 1234);
  assert.equal(merged.popularity, 80);
});

test("merges track item artists, artwork and playlists", () => {
  const merged = mergeTrackItems(baseItem, {
    ...baseItem,
    id: "second",
    trackId: "0123456789ABCDEFGHIJKL",
    artists: [
      { id: "artist-1", name: "Artist duplicate" },
      { id: "artist-2", name: "Guest" },
    ],
    album: {
      id: "album-1",
      name: "Album",
      images: [{ url: "https://i.scdn.co/image/example" }],
      release_date: "2026",
    },
    playlists: [{ id: "liked", name: "Liked Songs", spotifyUrl: "" }],
  });
  assert.equal(merged.id, baseItem.id);
  assert.equal(merged.trackId, "0123456789ABCDEFGHIJKL");
  assert.deepEqual(
    merged.artists.map((artist) => artist.id),
    ["artist-1", "artist-2"]
  );
  assert.equal(merged.album.images.length, 1);
  assert.equal(merged.playlists[0].id, "liked");
});

test("merges searchable track options and upgrades missing artwork", () => {
  const options = mergeTrackOptions(
    [
      {
        id: "track",
        name: "Track",
        spotifyUrl: "https://open.spotify.com/track/old",
        coverUrl: null,
      },
    ],
    [
      {
        ...baseItem,
        album: {
          ...baseItem.album,
          images: [{ url: "https://i.scdn.co/image/example" }],
        },
      },
      { ...baseItem, id: "", name: "" },
    ]
  );
  assert.equal(options.length, 1);
  assert.equal(options[0].coverUrl, "https://i.scdn.co/image/example");
  assert.equal(options[0].trackId, baseItem.id);
});
