import {
  coalesceInflight,
  getCachedValue,
  getUserCacheVersion,
  setCachedValue,
} from "@/lib/spotify/requestCache";

function stableStringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries
      .map(([key, val]) => `${key}:${stableStringify(val)}`)
      .join(",")}}`;
  }
  return String(value);
}

export async function getCachedUserQuery<T>(params: {
  userId: string;
  scope: string;
  keyParts?: unknown;
  ttlMs: number;
  dedupeWindowMs?: number;
  load: () => Promise<T>;
}): Promise<T> {
  const userId = String(params.userId || "anonymous");
  const version = await getUserCacheVersion(userId);
  const cacheKey = `user-query:v${version}:${userId}:${params.scope}:${stableStringify(
    params.keyParts ?? ""
  )}`;
  const cached = getCachedValue<T>(cacheKey);
  if (cached != null) {
    return cached;
  }
  const ttlMs = Math.max(100, Math.floor(params.ttlMs));
  const value = await coalesceInflight<T>(
    cacheKey,
    Math.max(100, Math.floor(params.dedupeWindowMs ?? Math.min(ttlMs, 1500))),
    async () => {
      const fresh = await params.load();
      setCachedValue(cacheKey, fresh, ttlMs, Date.now(), { staleTtlMs: 0 });
      return fresh;
    }
  );
  return value;
}
