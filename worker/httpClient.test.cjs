const assert = require("node:assert/strict");
const test = require("node:test");
const { createFetchWithTimeout, sanitizeErrorMessage } = require("./httpClient.cjs");

function rejectWhenAborted(signal) {
  return new Promise((resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("Aborted", "AbortError")),
      { once: true }
    );
  });
}

test("returns fetch responses and supplies an abort signal", async () => {
  let receivedSignal = null;
  const expected = { ok: true };
  const fetchWithTimeout = createFetchWithTimeout({
    fetchImpl: async (_url, options) => {
      receivedSignal = options.signal;
      return expected;
    },
  });

  assert.equal(await fetchWithTimeout("https://api.spotify.com/v1/me"), expected);
  assert.ok(receivedSignal instanceof AbortSignal);
  assert.equal(receivedSignal.aborted, false);
});

test("marks only its own timeout as retryable", async () => {
  const fetchWithTimeout = createFetchWithTimeout({
    fetchImpl: (_url, options) => rejectWhenAborted(options.signal),
    defaultTimeoutMs: 5,
  });

  await assert.rejects(fetchWithTimeout("https://api.spotify.com/v1/me"), {
    message: "Timeout",
    code: "SPOTIFY_FETCH_TIMEOUT",
    retryable: true,
  });
});

test("preserves a caller-initiated abort", async () => {
  const caller = new AbortController();
  const fetchWithTimeout = createFetchWithTimeout({
    fetchImpl: (_url, options) => rejectWhenAborted(options.signal),
    defaultTimeoutMs: 5_000,
  });
  const request = fetchWithTimeout("https://api.spotify.com/v1/me", {
    signal: caller.signal,
  });
  caller.abort();

  await assert.rejects(request, (error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.retryable, undefined);
    return true;
  });
});

test("redacts bearer credentials and bounds persisted errors", () => {
  const message = sanitizeErrorMessage(
    `Request failed: bearer secret-token ${"x".repeat(600)}`
  );
  assert.equal(message.includes("secret-token"), false);
  assert.match(message, /Bearer \[redacted\]/i);
  assert.equal(message.length, 500);
});

test("requires a usable fetch implementation", () => {
  assert.throws(() => createFetchWithTimeout({ fetchImpl: null }), TypeError);
});
