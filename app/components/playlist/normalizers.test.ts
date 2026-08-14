import assert from "node:assert/strict";
import test from "node:test";
import {
  createAlbumOptionId,
  createAlbumOptionIdFromTrackRow,
  createTrackItemFromTrackRow,
  isTrackItem,
  normalizeAlbumOptions,
  normalizeArtistOptions,
  normalizePlaylistOptions,
  normalizeTrackName,
  resolveTrackItemArtistNames,
  sortPlaylistLinks,
  startsWithEmoji,
  toPlaylistLink,
} from "./normalizers";
import type { PlaylistOption, TrackItem, TrackRow } from "./types";

const trackItem: TrackItem = {
  id: "0123456789ABCDEFGHIJKL",
  trackId: "0123456789ABCDEFGHIJKL",
  name: "Track",
  artists: [
    { id: "a", name: "Artist" },
    { id: "b", name: "Artist" },
  ],
  album: {
    id: "album-1",
    name: "Album",
    images: [{ url: "https://i.scdn.co/image/example" }],
    release_date: "2026-01-01",
  },
  playlists: [],
};

test("normalizes labels, emoji and playlist ordering", () => {
  assert.equal(normalizeTrackName("  HéLLo   World "), "héllo world");
  assert.equal(startsWithEmoji("🎵 Music"), true);
  assert.equal(startsWithEmoji("Music"), false);
  assert.deepEqual(
    sortPlaylistLinks([
      { id: "2", name: "Zulu", spotifyUrl: "z" },
      { id: "1", name: "Alpha", spotifyUrl: "a" },
    ]).map((item) => item.id),
    ["1", "2"]
  );
  assert.deepEqual(sortPlaylistLinks(null), []);
});

test("deduplicates and sorts artist options", () => {
  assert.deepEqual(
    normalizeArtistOptions([
      { id: "2", name: "Zulu", spotifyUrl: "" },
      { id: "1", name: "Alpha", spotifyUrl: "https://example.test/a" },
      { id: "2", name: "Zulu updated", spotifyUrl: "" },
      { id: "", name: "ignored", spotifyUrl: "" },
    ]).map(({ id, name }) => ({ id, name })),
    [
      { id: "1", name: "Alpha" },
      { id: "2", name: "Zulu updated" },
    ]
  );
});

test("builds stable album and track item identities", () => {
  assert.equal(resolveTrackItemArtistNames(trackItem), "Artist");
  assert.equal(createAlbumOptionId(trackItem, "Artist"), "id:album-1");

  const row: TrackRow = {
    trackId: "0123456789ABCDEFGHIJKL",
    name: "Track",
    albumId: null,
    albumName: "Album",
    artists: "Artist, Guest",
    coverUrl: "https://i.scdn.co/image/example",
  };
  assert.equal(createAlbumOptionIdFromTrackRow(row), "meta:album::artist, guest");
  const converted = createTrackItemFromTrackRow(row);
  assert.equal(converted.id, row.trackId);
  assert.deepEqual(
    converted.artists.map((artist) => artist.name),
    ["Artist", "Guest"]
  );
  assert.equal(isTrackItem(converted), true);
  assert.equal(isTrackItem(row), false);
});

test("normalizes album options and retains artwork", () => {
  const options = normalizeAlbumOptions([
    trackItem,
    {
      ...trackItem,
      id: "second",
      album: { ...trackItem.album, images: [] },
    },
  ]);
  assert.equal(options.length, 1);
  assert.equal(options[0].coverUrl, "https://i.scdn.co/image/example");
  assert.equal(options[0].spotifyUrl, "https://open.spotify.com/album/album-1");
});

test("keeps synthetic playlist choices first and maps links", () => {
  const playlist: PlaylistOption = {
    id: "playlist-1",
    name: "Road trip",
    type: "playlist",
    spotifyUrl: "",
  };
  const normalized = normalizePlaylistOptions([playlist]);
  assert.deepEqual(
    normalized.slice(0, 3).map((option) => option.id),
    ["liked", "all_my_music", "playlist-1"]
  );
  assert.equal(
    toPlaylistLink(playlist).spotifyUrl,
    "https://open.spotify.com/playlist/playlist-1"
  );
  assert.equal(toPlaylistLink(normalized[0]).id, "liked");
  assert.equal(toPlaylistLink(normalized[1]).spotifyUrl, "https://open.spotify.com");
});
