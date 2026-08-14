import assert from "node:assert/strict";
import test from "node:test";
import {
  collectPlaylistIdsFromTrack,
  dedupeTrackItems,
  dedupeTrackRows,
  dedupeTracksForBulkApply,
  resolveTrackItemCanonicalId,
  resolveTrackRowCanonicalId,
  resolveTrackSelectionKey,
} from "./trackDeduplication";
import type { TrackItem, TrackRow } from "./types";

const TRACK_ID = "0123456789ABCDEFGHIJKL";
const LINKED_ID = "ZYXWVUTSRQPONMLKJIHGFE";

const item: TrackItem = {
  id: TRACK_ID,
  trackId: TRACK_ID,
  name: "Track",
  artists: [{ id: "artist", name: "Artist" }],
  album: { id: null, name: "Album", images: [] },
  playlists: [],
};

test("resolves canonical identities for rows and items", () => {
  const row: TrackRow = { trackId: TRACK_ID, name: "Track" };
  assert.equal(resolveTrackRowCanonicalId(row), TRACK_ID);
  assert.equal(resolveTrackItemCanonicalId(item), TRACK_ID);
  assert.equal(resolveTrackSelectionKey(row), TRACK_ID);
  assert.equal(resolveTrackSelectionKey(item), TRACK_ID);
  assert.equal(resolveTrackSelectionKey(null), null);
  assert.equal(
    resolveTrackRowCanonicalId({
      name: "Linked",
      linkedFromTrackId: `spotify:track:${LINKED_ID}`,
    }),
    LINKED_ID
  );
});

test("collects playlist ids and deduplicates bulk operations", () => {
  const withPlaylists: TrackItem = {
    ...item,
    playlists: [
      { id: "liked", name: "Liked Songs", spotifyUrl: "" },
      { id: "playlist", name: "Playlist", spotifyUrl: "" },
    ],
  };
  assert.deepEqual(
    [...collectPlaylistIdsFromTrack(withPlaylists)],
    ["liked", "playlist"]
  );
  assert.equal(dedupeTracksForBulkApply([item, withPlaylists]).length, 1);
  assert.equal(dedupeTracksForBulkApply([{ name: "No id" }, item]).length, 1);
});

test("deduplicates rows and merges richer metadata", () => {
  const rows = dedupeTrackRows([
    {
      playlistId: "playlist",
      trackId: TRACK_ID,
      name: "Track",
      artists: null,
    },
    {
      playlistId: "playlist",
      trackId: TRACK_ID,
      name: "Track",
      artists: "Artist",
    },
    {
      itemId: "unique-item",
      name: "Other",
    },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].artists, "Artist");
  assert.equal(dedupeTrackRows([]).length, 0);
});

test("deduplicates items by canonical and metadata identities", () => {
  const canonical = dedupeTrackItems([
    item,
    {
      ...item,
      id: TRACK_ID,
      playlists: [{ id: "liked", name: "Liked Songs", spotifyUrl: "" }],
    },
  ]);
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0].playlists[0].id, "liked");

  const metadata = dedupeTrackItems([
    { ...item, id: "invalid", trackId: null },
    { ...item, id: "also-invalid", trackId: null },
  ]);
  assert.equal(metadata.length, 1);
  assert.equal(dedupeTrackItems([]).length, 0);
});
