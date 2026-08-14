function sanitizeErrorMessage(error) {
  return String(error)
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .slice(0, 500);
}

function createFetchWithTimeout({
  fetchImpl = globalThis.fetch,
  defaultTimeoutMs = 15_000,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required");
  }

  return async function fetchWithTimeout(
    url,
    options = {},
    timeoutMs = defaultTimeoutMs
  ) {
    const timeoutController = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...options, signal });
    } catch (error) {
      if (timeoutController.signal.aborted) {
        const timeoutError = new Error("Timeout");
        timeoutError.code = "SPOTIFY_FETCH_TIMEOUT";
        timeoutError.retryable = true;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
}

module.exports = { createFetchWithTimeout, sanitizeErrorMessage };
