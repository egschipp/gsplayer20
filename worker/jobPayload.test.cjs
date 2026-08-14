const assert = require("node:assert/strict");
const test = require("node:test");
const {
  clampInt,
  envInt,
  normalizeCursor,
  normalizePlaylistId,
  parseJobPayload,
  sanitizeRequeuePayload,
} = require("./jobPayload.cjs");

const PLAYLIST_ID = "0123456789ABCDEFGHIJKL";

test("clamps numeric job settings to explicit bounds", () => {
  assert.equal(clampInt("4.9", 1, 10, 3), 4);
  assert.equal(clampInt(-1, 1, 10, 3), 1);
  assert.equal(clampInt(99, 1, 10, 3), 10);
  assert.equal(clampInt("invalid", 1, 10, 3), 3);
  assert.equal(envInt("LIMIT", 1, 50, 10, { LIMIT: "25" }), 25);
});

test("parses only JSON object payloads", () => {
  assert.deepEqual(parseJobPayload('{"limit":10}'), { limit: 10 });
  assert.deepEqual(parseJobPayload("[1,2,3]"), {});
  assert.deepEqual(parseJobPayload("invalid"), {});
  assert.deepEqual(parseJobPayload(null), {});
});

test("normalizes Spotify cursors and playlist identifiers", () => {
  assert.equal(normalizeCursor("a".repeat(256)).length, 128);
  assert.equal(normalizeCursor(42), "");
  assert.equal(normalizePlaylistId(PLAYLIST_ID), PLAYLIST_ID);
  assert.equal(normalizePlaylistId("../not-a-playlist"), null);
});

test("bounds requeued pagination state", () => {
  assert.deepEqual(
    sanitizeRequeuePayload(
      "SYNC_TRACK_METADATA",
      { limit: 500, maxPagesPerRun: -1, maxBatches: "invalid" },
      { nextOffset: 200_000, nextCursor: "x".repeat(256) }
    ),
    {
      limit: 50,
      maxPagesPerRun: 1,
      maxBatches: 20,
      offset: 100_000,
      cursor: "x".repeat(128),
    }
  );
});

test("sanitizes playlist requeue identity fields", () => {
  const valid = sanitizeRequeuePayload(
    "SYNC_PLAYLIST_ITEMS",
    {
      playlistId: PLAYLIST_ID,
      runId: "run",
      snapshotId: "snapshot",
    },
    {}
  );
  assert.deepEqual(valid, {
    playlistId: PLAYLIST_ID,
    runId: "run",
    snapshotId: "snapshot",
  });

  const invalid = sanitizeRequeuePayload(
    "SYNC_PLAYLIST_ITEMS",
    {
      playlistId: "invalid",
      runId: "x".repeat(129),
      snapshotId: "x".repeat(257),
    },
    {}
  );
  assert.equal("playlistId" in invalid, false);
  assert.match(invalid.runId, /^[0-9a-f-]{36}$/i);
  assert.equal(invalid.snapshotId, null);
});
