import assert from "node:assert/strict";
import test from "node:test";
import { mapTrackApiItems, mapTrackItemToRow } from "./trackApiMapping";

test("maps untrusted API tracks into the internal model", () => {
  const [track] = mapTrackApiItems([
    {
      trackId: "0123456789ABCDEFGHIJKL",
      name: "Track",
      artists: [
        { id: "artist", name: "Artist" },
        { id: "", name: "Ignored" },
      ],
      album: {
        id: "album",
        name: "Album",
        images: [{ url: "https://i.scdn.co/image/example" }],
        release_date: "2025-01-01",
      },
      explicit: true,
      isLocal: false,
      playlists: [
        { id: "playlist", name: "Playlist" },
        { id: "", name: "Ignored" },
      ],
    },
  ]);
  assert.equal(track.id, "0123456789ABCDEFGHIJKL");
  assert.deepEqual(track.artists, [{ id: "artist", name: "Artist" }]);
  assert.equal(track.explicit, 1);
  assert.equal(track.isLocal, 0);
  assert.equal(track.playlists.length, 1);
  assert.equal(
    track.playlists[0].spotifyUrl,
    "https://open.spotify.com/playlist/playlist"
  );
});

test("normalizes absent API fields without throwing", () => {
  const [track] = mapTrackApiItems([{ explicit: false, isLocal: true }]);
  assert.equal(track.id, "");
  assert.equal(track.name, "");
  assert.deepEqual(track.artists, []);
  assert.equal(track.explicit, 0);
  assert.equal(track.isLocal, 1);
  assert.deepEqual(track.playlists, []);
});

test("maps track items to rows and derives release year", () => {
  const row = mapTrackItemToRow({
    id: "0123456789ABCDEFGHIJKL",
    name: "Track",
    artists: [
      { id: "a", name: "Artist" },
      { id: "b", name: "Artist" },
    ],
    album: {
      id: "album",
      name: "Album",
      images: [{ url: "https://i.scdn.co/image/example" }],
      release_date: "2024-05-01",
    },
    playlists: [{ id: "liked", name: "Liked Songs", spotifyUrl: "" }],
  });
  assert.equal(row.trackId, "0123456789ABCDEFGHIJKL");
  assert.equal(row.artists, "Artist");
  assert.equal(row.releaseYear, 2024);
  assert.equal(row.coverUrl, "https://i.scdn.co/image/example");
  assert.equal(
    row.playlists?.[0].spotifyUrl,
    "https://open.spotify.com/collection/tracks"
  );
});
