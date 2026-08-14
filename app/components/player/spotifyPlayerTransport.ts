import {
  normalizeSpotifyTrackId,
  normalizeTrackIdCollection,
} from "../../../lib/spotify/trackIdentity";

export { normalizeSpotifyTrackId, normalizeTrackIdCollection };
const LEADING_EMOJI_PATTERN =
  /^[\s\u200B-\u200D\u200E\u200F\u2060\uFEFF]*(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]{2}|[#*0-9]\uFE0F?\u20E3)/u;

export type QueueTrackItem = {
  id: string;
  uri: string | null;
  matchTrackIds: string[];
  name: string;
  artists: string;
  coverUrl: string | null;
  durationMs: number | null;
  explicit: boolean;
  isCurrent: boolean;
};

type SpotifyTrackReference = {
  id?: unknown;
  uri?: unknown;
  href?: unknown;
  linked_from?: SpotifyTrackReference | null;
  external_urls?: { spotify?: unknown } | null;
  name?: unknown;
  artists?: Array<{ name?: unknown }> | null;
  album?: { images?: Array<{ url?: unknown }> | null } | null;
  duration_ms?: unknown;
  explicit?: unknown;
};

type SyncPayload = {
  sync?: { serverSeq?: unknown; serverTime?: unknown } | null;
  meta?: { serverSeq?: unknown; serverTime?: unknown } | null;
  serverSeq?: unknown;
  serverTime?: unknown;
  timestamp?: unknown;
};

function asOptionalString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asSyncPayload(value: unknown): SyncPayload | null {
  return value !== null && typeof value === "object" ? (value as SyncPayload) : null;
}

export async function readJsonSafely<T = any>(
  response: Response | null | undefined
): Promise<T | null> {
  if (!response) return null;
  if ([204, 205, 304].includes(response.status)) return null;
  if (response.headers.get("content-length") === "0") return null;
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function parseSpotifyPlayerApiUrl(input: string) {
  try {
    const parsed = new URL(input);
    if (parsed.origin !== "https://api.spotify.com") return null;
    if (!parsed.pathname.startsWith("/v1/me/player")) return null;
    return {
      endpoint: parsed.pathname.slice("/v1/me/player".length),
      search: parsed.search || "",
    };
  } catch {
    return null;
  }
}

export const normalizePlaybackTrackId = normalizeSpotifyTrackId;

export function resolvePlaybackTrackId(item: SpotifyTrackReference | null | undefined) {
  return (
    normalizePlaybackTrackId(asOptionalString(item?.id)) ??
    normalizePlaybackTrackId(asOptionalString(item?.uri)) ??
    normalizePlaybackTrackId(asOptionalString(item?.href)) ??
    normalizePlaybackTrackId(asOptionalString(item?.linked_from?.id)) ??
    normalizePlaybackTrackId(asOptionalString(item?.linked_from?.uri)) ??
    normalizePlaybackTrackId(asOptionalString(item?.linked_from?.href)) ??
    normalizePlaybackTrackId(asOptionalString(item?.external_urls?.spotify))
  );
}

export function resolvePlaybackTrackIds(item: SpotifyTrackReference | null | undefined) {
  return normalizeTrackIdCollection([
    asOptionalString(item?.id),
    asOptionalString(item?.uri),
    asOptionalString(item?.href),
    asOptionalString(item?.linked_from?.id),
    asOptionalString(item?.linked_from?.uri),
    asOptionalString(item?.linked_from?.href),
    asOptionalString(item?.external_urls?.spotify),
  ]);
}

export function mapQueueTrackItem(
  track: SpotifyTrackReference | null | undefined,
  fallbackIndex = 0
): QueueTrackItem {
  const normalizedId = resolvePlaybackTrackId(track);
  const matchTrackIds = resolvePlaybackTrackIds(track);
  const uri = typeof track?.uri === "string" ? track.uri : null;
  return {
    id: normalizedId ?? `${uri ?? "queue-track"}:${fallbackIndex}`,
    uri,
    matchTrackIds,
    name: typeof track?.name === "string" ? track.name : "Unknown track",
    artists: Array.isArray(track?.artists)
      ? track.artists
          .map((artist) => artist?.name)
          .filter((name): name is string => typeof name === "string" && name.length > 0)
          .join(", ")
      : "",
    coverUrl:
      typeof track?.album?.images?.[0]?.url === "string"
        ? track.album.images[0].url
        : null,
    durationMs:
      typeof track?.duration_ms === "number"
        ? Math.max(0, Math.floor(track.duration_ms))
        : null,
    explicit: Boolean(track?.explicit),
    isCurrent: false,
  };
}

export function extractProxyPayload(body: RequestInit["body"]) {
  if (!body) return undefined;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  if (body instanceof URLSearchParams) {
    return Object.fromEntries(body.entries());
  }
  return body;
}

export function createCommandId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Fall back to a locally unique command id.
  }
  return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function startsWithEmoji(value: string | null | undefined) {
  return LEADING_EMOJI_PATTERN.test(String(value ?? ""));
}

export function findBestQueueMatchIndex(
  items: QueueTrackItem[],
  activeTrackIds: Set<string>
) {
  if (!items.length || !activeTrackIds.size) return -1;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const candidates = normalizeTrackIdCollection([
      item.id,
      item.uri,
      ...item.matchTrackIds,
    ]);
    if (candidates.some((candidate) => activeTrackIds.has(candidate))) return index;
  }
  return -1;
}

export function emitPlaybackDebugEvent(event: string, payload: Record<string, unknown>) {
  if (process.env.NODE_ENV === "production") return;
  try {
    console.debug(`[player:${event}]`, payload);
  } catch {
    // Diagnostics must never interrupt playback.
  }
}

export function readSyncServerSeq(value: unknown): number {
  const payload = asSyncPayload(value);
  const candidate =
    payload?.sync?.serverSeq ?? payload?.serverSeq ?? payload?.meta?.serverSeq ?? 0;
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? Math.max(0, Math.floor(candidate))
    : 0;
}

export function readSyncServerTime(value: unknown): number {
  const payload = asSyncPayload(value);
  const candidate =
    payload?.sync?.serverTime ??
    payload?.serverTime ??
    payload?.meta?.serverTime ??
    payload?.timestamp ??
    Date.now();
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? Math.max(0, Math.floor(candidate))
    : Date.now();
}
