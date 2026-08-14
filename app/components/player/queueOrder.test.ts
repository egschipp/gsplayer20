import assert from "node:assert/strict";
import test from "node:test";
import { buildShuffleOrder, getIndexFromTrackId } from "./queueOrder";

test("finds queue positions by canonical Spotify track id", () => {
  const uris = ["spotify:track:first", "spotify:track:second"];
  assert.equal(getIndexFromTrackId(uris, "second"), 1);
  assert.equal(getIndexFromTrackId(uris, "missing"), -1);
  assert.equal(getIndexFromTrackId(uris, null), -1);
});

test("keeps the active track first while shuffling every queue index", () => {
  const order = buildShuffleOrder(4, 2, () => 0);
  assert.equal(order[0], 2);
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    [0, 1, 2, 3]
  );
});

test("bounds malformed queue sizes and start positions", () => {
  assert.deepEqual(buildShuffleOrder(-1, 10), []);
  assert.deepEqual(buildShuffleOrder(1, 10), [0]);
  assert.equal(buildShuffleOrder(3, 99, () => 0)[0], 2);
  assert.equal(buildShuffleOrder(3, -1, () => 0)[0], 0);
});
