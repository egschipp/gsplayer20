import crypto from "crypto";
import { inArray } from "drizzle-orm";
import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { getDb } from "@/lib/db/client";
import { trackArtists } from "@/lib/db/schema";
import { getCachedValue } from "@/lib/recommendations/cache";
import { getPlaylistSeedSource } from "@/lib/recommendations/playlistSeedSource";
import {
  createRecommendationsTraceLogger,
  type RecommendationsTraceEntry,
} from "@/lib/recommendations/troubleshootingLog";
import {
  normalizeTrackId,
  selectDeterministicPlaylistSeedPool,
} from "@/lib/recommendations/seedSelector";
import {
  type PlaylistRecommendationsPayload,
  type RecommendationsSeedDiagnostics,
  type RecommendationItem,
  RecommendationsServiceError,
} from "@/lib/recommendations/types";

const PLAYLIST_ID_REGEX = /^[A-Za-z0-9]{22}$/;

type RecommendationsMode = "auto" | "on" | "off";

type RecommendationsResponse = {
  tracks?: Array<{
    id?: string | null;
    name?: string | null;
    duration_ms?: number;
    explicit?: boolean;
    is_local?: boolean;
    is_playable?: boolean;
    linked_from?: { id?: string | null };
    restrictions?: { reason?: string | null };
    popularity?: number;
    album?: {
      id?: string | null;
      name?: string | null;
      release_date?: string | null;
      images?: Array<{ url?: string | null }>;
    };
    artists?: Array<{ id?: string | null; name?: string | null }>;
  }>;
};

type TracksLookupResponse = {
  tracks?: Array<
    | {
        id?: string | null;
        type?: string | null;
        is_playable?: boolean;
        restrictions?: { reason?: string | null } | null;
        artists?: Array<{ id?: string | null }>;
      }
    | null
  >;
};

type TracksLookupItem = NonNullable<NonNullable<TracksLookupResponse["tracks"]>[number]>;

type CachedRecommendationsPayload = Omit<PlaylistRecommendationsPayload, "cacheState">;

type SeedAttempt = {
  seedTracks: string[];
  seedArtists: string[];
  key: string;
};

type ValidatedSeedBundle = {
  trackIds: string[];
  artistIds: string[];
  hadValidationFailure: boolean;
};

type RecommendationsTraceFn = (
  stage: string,
  details?: {
    level?: RecommendationsTraceEntry["level"];
    status?: number;
    durationMs?: number;
    code?: string;
    message?: string;
    data?: Record<string, unknown>;
    playlistId?: string;
  }
) => void;

const traceNoop: RecommendationsTraceFn = () => undefined;

function clampInt(value: number, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

const RECOMMENDATIONS_MODE: RecommendationsMode = (() => {
  const raw = String(process.env.SPOTIFY_RECOMMENDATIONS_V1_MODE ?? "auto")
    .trim()
    .toLowerCase();
  if (raw === "on" || raw === "off") return raw;
  return "auto";
})();

const RECOMMENDATIONS_UNSUPPORTED_TTL_MS = clampInt(
  Number(process.env.SPOTIFY_RECOMMENDATIONS_UNSUPPORTED_TTL_MS ?? "300000"),
  300_000,
  60_000,
  3_600_000
);

const RECOMMENDATIONS_MAX_ATTEMPTS = clampInt(
  Number(process.env.SPOTIFY_RECOMMENDATIONS_MAX_ATTEMPTS ?? "5"),
  5,
  1,
  10
);

const RECOMMENDATIONS_UPSTREAM_TIMEOUT_MS = clampInt(
  Number(process.env.SPOTIFY_RECOMMENDATIONS_UPSTREAM_TIMEOUT_MS ?? "8000"),
  8_000,
  2_000,
  20_000
);

const RECOMMENDATIONS_UPSTREAM_MAX_ATTEMPTS = clampInt(
  Number(process.env.SPOTIFY_RECOMMENDATIONS_UPSTREAM_MAX_ATTEMPTS ?? "3"),
  3,
  1,
  3
);

const RECOMMENDATIONS_FALLBACK_ARTIST_LIMIT = clampInt(
  Number(process.env.SPOTIFY_RECOMMENDATIONS_FALLBACK_ARTIST_LIMIT ?? "8"),
  8,
  1,
  20
);

const RECOMMENDATIONS_CACHE_TTL_MS = clampInt(
  Number(process.env.SPOTIFY_RECOMMENDATIONS_CACHE_TTL_MS ?? "120000"),
  120_000,
  10_000,
  900_000
);

const RECOMMENDATIONS_CACHE_STALE_MS = clampInt(
  Number(process.env.SPOTIFY_RECOMMENDATIONS_CACHE_STALE_MS ?? "600000"),
  600_000,
  RECOMMENDATIONS_CACHE_TTL_MS,
  3_600_000
);

const RECOMMENDATIONS_LAST_SUCCESS_TTL_MS = clampInt(
  Number(process.env.SPOTIFY_RECOMMENDATIONS_LAST_SUCCESS_TTL_MS ?? "1800000"),
  1_800_000,
  60_000,
  7_200_000
);

const RECOMMENDATIONS_SEED_VALIDATION_TTL_MS = clampInt(
  Number(process.env.SPOTIFY_RECOMMENDATIONS_SEED_VALIDATION_TTL_MS ?? "180000"),
  180_000,
  10_000,
  900_000
);

const RECOMMENDATIONS_SEED_VALIDATION_STALE_MS = clampInt(
  Number(process.env.SPOTIFY_RECOMMENDATIONS_SEED_VALIDATION_STALE_MS ?? "900000"),
  900_000,
  RECOMMENDATIONS_SEED_VALIDATION_TTL_MS,
  3_600_000
);

const RECOMMENDATIONS_ENABLE_PREVALIDATION =
  String(process.env.SPOTIFY_RECOMMENDATIONS_ENABLE_PREVALIDATION ?? "false")
    .trim()
    .toLowerCase() === "true";

const RECOMMENDATIONS_ENABLE_ARTIST_FALLBACK =
  String(process.env.SPOTIFY_RECOMMENDATIONS_ENABLE_ARTIST_FALLBACK ?? "false")
    .trim()
    .toLowerCase() === "true";

const RECOMMENDATIONS_REQUEST_MAX_ATTEMPTS = clampInt(
  Number(process.env.SPOTIFY_RECOMMENDATIONS_REQUEST_MAX_ATTEMPTS ?? "1"),
  1,
  1,
  2
);

type LastSuccessEntry = {
  payload: CachedRecommendationsPayload;
  expiresAt: number;
};

const lastSuccessByPlaylist = new Map<string, LastSuccessEntry>();

const recommendationsCapabilityState = {
  unsupportedUntil: 0,
  reason: "",
};

function uniqueIds(primary: string[], secondary: string[], maxSize = 50) {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const source of [primary, secondary]) {
    for (const id of source) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      deduped.push(id);
      if (deduped.length >= maxSize) return deduped;
    }
  }
  return deduped;
}

function hashText(value: string) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function normalizePlaylistId(value: unknown) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (PLAYLIST_ID_REGEX.test(raw)) return raw;
  if (raw.startsWith("spotify:playlist:")) {
    const id = raw.split(":").pop() ?? "";
    return PLAYLIST_ID_REGEX.test(id) ? id : null;
  }
  return null;
}

function normalizeArtistId(value: unknown) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^[A-Za-z0-9]{22}$/.test(raw)) return raw;
  if (raw.startsWith("spotify:artist:")) {
    const id = raw.split(":").pop() ?? "";
    return /^[A-Za-z0-9]{22}$/.test(id) ? id : null;
  }
  return null;
}

function parseLimit(value: string | null | undefined) {
  if (value == null) return 25;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RecommendationsServiceError({
      status: 400,
      code: "INVALID_LIMIT",
      message: "Ongeldige limit voor recommendations.",
    });
  }
  return Math.min(Math.floor(parsed), 100);
}

function parseSeedTracks(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return [] as string[];
  const ids = raw
    .split(",")
    .map((part) => normalizeTrackId(part))
    .filter((id): id is string => Boolean(id));
  return uniqueIds(ids, [], 5);
}

function summarizeUrl(value: string) {
  try {
    const parsed = new URL(value);
    const raw = `${parsed.pathname}${parsed.search}`;
    if (raw.length <= 512) return raw;
    return `${raw.slice(0, 512)}...[truncated]`;
  } catch {
    return value.slice(0, 512);
  }
}

async function spotifyFetchWithTrace<T>(args: {
  trace: RecommendationsTraceFn;
  correlationId: string;
  op: string;
  url: string;
  method?: string;
  body?: unknown;
  userLevel?: boolean;
  timeoutMs?: number;
  maxAttempts?: number;
}) {
  const started = Date.now();
  args.trace("spotify_request_start", {
    data: {
      op: args.op,
      method: args.method ?? "GET",
      url: summarizeUrl(args.url),
      timeoutMs: args.timeoutMs ?? null,
      maxAttempts: args.maxAttempts ?? null,
    },
  });
  try {
    const data = await spotifyFetch<T>({
      url: args.url,
      method: args.method,
      body: args.body,
      userLevel: args.userLevel,
      timeoutMs: args.timeoutMs,
      maxAttempts: args.maxAttempts,
      correlationId: args.correlationId,
      priority:
        args.op === "spotify_recommendations" ? "interactive" : args.op.includes("fallback")
          ? "background"
          : "interactive",
      requestClass: "read",
      cacheTtlMs: args.op === "spotify_recommendations" ? 3_000 : 800,
      staleWhileRevalidateMs: args.op === "spotify_recommendations" ? 10_000 : 2000,
    });
    args.trace("spotify_request_success", {
      status: 200,
      durationMs: Date.now() - started,
      data: {
        op: args.op,
        method: args.method ?? "GET",
        url: summarizeUrl(args.url),
      },
    });
    return data;
  } catch (error) {
    if (error instanceof SpotifyFetchError) {
      args.trace("spotify_request_error", {
        level: error.status >= 500 || error.status === 0 ? "error" : "warn",
        status: error.status,
        code: error.code,
        message: error.body.slice(0, 240),
        durationMs: Date.now() - started,
        data: {
          op: args.op,
          method: args.method ?? "GET",
          url: summarizeUrl(args.url),
          retryAfterMs: error.retryAfterMs,
          upstreamCorrelationId: error.correlationId,
        },
      });
      throw error;
    }
    args.trace("spotify_request_error", {
      level: "error",
      status: 500,
      code: "SPOTIFY_FETCH_UNKNOWN",
      message: String(error),
      durationMs: Date.now() - started,
      data: {
        op: args.op,
        method: args.method ?? "GET",
        url: summarizeUrl(args.url),
      },
    });
    throw error;
  }
}

function extractSpotifyErrorMessage(body: string) {
  const trimmed = String(body ?? "").trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as {
      error?:
        | string
        | {
            message?: string | null;
          };
      message?: string | null;
    };
    if (typeof parsed?.error === "string") return parsed.error;
    if (typeof parsed?.error?.message === "string") return parsed.error.message;
    if (typeof parsed?.message === "string") return parsed.message;
  } catch {
    // ignore json parse failures
  }
  return trimmed;
}

function normalizeSpotifyErrorText(body: string) {
  return extractSpotifyErrorMessage(body).toLowerCase();
}

function isRejectedSeedError(error: SpotifyFetchError) {
  if (error.status !== 400 && error.status !== 404) return false;
  const text = normalizeSpotifyErrorText(error.body);
  if (!text) return false;
  return (
    text.includes("seed") ||
    text.includes("invalid id") ||
    text.includes("invalid base62") ||
    text.includes("no recommendations available") ||
    text.includes("provided seeds")
  );
}

function isRecommendationsUnavailableError(error: SpotifyFetchError) {
  if (![403, 404, 410, 501].includes(error.status)) return false;
  const text = normalizeSpotifyErrorText(error.body);
  if (text.includes("seed")) return false;
  if (error.status === 410 || error.status === 501) return true;
  const unavailableSignal =
    text.includes("deprecated") ||
    text.includes("unsupported") ||
    text.includes("security requirement") ||
    text.includes("not available") ||
    text.includes("endpoint is disabled");
  if (error.status === 403) {
    return unavailableSignal || text.includes("recommendation");
  }
  if (error.status === 404) {
    return unavailableSignal && (text.includes("recommendation") || text.includes("endpoint"));
  }
  return false;
}

function isTransientUpstreamError(error: SpotifyFetchError) {
  return error.status === 0 || error.status >= 500;
}

function cleanupLastSuccessCache(now = Date.now()) {
  for (const [key, entry] of lastSuccessByPlaylist.entries()) {
    if (entry.expiresAt <= now) {
      lastSuccessByPlaylist.delete(key);
    }
  }
}

function lastSuccessKey(args: { userId: string; playlistId: string; limit: number }) {
  return `playlist-recommendations:last:v1:${args.userId}:${args.playlistId}:limit:${args.limit}|mode:${RECOMMENDATIONS_MODE}`;
}

function setLastSuccess(args: {
  userId: string;
  playlistId: string;
  limit: number;
  payload: CachedRecommendationsPayload;
}) {
  cleanupLastSuccessCache();
  const key = lastSuccessKey({
    userId: args.userId,
    playlistId: args.playlistId,
    limit: args.limit,
  });
  lastSuccessByPlaylist.set(key, {
    payload: args.payload,
    expiresAt: Date.now() + RECOMMENDATIONS_LAST_SUCCESS_TTL_MS,
  });
}

function getLastSuccess(args: { userId: string; playlistId: string; limit: number }) {
  cleanupLastSuccessCache();
  const key = lastSuccessKey(args);
  const entry = lastSuccessByPlaylist.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    lastSuccessByPlaylist.delete(key);
    return null;
  }
  return entry.payload;
}

function isSoftFallbackError(error: RecommendationsServiceError) {
  return (
    error.code === "SPOTIFY_UPSTREAM" ||
    error.code === "RECOMMENDATIONS_UNAVAILABLE"
  );
}

function createNoResultsPayload(args: {
  playlistId: string;
  snapshotId: string | null;
  cacheState: "miss" | "stale";
  reason?: "no_results" | "upstream_fallback";
  diagnostics?: RecommendationsSeedDiagnostics;
}): PlaylistRecommendationsPayload {
  return {
    items: [],
    totalCount: 0,
    asOf: Date.now(),
    reason: args.reason ?? "no_results",
    playlistId: args.playlistId,
    snapshotId: args.snapshotId,
    seedTrackCount: 0,
    seedArtistCount: 0,
    diagnostics: args.diagnostics,
    cacheState: args.cacheState,
  };
}

function markRecommendationsUnavailable(reason: string) {
  if (RECOMMENDATIONS_MODE !== "auto") return;
  recommendationsCapabilityState.unsupportedUntil =
    Date.now() + RECOMMENDATIONS_UNSUPPORTED_TTL_MS;
  recommendationsCapabilityState.reason = reason.slice(0, 160);
}

function createSeedAttemptKey(seedTracks: string[], seedArtists: string[]) {
  return `t:${[...seedTracks].sort().join(",")}|a:${[...seedArtists].sort().join(",")}`;
}

function addSeedAttempt(
  attempts: SeedAttempt[],
  seen: Set<string>,
  next: { seedTracks?: string[]; seedArtists?: string[] }
) {
  const tracks = uniqueIds(next.seedTracks ?? [], [], 5);
  const artists = uniqueIds(next.seedArtists ?? [], [], 5);
  const trackCount = tracks.length;
  const artistSlots = Math.max(0, 5 - trackCount);
  const selectedArtists = artists.slice(0, artistSlots);
  if (tracks.length === 0 && selectedArtists.length === 0) return;
  const key = createSeedAttemptKey(tracks, selectedArtists);
  if (seen.has(key)) return;
  seen.add(key);
  attempts.push({ seedTracks: tracks, seedArtists: selectedArtists, key });
}

function buildDeterministicSeedAttempts(args: {
  seedTrackPool: string[];
  maxAttempts: number;
}) {
  const attempts: SeedAttempt[] = [];
  const seen = new Set<string>();
  const tracks = uniqueIds(args.seedTrackPool, [], 30);
  const maxAttempts = Math.max(1, Math.floor(args.maxAttempts));
  const mid = Math.floor(tracks.length / 2);
  const tail = Math.max(0, tracks.length - 5);

  // Keep recommendation requests track-seed-only for maximum Spotify compatibility.
  addSeedAttempt(attempts, seen, { seedTracks: tracks.slice(0, 5) });
  if (attempts.length < maxAttempts) {
    addSeedAttempt(attempts, seen, { seedTracks: tracks.slice(mid, mid + 5) });
  }
  if (attempts.length < maxAttempts) {
    addSeedAttempt(attempts, seen, { seedTracks: tracks.slice(tail, tail + 5) });
  }
  if (attempts.length < maxAttempts) {
    addSeedAttempt(attempts, seen, { seedTracks: tracks.slice(0, 4) });
  }
  if (attempts.length < maxAttempts) {
    for (let start = 0; start < tracks.length && attempts.length < maxAttempts; start += 2) {
      addSeedAttempt(attempts, seen, {
        seedTracks: tracks.slice(start, start + 5),
      });
    }
  }

  return attempts.slice(0, maxAttempts);
}

function mapRecommendationTracks(
  data: RecommendationsResponse | undefined,
  blockedTrackIds: Set<string>
) {
  const seen = new Set<string>();
  const mapped: RecommendationItem[] = [];
  const blockedCandidates: Array<
    NonNullable<RecommendationsResponse["tracks"]>[number]
  > = [];
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  const appendTrack = (
    track: NonNullable<RecommendationsResponse["tracks"]>[number],
    allowBlocked: boolean
  ) => {
    const trackId = normalizeTrackId(track?.id ?? null);
    if (!trackId) return;
    const linkedTrackId = normalizeTrackId(track?.linked_from?.id ?? null);
    const canonicalTrackId = linkedTrackId ?? trackId;
    if (seen.has(canonicalTrackId)) return;
    const isBlocked =
      blockedTrackIds.has(canonicalTrackId) ||
      blockedTrackIds.has(trackId) ||
      (linkedTrackId ? blockedTrackIds.has(linkedTrackId) : false);
    if (isBlocked && !allowBlocked) {
      blockedCandidates.push(track);
      return;
    }
    if (track?.is_playable === false) return;
    if (typeof track?.restrictions?.reason === "string") return;
    seen.add(canonicalTrackId);

    const releaseDate = track?.album?.release_date ?? null;
    const releaseYear =
      releaseDate && /^\d{4}/.test(releaseDate) ? Number(releaseDate.slice(0, 4)) : null;
    const imageUrl =
      track?.album?.images?.find((image) => typeof image?.url === "string")?.url ?? null;
    const artistIds = Array.isArray(track?.artists)
      ? uniqueIds(
          track.artists
            .map((artist) => {
              const raw = typeof artist?.id === "string" ? artist.id.trim() : "";
              return /^[A-Za-z0-9]{22}$/.test(raw) ? raw : null;
            })
            .filter((id): id is string => Boolean(id)),
          []
        )
      : [];

    mapped.push({
      trackId,
      name: track?.name ?? "Onbekend nummer",
      albumId: track?.album?.id ?? null,
      albumName: track?.album?.name ?? null,
      albumReleaseDate: releaseDate,
      releaseYear,
      albumImageUrl: imageUrl,
      coverUrl: imageUrl,
      durationMs: typeof track?.duration_ms === "number" ? track.duration_ms : null,
      explicit: typeof track?.explicit === "boolean" ? (track.explicit ? 1 : 0) : null,
      isLocal: typeof track?.is_local === "boolean" ? (track.is_local ? 1 : 0) : null,
      linkedFromTrackId: normalizeTrackId(track?.linked_from?.id ?? null),
      restrictionsReason:
        typeof track?.restrictions?.reason === "string" ? track.restrictions.reason : null,
      popularity: typeof track?.popularity === "number" ? track.popularity : null,
      artists: Array.isArray(track?.artists)
        ? track.artists
            .map((artist) => artist?.name)
            .filter(Boolean)
            .join(", ")
        : null,
      artistIds,
      playlists: [],
    });
  };

  for (const track of tracks) {
    appendTrack(track, false);
  }

  // If filtering out seed overlaps removes everything, fall back to allowing those tracks.
  if (mapped.length === 0 && blockedCandidates.length > 0) {
    for (const track of blockedCandidates) {
      appendTrack(track, true);
    }
  }

  return mapped;
}

function toRetryAfterSec(retryAfterMs: number | null | undefined) {
  if (!retryAfterMs || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return null;
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

function toCanonicalTrackId(track: RecommendationItem) {
  return normalizeTrackId(track.linkedFromTrackId ?? null) ?? normalizeTrackId(track.trackId) ?? null;
}

type RecommendationsContext = {
  playlistId: string;
  limit: number;
  snapshotId: string | null;
  snapshotToken: string;
  seedTrackPool: string[];
  seedArtistPool: string[];
  blockedTrackIds: Set<string>;
  seedSource: "db" | "live";
  candidateTrackCount: number;
  validatedTrackCount: number;
  preferredSeedTrackCount: number;
};

async function loadArtistSeedsFromTrackPool(args: {
  seedTrackPool: string[];
  correlationId: string;
  trace: RecommendationsTraceFn;
}) {
  const seedTracks = uniqueIds(args.seedTrackPool, [], 50);
  if (!seedTracks.length) return [] as string[];
  const db = getDb();
  try {
    const rows = await db
      .select({
        artistId: trackArtists.artistId,
      })
      .from(trackArtists)
      .where(inArray(trackArtists.trackId, seedTracks));
    const artistIds = uniqueIds(
      rows
        .map((row) => normalizeArtistId(row.artistId))
        .filter((value): value is string => Boolean(value)),
      []
    );
    if (artistIds.length) return artistIds.slice(0, 25);
  } catch {
    // fall through to live fallback
  }

  const fallbackArtists: string[] = [];
  for (const trackId of seedTracks.slice(0, 5)) {
    try {
      const data = await spotifyFetchWithTrace<{
        artists?: Array<{ id?: string | null }>;
      }>({
        trace: args.trace,
        correlationId: args.correlationId,
        op: "track_artist_lookup",
        url: `https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}?market=from_token`,
        userLevel: true,
        timeoutMs: RECOMMENDATIONS_UPSTREAM_TIMEOUT_MS,
        maxAttempts: 1,
      });
      for (const artist of Array.isArray(data?.artists) ? data.artists : []) {
        const artistId = normalizeArtistId(artist?.id ?? null);
        if (!artistId) continue;
        fallbackArtists.push(artistId);
      }
    } catch {
      // ignore fallback errors
    }
  }
  return uniqueIds(fallbackArtists, [], 25);
}

function chunkIds(ids: string[], size: number) {
  const chunks: string[][] = [];
  const safeSize = Math.max(1, Math.floor(size));
  for (let index = 0; index < ids.length; index += safeSize) {
    chunks.push(ids.slice(index, index + safeSize));
  }
  return chunks;
}

function toValidatedTrackCandidate(track: TracksLookupItem | null | undefined) {
  const trackId = normalizeTrackId(track?.id ?? null);
  if (!trackId) return null;
  if (typeof track?.type === "string" && track.type.trim() && track.type !== "track") {
    return null;
  }
  if (track?.is_playable === false) return null;
  if (typeof track?.restrictions?.reason === "string" && track.restrictions.reason.trim()) {
    return null;
  }
  return {
    trackId,
    artistIds: Array.isArray(track?.artists)
      ? track.artists
          .map((artist) => normalizeArtistId(artist?.id ?? null))
          .filter((value): value is string => Boolean(value))
      : [],
  };
}

async function loadValidatedSeedBundle(args: {
  seedTrackPool: string[];
  correlationId: string;
  trace: RecommendationsTraceFn;
}): Promise<ValidatedSeedBundle> {
  const trackIds = uniqueIds(args.seedTrackPool, [], 50);
  if (!trackIds.length) {
    return {
      trackIds: [],
      artistIds: [],
      hadValidationFailure: false,
    };
  }

  const validatedTrackIds: string[] = [];
  const validatedTrackSet = new Set<string>();
  const validatedArtistIds: string[] = [];
  const validatedArtistSet = new Set<string>();
  let hadValidationFailure = false;

  const appendValidated = (
    track: TracksLookupItem | null | undefined
  ) => {
    const candidate = toValidatedTrackCandidate(track);
    if (!candidate) return;
    if (!validatedTrackSet.has(candidate.trackId)) {
      validatedTrackSet.add(candidate.trackId);
      validatedTrackIds.push(candidate.trackId);
    }
    for (const artistId of candidate.artistIds) {
      if (validatedArtistSet.has(artistId)) continue;
      validatedArtistSet.add(artistId);
      validatedArtistIds.push(artistId);
    }
  };

  for (const chunk of chunkIds(trackIds, 50)) {
    if (validatedTrackIds.length >= 25) break;
    try {
      const data = await spotifyFetchWithTrace<TracksLookupResponse>({
        trace: args.trace,
        correlationId: args.correlationId,
        op: "seed_validation_batch",
        url: `https://api.spotify.com/v1/tracks?ids=${encodeURIComponent(
          chunk.join(",")
        )}&market=from_token`,
        userLevel: true,
        timeoutMs: RECOMMENDATIONS_UPSTREAM_TIMEOUT_MS,
        maxAttempts: RECOMMENDATIONS_UPSTREAM_MAX_ATTEMPTS,
      });
      for (const track of Array.isArray(data?.tracks) ? data.tracks : []) {
        appendValidated(track);
        if (validatedTrackIds.length >= 25) break;
      }
      continue;
    } catch (error) {
      if (error instanceof SpotifyFetchError) {
        if (error.status === 401) {
          throw new RecommendationsServiceError({
            status: 401,
            code: "UNAUTHENTICATED",
            message: "Je bent nog niet verbonden met Spotify.",
            correlationId: error.correlationId,
          });
        }
        if (error.status === 429) {
          throw new RecommendationsServiceError({
            status: 429,
            code: "RATE_LIMIT",
            message: "Spotify is tijdelijk druk met requests.",
            retryAfterSec: toRetryAfterSec(error.retryAfterMs),
            correlationId: error.correlationId,
          });
        }

        hadValidationFailure = true;

        if (error.status !== 400 && error.status !== 404) {
          continue;
        }
      } else {
        hadValidationFailure = true;
        continue;
      }
    }

    // Fallback to per-track validation when batched lookup rejects the input set.
    for (const trackId of chunk.slice(0, 25)) {
      try {
        const data = await spotifyFetchWithTrace<{
          id?: string | null;
          type?: string | null;
          is_playable?: boolean;
          restrictions?: { reason?: string | null } | null;
          artists?: Array<{ id?: string | null }>;
        }>({
          trace: args.trace,
          correlationId: args.correlationId,
          op: "seed_validation_single",
          url: `https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}?market=from_token`,
          userLevel: true,
          timeoutMs: RECOMMENDATIONS_UPSTREAM_TIMEOUT_MS,
          maxAttempts: 1,
        });
        appendValidated(data);
        if (validatedTrackIds.length >= 25) break;
      } catch (error) {
        if (error instanceof SpotifyFetchError) {
          if (error.status === 401) {
            throw new RecommendationsServiceError({
              status: 401,
              code: "UNAUTHENTICATED",
              message: "Je bent nog niet verbonden met Spotify.",
              correlationId: error.correlationId,
            });
          }
          if (error.status === 429) {
            throw new RecommendationsServiceError({
              status: 429,
              code: "RATE_LIMIT",
              message: "Spotify is tijdelijk druk met requests.",
              retryAfterSec: toRetryAfterSec(error.retryAfterMs),
              correlationId: error.correlationId,
            });
          }
        }
        hadValidationFailure = true;
      }
    }
  }

  return {
    trackIds: validatedTrackIds.slice(0, 25),
    artistIds: validatedArtistIds.slice(0, 25),
    hadValidationFailure,
  };
}

async function getCachedValidatedSeedBundle(args: {
  userId: string;
  playlistId: string;
  snapshotToken: string;
  seedTrackPool: string[];
  correlationId: string;
  trace: RecommendationsTraceFn;
  forceRefresh?: boolean;
}) {
  const key = `playlist-recommendations:seed-validation:v1:${args.userId}:${args.playlistId}:${args.snapshotToken}`;
  const cached = await getCachedValue<ValidatedSeedBundle>({
    key,
    ttlMs: RECOMMENDATIONS_SEED_VALIDATION_TTL_MS,
    staleMs: RECOMMENDATIONS_SEED_VALIDATION_STALE_MS,
    forceRefresh: Boolean(args.forceRefresh),
    loader: async () => {
      return await loadValidatedSeedBundle({
        seedTrackPool: args.seedTrackPool,
        correlationId: args.correlationId,
        trace: args.trace,
      });
    },
  });
  return cached.value;
}

async function prepareRecommendationsContext(args: {
  userId: string;
  playlistId: string;
  limit: number;
  correlationId: string;
  trace: RecommendationsTraceFn;
  forceRefresh?: boolean;
  preferredSeedTracks?: string[];
}) {
  const seedSource = await getPlaylistSeedSource({
    userId: args.userId,
    playlistId: args.playlistId,
    correlationId: args.correlationId,
    trace: args.trace,
  });
  const seedSelection = selectDeterministicPlaylistSeedPool({
    playlistId: args.playlistId,
    snapshotId: seedSource.snapshotId,
    candidates: seedSource.candidates,
    maxSeedPoolSize: 25,
  });
  if (seedSelection.seedTrackPool.length === 0) {
    args.trace("seed_selection_empty", {
      level: "warn",
      status: 422,
      code: "INSUFFICIENT_PLAYLIST_SEEDS",
      message: "Geen seed tracks na selectie.",
      data: {
        candidateTrackCount: seedSelection.eligibleCount,
      },
    });
    throw new RecommendationsServiceError({
      status: 422,
      code: "INSUFFICIENT_PLAYLIST_SEEDS",
      message: "Deze playlist heeft te weinig afspeelbare tracks voor recommendations.",
    });
  }

  let validatedSeeds: ValidatedSeedBundle | null = null;
  if (RECOMMENDATIONS_ENABLE_PREVALIDATION) {
    try {
      validatedSeeds = await getCachedValidatedSeedBundle({
        userId: args.userId,
        playlistId: args.playlistId,
        snapshotToken: seedSelection.snapshotToken,
        seedTrackPool: seedSelection.seedTrackPool,
        correlationId: args.correlationId,
        trace: args.trace,
        forceRefresh: args.forceRefresh,
      });
    } catch (error) {
      if (error instanceof RecommendationsServiceError) {
        throw error;
      }
      // Keep raw playlist-derived seeds when validation itself is transiently unavailable.
      validatedSeeds = null;
    }
  } else {
    args.trace("seed_prevalidation_skipped", {
      data: { enabled: false },
    });
  }

  const validatedTrackPool = uniqueIds(validatedSeeds?.trackIds ?? [], [], 25);
  const baseSeedTrackPool = validatedTrackPool.length
    ? validatedTrackPool
    : seedSelection.seedTrackPool;
  if (!baseSeedTrackPool.length) {
    throw new RecommendationsServiceError({
      status: 422,
      code: "INSUFFICIENT_PLAYLIST_SEEDS",
      message: "Deze playlist heeft te weinig geldige seeds voor recommendations.",
    });
  }

  const preferredFromRequest = uniqueIds(
    (args.preferredSeedTracks ?? []).map((trackId) => normalizeTrackId(trackId) ?? ""),
    [],
    5
  );
  const basePoolSet = new Set(baseSeedTrackPool);
  const preferredSeedTracks = preferredFromRequest.filter((trackId) => basePoolSet.has(trackId));
  const effectiveSeedTrackPool = uniqueIds(preferredSeedTracks, baseSeedTrackPool, 25);

  let seedArtistPool = uniqueIds(validatedSeeds?.artistIds ?? [], [], 25);
  if (seedArtistPool.length === 0) {
    seedArtistPool = await loadArtistSeedsFromTrackPool({
      seedTrackPool: effectiveSeedTrackPool,
      correlationId: args.correlationId,
      trace: args.trace,
    });
  }

  const blockedTrackIds = new Set<string>(effectiveSeedTrackPool);
  const snapshotSeedHash = hashText(effectiveSeedTrackPool.join(","));

  const context: RecommendationsContext = {
    playlistId: args.playlistId,
    limit: args.limit,
    snapshotId: seedSource.snapshotId,
    snapshotToken: `${seedSelection.snapshotToken}:seed:${snapshotSeedHash}`,
    seedTrackPool: effectiveSeedTrackPool,
    seedArtistPool,
    blockedTrackIds,
    seedSource: seedSource.source === "live" ? "live" : "db",
    candidateTrackCount: seedSelection.eligibleCount,
    validatedTrackCount: validatedTrackPool.length,
    preferredSeedTrackCount: preferredSeedTracks.length,
  };
  args.trace("context_prepared", {
    data: {
      seedSource: context.seedSource,
      candidateTrackCount: context.candidateTrackCount,
      validatedTrackCount: context.validatedTrackCount,
      seedTrackPoolCount: context.seedTrackPool.length,
      preferredSeedTrackCount: context.preferredSeedTrackCount,
      seedArtistPoolCount: context.seedArtistPool.length,
      snapshotId: context.snapshotId,
    },
  });
  return context;
}

async function loadArtistTopTracksFallback(
  context: RecommendationsContext,
  args: { correlationId: string; trace: RecommendationsTraceFn }
) {
  const artistIds = uniqueIds(
    context.seedArtistPool,
    [],
    RECOMMENDATIONS_FALLBACK_ARTIST_LIMIT
  );
  if (!artistIds.length) return [] as RecommendationItem[];
  const collected: RecommendationItem[] = [];
  const collectedIds = new Set<string>();

  for (const artistId of artistIds) {
    let data: { tracks?: RecommendationsResponse["tracks"] } | undefined;
    try {
      data = await spotifyFetchWithTrace<{ tracks?: RecommendationsResponse["tracks"] }>({
        trace: args.trace,
        correlationId: args.correlationId,
        op: "artist_top_tracks_fallback",
        url: `https://api.spotify.com/v1/artists/${encodeURIComponent(
          artistId
        )}/top-tracks?market=from_token`,
        userLevel: true,
        timeoutMs: RECOMMENDATIONS_UPSTREAM_TIMEOUT_MS,
        maxAttempts: RECOMMENDATIONS_UPSTREAM_MAX_ATTEMPTS,
      });
    } catch (error) {
      if (error instanceof SpotifyFetchError) {
        if (error.status === 401) {
          throw new RecommendationsServiceError({
            status: 401,
            code: "UNAUTHENTICATED",
            message: "Je bent nog niet verbonden met Spotify.",
            correlationId: error.correlationId,
          });
        }
        if (error.status === 429) {
          throw new RecommendationsServiceError({
            status: 429,
            code: "RATE_LIMIT",
            message: "Spotify is tijdelijk druk met requests.",
            retryAfterSec: toRetryAfterSec(error.retryAfterMs),
            correlationId: error.correlationId,
          });
        }
      }
      continue;
    }

    const mapped = mapRecommendationTracks(
      { tracks: Array.isArray(data?.tracks) ? data?.tracks : [] },
      context.blockedTrackIds
    );
    for (const item of mapped) {
      const canonicalId = toCanonicalTrackId(item) ?? item.trackId;
      if (!canonicalId || collectedIds.has(canonicalId)) continue;
      collectedIds.add(canonicalId);
      collected.push(item);
      if (collected.length >= context.limit) break;
    }
    if (collected.length >= context.limit) break;
  }

  return collected;
}

function buildSeedDiagnostics(args: {
  context: RecommendationsContext;
  attemptsPlanned: number;
  attemptsUsed: number;
  fallbackUsed: "none" | "artist_top_tracks";
}): RecommendationsSeedDiagnostics {
  return {
    seedSource: args.context.seedSource,
    candidateTrackCount: args.context.candidateTrackCount,
    validatedTrackCount: args.context.validatedTrackCount,
    seedTrackPoolCount: args.context.seedTrackPool.length,
    preferredSeedTrackCount: args.context.preferredSeedTrackCount,
    seedArtistPoolCount: args.context.seedArtistPool.length,
    attemptsPlanned: Math.max(0, Math.floor(args.attemptsPlanned)),
    attemptsUsed: Math.max(0, Math.floor(args.attemptsUsed)),
    fallbackUsed: args.fallbackUsed,
  };
}

async function loadRecommendationsFromSpotify(
  context: RecommendationsContext,
  args: { correlationId: string; trace: RecommendationsTraceFn }
) {
  if (RECOMMENDATIONS_MODE === "off") {
    throw new RecommendationsServiceError({
      status: 503,
      code: "RECOMMENDATIONS_UNAVAILABLE",
      message: "Spotify Recommendations API is momenteel niet beschikbaar voor deze app.",
    });
  }

  if (
    RECOMMENDATIONS_MODE === "auto" &&
    recommendationsCapabilityState.unsupportedUntil > Date.now()
  ) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((recommendationsCapabilityState.unsupportedUntil - Date.now()) / 1000)
    );
    throw new RecommendationsServiceError({
      status: 503,
      code: "RECOMMENDATIONS_UNAVAILABLE",
      message: "Spotify Recommendations API is momenteel niet beschikbaar voor deze app.",
      retryAfterSec,
    });
  }

  const primarySeedTracks = context.seedTrackPool.slice(0, 5);
  const seedAttempts = buildDeterministicSeedAttempts({
    seedTrackPool: context.seedTrackPool,
    maxAttempts: RECOMMENDATIONS_MAX_ATTEMPTS,
  });
  const attemptsPlanned = seedAttempts.length;
  if (seedAttempts.length === 0) {
    throw new RecommendationsServiceError({
      status: 422,
      code: "INSUFFICIENT_PLAYLIST_SEEDS",
      message: "Deze playlist heeft te weinig geldige seeds voor recommendations.",
    });
  }

  const collected: RecommendationItem[] = [];
  const collectedIds = new Set<string>();
  let hadRejectedSeedAttempt = false;
  let unavailableReason: string | null = null;
  let lastUpstreamError: SpotifyFetchError | null = null;
  let attemptsUsed = 0;

  for (const seedAttempt of seedAttempts) {
    attemptsUsed += 1;
    args.trace("recommendations_attempt_start", {
      data: {
        attempt: attemptsUsed,
        attemptsPlanned,
        seedTracks: seedAttempt.seedTracks,
        seedArtists: seedAttempt.seedArtists,
      },
    });
    try {
      const params = new URLSearchParams();
      if (seedAttempt.seedTracks.length > 0) {
        params.set("seed_tracks", seedAttempt.seedTracks.join(","));
      }
      params.set("limit", String(context.limit));
      params.set("market", "from_token");

      const data = await spotifyFetchWithTrace<RecommendationsResponse>({
        trace: args.trace,
        correlationId: args.correlationId,
        op: "spotify_recommendations",
        url: `https://api.spotify.com/v1/recommendations?${params.toString()}`,
        userLevel: true,
        timeoutMs: RECOMMENDATIONS_UPSTREAM_TIMEOUT_MS,
        maxAttempts: RECOMMENDATIONS_REQUEST_MAX_ATTEMPTS,
      });
      const items = mapRecommendationTracks(data, context.blockedTrackIds);
      for (const item of items) {
        const canonicalId =
          normalizeTrackId(item.linkedFromTrackId ?? null) ??
          normalizeTrackId(item.trackId) ??
          item.trackId;
        if (!canonicalId || collectedIds.has(canonicalId)) continue;
        collectedIds.add(canonicalId);
        collected.push(item);
        if (collected.length >= context.limit) break;
      }
      args.trace("recommendations_attempt_success", {
        data: {
          attempt: attemptsUsed,
          itemCount: items.length,
          collectedCount: collected.length,
        },
      });
      if (collected.length >= context.limit) break;
    } catch (error) {
      if (error instanceof SpotifyFetchError) {
        if (error.status === 401) {
          throw new RecommendationsServiceError({
            status: 401,
            code: "UNAUTHENTICATED",
            message: "Je bent nog niet verbonden met Spotify.",
            correlationId: error.correlationId,
          });
        }
        if (error.status === 429) {
          throw new RecommendationsServiceError({
            status: 429,
            code: "RATE_LIMIT",
            message: "Spotify is tijdelijk druk met requests.",
            retryAfterSec: toRetryAfterSec(error.retryAfterMs),
            correlationId: error.correlationId,
          });
        }
        if (isRejectedSeedError(error)) {
          hadRejectedSeedAttempt = true;
          args.trace("recommendations_attempt_seed_rejected", {
            level: "warn",
            status: error.status,
            code: error.code,
            message: extractSpotifyErrorMessage(error.body).slice(0, 240),
            data: {
              attempt: attemptsUsed,
              seedTracks: seedAttempt.seedTracks,
            },
          });
          continue;
        }
        if (isRecommendationsUnavailableError(error)) {
          const reason = extractSpotifyErrorMessage(error.body) || "upstream_unavailable";
          markRecommendationsUnavailable(reason);
          unavailableReason = reason;
          break;
        }
        if (error.status === 403) {
          throw new RecommendationsServiceError({
            status: 403,
            code: "FORBIDDEN",
            message: "Geen toegang tot Spotify recommendations voor deze playlist.",
            correlationId: error.correlationId,
          });
        }
        if (isTransientUpstreamError(error)) {
          lastUpstreamError = error;
          args.trace("recommendations_attempt_transient_error", {
            level: "warn",
            status: error.status,
            code: error.code,
            message: extractSpotifyErrorMessage(error.body).slice(0, 240),
            data: { attempt: attemptsUsed },
          });
          continue;
        }
        lastUpstreamError = error;
        break;
      }
      throw error;
    }
  }

  if (collected.length > 0) {
    const payload: CachedRecommendationsPayload = {
      items: collected.slice(0, context.limit),
      totalCount: collected.length,
      asOf: Date.now(),
      playlistId: context.playlistId,
      snapshotId: context.snapshotId,
      seedTrackCount: primarySeedTracks.length,
      seedArtistCount: context.seedArtistPool.length,
      diagnostics: buildSeedDiagnostics({
        context,
        attemptsPlanned,
        attemptsUsed,
        fallbackUsed: "none",
      }),
    };
    return payload;
  }

  if (RECOMMENDATIONS_ENABLE_ARTIST_FALLBACK) {
    const artistFallbackItems = await loadArtistTopTracksFallback(context, args);
    if (artistFallbackItems.length > 0) {
      return {
        items: artistFallbackItems.slice(0, context.limit),
        totalCount: artistFallbackItems.length,
        asOf: Date.now(),
        playlistId: context.playlistId,
        snapshotId: context.snapshotId,
        seedTrackCount: primarySeedTracks.length,
        seedArtistCount: context.seedArtistPool.length,
        diagnostics: buildSeedDiagnostics({
          context,
          attemptsPlanned,
          attemptsUsed,
          fallbackUsed: "artist_top_tracks",
        }),
      } satisfies CachedRecommendationsPayload;
    }
  } else {
    args.trace("artist_fallback_skipped", {
      data: { enabled: false },
    });
  }

  if (unavailableReason) {
    const retryAfterSec =
      RECOMMENDATIONS_MODE === "auto"
        ? Math.max(1, Math.ceil(RECOMMENDATIONS_UNSUPPORTED_TTL_MS / 1000))
        : null;
    throw new RecommendationsServiceError({
      status: 503,
      code: "RECOMMENDATIONS_UNAVAILABLE",
      message: "Spotify Recommendations API is momenteel niet beschikbaar voor deze app.",
      retryAfterSec,
    });
  }

  if (lastUpstreamError) {
    throw new RecommendationsServiceError({
      status: 502,
      code: "SPOTIFY_UPSTREAM",
      message: "Spotify is tijdelijk niet bereikbaar.",
      correlationId: lastUpstreamError.correlationId,
    });
  }

  const payload: CachedRecommendationsPayload = {
    items: [],
    totalCount: 0,
    asOf: Date.now(),
    reason: hadRejectedSeedAttempt ? "seed_rejected" : "no_results",
    playlistId: context.playlistId,
    snapshotId: context.snapshotId,
    seedTrackCount: primarySeedTracks.length,
    seedArtistCount: context.seedArtistPool.length,
    diagnostics: buildSeedDiagnostics({
      context,
      attemptsPlanned,
      attemptsUsed,
      fallbackUsed: "none",
    }),
  };
  return payload;
}

export async function getPlaylistRecommendations(args: {
  userId: string;
  playlistId: string;
  limit: number;
  forceRefresh?: boolean;
  preferredSeedTracks?: string[];
  correlationId?: string;
}) {
  const correlationId = String(args.correlationId ?? "").trim() || crypto.randomUUID();
  const playlistId = normalizePlaylistId(args.playlistId);
  const trace = createRecommendationsTraceLogger({
    correlationId,
    route: "recommendationService",
    method: "GET",
    playlistId: args.playlistId,
  });
  trace("service_request_start", {
    data: {
      playlistId: args.playlistId,
      limit: args.limit,
      forceRefresh: Boolean(args.forceRefresh),
      preferredSeedTracks: uniqueIds(args.preferredSeedTracks ?? [], [], 5),
    },
  });
  if (!playlistId) {
    trace("service_request_failed", {
      level: "warn",
      status: 400,
      code: "INVALID_PLAYLIST_ID",
      message: "Ongeldige playlist id.",
    });
    throw new RecommendationsServiceError({
      status: 400,
      code: "INVALID_PLAYLIST_ID",
      message: "Ongeldige playlist id.",
      correlationId,
    });
  }
  const limit = parseLimit(String(args.limit));
  let context: RecommendationsContext;
  try {
    context = await prepareRecommendationsContext({
      userId: args.userId,
      playlistId,
      limit,
      correlationId,
      trace,
      forceRefresh: Boolean(args.forceRefresh),
      preferredSeedTracks: args.preferredSeedTracks ?? [],
    });
  } catch (error) {
    if (error instanceof RecommendationsServiceError && isSoftFallbackError(error)) {
      const fallback = getLastSuccess({
        userId: args.userId,
        playlistId,
        limit,
      });
      if (fallback) {
        trace("service_context_soft_fallback_stale", {
          level: "warn",
          status: 200,
          code: error.code,
          message: error.message,
          data: { cacheState: "stale" },
        });
        return {
          ...fallback,
          asOf: Date.now(),
          cacheState: "stale",
        };
      }
      trace("service_context_soft_fallback_empty", {
        level: "warn",
        status: 200,
        code: error.code,
        message: error.message,
        data: { cacheState: "miss", reason: "upstream_fallback" },
      });
      return createNoResultsPayload({
        playlistId,
        snapshotId: null,
        cacheState: "miss",
        reason: "upstream_fallback",
      });
    }
    throw error;
  }
  const cacheKey = `playlist-recommendations:v2:${args.userId}:${playlistId}:${context.snapshotToken}|limit:${limit}|mode:${RECOMMENDATIONS_MODE}`;
  let cached: { value: CachedRecommendationsPayload; cacheState: "hit" | "miss" | "coalesced" | "stale" };
  try {
    cached = await getCachedValue<CachedRecommendationsPayload>({
      key: cacheKey,
      ttlMs: RECOMMENDATIONS_CACHE_TTL_MS,
      staleMs: RECOMMENDATIONS_CACHE_STALE_MS,
      forceRefresh: Boolean(args.forceRefresh),
      loader: async () => {
        return await loadRecommendationsFromSpotify(context, { correlationId, trace });
      },
    });
  } catch (error) {
    if (error instanceof RecommendationsServiceError && isSoftFallbackError(error)) {
      const fallback = getLastSuccess({
        userId: args.userId,
        playlistId,
        limit,
      });
      if (fallback) {
        trace("service_loader_soft_fallback_stale", {
          level: "warn",
          status: 200,
          code: error.code,
          message: error.message,
          data: { cacheState: "stale" },
        });
        return {
          ...fallback,
          asOf: Date.now(),
          cacheState: "stale",
        };
      }
      trace("service_loader_soft_fallback_empty", {
        level: "warn",
        status: 200,
        code: error.code,
        message: error.message,
        data: { cacheState: "miss", reason: "upstream_fallback" },
      });
      return createNoResultsPayload({
        playlistId,
        snapshotId: context.snapshotId,
        cacheState: "miss",
        reason: "upstream_fallback",
        diagnostics: buildSeedDiagnostics({
          context,
          attemptsPlanned: 0,
          attemptsUsed: 0,
          fallbackUsed: "none",
        }),
      });
    }
    throw error;
  }

  const payload: PlaylistRecommendationsPayload = {
    ...cached.value,
    cacheState: cached.cacheState,
  };
  trace("service_request_success", {
    status: 200,
    data: {
      cacheState: payload.cacheState,
      totalCount: payload.totalCount,
      reason: payload.reason ?? null,
      seedTrackCount: payload.seedTrackCount,
      seedArtistCount: payload.seedArtistCount,
    },
  });
  if (payload.items.length > 0) {
    setLastSuccess({
      userId: args.userId,
      playlistId,
      limit,
      payload: cached.value,
    });
  }
  return payload;
}

export function parseRecommendationsLimit(value: string | null | undefined) {
  return parseLimit(value);
}

export function parseRecommendationsSeedTracks(value: string | null | undefined) {
  return parseSeedTracks(value);
}

export function normalizeRecommendationsPlaylistId(value: unknown) {
  return normalizePlaylistId(value);
}
