import { CORRELATION_HEADER } from "@/lib/observability/correlation";

function createBrowserCorrelationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `cid_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export async function clientFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.get(CORRELATION_HEADER)) {
    headers.set(CORRELATION_HEADER, createBrowserCorrelationId());
  }
  return fetch(input, {
    ...init,
    headers,
    cache: init.cache ?? "no-store",
  });
}

