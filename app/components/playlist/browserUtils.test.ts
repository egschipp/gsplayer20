import assert from "node:assert/strict";
import test from "node:test";
import {
  buildApiUrl,
  getTrackPageSize,
  getTrackPrefetchMaxPages,
  parseRetryAfterMs,
  safeReadStorage,
  safeRemoveStorageKey,
  safeWriteStorage,
} from "./browserUtils";

function createStorage(overrides: Partial<Storage> = {}) {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    ...overrides,
  } as Storage;
}

test("builds encoded API URLs and omits empty values", () => {
  assert.equal(
    buildApiUrl("/api/tracks", {
      query: "Beyoncé & Jay-Z",
      cursor: null,
      filter: "",
    }),
    "/api/tracks?query=Beyonc%C3%A9+%26+Jay-Z"
  );
  assert.equal(buildApiUrl("/api/tracks"), "/api/tracks");
});

test("parses retry-after seconds and rejects invalid values", () => {
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "1.5" })), 1500);
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "invalid" })), null);
  assert.equal(parseRetryAfterMs(new Headers()), null);
});

test("parses retry-after HTTP dates without returning negative delays", () => {
  const delay = parseRetryAfterMs(
    new Headers({ "retry-after": new Date(Date.now() + 5_000).toUTCString() })
  );
  assert.ok(delay !== null && delay >= 3_500 && delay <= 5_000);
  assert.equal(
    parseRetryAfterMs(
      new Headers({ "retry-after": new Date(Date.now() - 5_000).toUTCString() })
    ),
    0
  );
});

test("selects Spotify-compatible page and warmup limits", () => {
  assert.equal(getTrackPageSize("playlists", "liked"), 50);
  assert.equal(getTrackPageSize("playlists", "playlist"), 100);
  assert.equal(getTrackPageSize("artists", null), 100);
  assert.equal(getTrackPrefetchMaxPages(100), 4);
  assert.equal(getTrackPrefetchMaxPages(500), 1);
});

test("storage helpers isolate unavailable browser storage", () => {
  const storage = createStorage();
  assert.equal(safeWriteStorage(storage, "key", "value"), true);
  assert.equal(safeReadStorage(storage, "key"), "value");
  safeRemoveStorageKey(storage, "key");
  assert.equal(safeReadStorage(storage, "key"), null);

  const unavailable = createStorage({
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  });
  assert.equal(safeReadStorage(unavailable, "key"), null);
  assert.equal(safeWriteStorage(unavailable, "key", "value"), false);
  assert.doesNotThrow(() => safeRemoveStorageKey(unavailable, "key"));
});
