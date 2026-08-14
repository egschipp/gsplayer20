import assert from "node:assert/strict";
import test from "node:test";
import {
  findBestTrackMatchIndex,
  isCurrentTrackMatch,
  normalizeTrackIdCollection,
} from "./trackMatching";
import type { TrackRow } from "./types";

const PRIMARY_ID = "0123456789ABCDEFGHIJKL";
const LINKED_ID = "ZYXWVUTSRQPONMLKJIHGFE";

function row(overrides: Partial<TrackRow> = {}): TrackRow {
  return {
    id: PRIMARY_ID,
    trackId: PRIMARY_ID,
    linkedFromTrackId: null,
    name: "Track",
    artistNames: "Artist",
    albumName: "Album",
    durationMs: 1000,
    explicit: false,
    coverUrl: null,
    ...overrides,
  } as TrackRow;
}

test("matches canonical ids before relinked fallbacks", () => {
  const items = [
    row({ id: "first", trackId: null, linkedFromTrackId: LINKED_ID }),
    row({ id: "second", trackId: LINKED_ID }),
  ];
  assert.equal(findBestTrackMatchIndex(items, new Set([LINKED_ID])), 1);
  assert.equal(isCurrentTrackMatch(items[0], new Set([LINKED_ID])), false);
});

test("deduplicates normalized track identifiers", () => {
  assert.deepEqual(
    normalizeTrackIdCollection([PRIMARY_ID, `spotify:track:${PRIMARY_ID}`, null]),
    [PRIMARY_ID]
  );
});
