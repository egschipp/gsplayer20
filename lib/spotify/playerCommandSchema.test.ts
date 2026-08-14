import assert from "node:assert/strict";
import test from "node:test";
import { validatePlayerCommand } from "./playerCommandSchema";

test("accepts a bounded play command", () => {
  assert.deepEqual(
    validatePlayerCommand({
      method: "PUT",
      endpoint: "/play",
      search: "?device_id=device123",
      payload: { uris: ["spotify:track:4uLU6hMCjMI75M1A2tKUQC"] },
    }),
    { ok: true }
  );
});

test("rejects method confusion and unapproved query parameters", () => {
  assert.deepEqual(
    validatePlayerCommand({ method: "POST", endpoint: "/play", search: "" }),
    { ok: false, error: "INVALID_COMMAND" }
  );
  assert.deepEqual(
    validatePlayerCommand({
      method: "PUT",
      endpoint: "/volume",
      search: "?volume_percent=101&redirect=https://example.com",
    }),
    { ok: false, error: "INVALID_QUERY" }
  );
});

test("rejects invalid Spotify URIs and unknown payload fields", () => {
  assert.deepEqual(
    validatePlayerCommand({
      method: "POST",
      endpoint: "/queue",
      search: "?uri=https://example.com/audio",
    }),
    { ok: false, error: "INVALID_QUERY" }
  );
  assert.deepEqual(
    validatePlayerCommand({
      method: "PUT",
      endpoint: "/play",
      search: "",
      payload: { uris: ["spotify:track:4uLU6hMCjMI75M1A2tKUQC"], extra: true },
    }),
    { ok: false, error: "INVALID_PAYLOAD" }
  );
});
