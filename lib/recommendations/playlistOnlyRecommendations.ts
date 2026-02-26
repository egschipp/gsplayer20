import crypto from "crypto";
import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { logEvent } from "@/lib/observability/logger";
import { normalizeTrackId } from "@/lib/recommendations/seedSelector";
import { RecommendationItem, RecommendationsServiceError } from "@/lib/recommendations/types";

type RecommendationStatus =
  | "success"
  | "empty"
  | "rate_limited"
  | "auth_required"
  | "error";

type RecommendationMode = "initial" | "refresh";

type SeedTrackMeta = {
  id: string;
  artistIds: string[];
  popularity: number | null;
};

type SeedPoolEntry = {
  tracks: SeedTrackMeta[];
  snapshotId: string | null;
  generatedAt: number;
  dropStats: Record<string, number>;
};

type RecoTrack = {
  id?: string | null;
  type?: string | null;
  name?: string | null;
  duration_ms?: number;
  explicit?: boolean;
  is_local?: boolean;
  is_playable?: boolean;
  linked_from?: { id?: string | null };
  restrictions?: { reason?: string | null };
  popularity?: number;
  available_markets?: string[];
  album?: {
    id?: string | null;
    name?: string | null;
    release_date?: string | null;
    images?: Array<{ url?: string | null }>;
  };
  artists?: Array<{ id?: string | null; name?: string | null }>;
};

type RecoResponse = {
  tracks?: RecoTrack[];
};

type PlaylistMetaResponse = {
  snapshot_id?: string | null;
  tracks?: { total?: number | null };
};

type PlaylistTracksResponse = {
  items?: Array<{
    track?: {
      type?: string | null;
      id?: string | null;
      is_local?: boolean | null;
      is_playable?: boolean | null;
      available_markets?: string[] | null;
      popularity?: number | null;
      artists?: Array<{ id?: string | null }>;
    } | null;
  } | null>;
  next?: string | null;
  total?: number;
};

type TracksLookupResponse = {
  tracks?: Array<{
    id?: string | null;
    type?: string | null;
    is_local?: boolean | null;
    is_playable?: boolean | null;
    available_markets?: string[] | null;
  } | null>;
};

type UserProfileResponse = {
  country?: string | null;
};

const SEED_POOL_TTL_MS = 20 * 60 * 1000;
const RECO_CACHE_TTL_MS = 90 * 1000;
const SHOWN_TTL_MS = 3 * 60 * 60 * 1000;
const USER_MARKET_TTL_MS = 60 * 60 * 1000;
const SEED_VALIDATION_TTL_MS = 20 * 60 * 1000;
const MAX_PLAYLIST_ITEMS_SCAN = 1000;
const MIN_DISPLAY_TARGET = 15;
const MIN_DISPLAY_ABSOLUTE = 5;

const seedPoolCache = new Map<string, SeedPoolEntry>();
const recommendationsCache = new Map<string, { value: RecoTrack[]; expiresAt: number }>();
const shownTracksBySession = new Map<string, { ids: Set<string>; expiresAt: number }>();
const userMarketCache = new Map<string, { market: string; expiresAt: number }>();
const seedValidationCache = new Map<string, { valid: boolean; expiresAt: number }>();
const inflightReco = new Map<string, Promise<PlaylistOnlyRecommendationsResponse>>();
const lastSeedSetByPlaylist = new Map<string, { ids: string[]; expiresAt: number }>();

function hashText(value: string) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function nowMs() {
  return Date.now();
}

function cleanupCaches(now = nowMs()) {
  for (const [key, value] of seedPoolCache.entries()) {
    if (value.generatedAt + SEED_POOL_TTL_MS <= now) seedPoolCache.delete(key);
  }
  for (const [key, value] of recommendationsCache.entries()) {
    if (value.expiresAt <= now) recommendationsCache.delete(key);
  }
  for (const [key, value] of shownTracksBySession.entries()) {
    if (value.expiresAt <= now) shownTracksBySession.delete(key);
  }
  for (const [key, value] of userMarketCache.entries()) {
    if (value.expiresAt <= now) userMarketCache.delete(key);
  }
  for (const [key, value] of seedValidationCache.entries()) {
    if (value.expiresAt <= now) seedValidationCache.delete(key);
  }
  for (const [key, value] of lastSeedSetByPlaylist.entries()) {
    if (value.expiresAt <= now) lastSeedSetByPlaylist.delete(key);
  }
}

function takeRandom<T>(list: T[], count: number) {
  const bag = [...list];
  for (let i = bag.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = bag[i];
    bag[i] = bag[j];
    bag[j] = tmp;
  }
  return bag.slice(0, count);
}

function overlapCount(a: string[], b: string[]) {
  const set = new Set(a);
  let count = 0;
  for (const id of b) {
    if (set.has(id)) count += 1;
  }
  return count;
}

function getSpotifyErrorExcerpt(body: unknown) {
  const raw = String(body ?? "").trim();
  if (!raw) return null;
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  if (lines.length === 0) return null;
  return lines.join(" | ").slice(0, 300);
}

function toOutboundPath(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

function buildArtistQuotaOk(tracks: SeedTrackMeta[], seedIds: string[]) {
  const seedSet = new Set(seedIds);
  const artistCount = new Map<string, number>();
  for (const track of tracks) {
    if (!seedSet.has(track.id)) continue;
    for (const artistId of track.artistIds) {
      artistCount.set(artistId, (artistCount.get(artistId) || 0) + 1);
      if ((artistCount.get(artistId) || 0) > 2) return false;
    }
  }
  return true;
}

function selectSeedSet(args: {
  playlistKey: string;
  pool: SeedTrackMeta[];
  preferredSeedTracks?: string[];
}) {
  const seedCount = Math.min(5, args.pool.length);
  if (seedCount <= 0) return [] as string[];
  const previous = lastSeedSetByPlaylist.get(args.playlistKey)?.ids ?? [];
  const poolIds = args.pool.map((track) => track.id);

  const preferred = Array.from(
    new Set(
      (args.preferredSeedTracks ?? [])
        .map((id) => normalizeTrackId(id))
        .filter((id): id is string => Boolean(id))
        .filter((id) => poolIds.includes(id))
    )
  );

  let chosen: string[] | null = null;
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const base = takeRandom(
      poolIds.filter((id) => !preferred.includes(id)),
      Math.max(0, seedCount - preferred.length)
    );
    const candidate = Array.from(new Set([...preferred.slice(0, seedCount), ...base])).slice(
      0,
      seedCount
    );
    if (candidate.length < seedCount) {
      const fill = takeRandom(
        poolIds.filter((id) => !candidate.includes(id)),
        seedCount - candidate.length
      );
      candidate.push(...fill);
    }
    if (candidate.length !== seedCount) continue;
    if (previous.length && candidate.join(",") === previous.join(",")) continue;
    if (previous.length && args.pool.length > seedCount && overlapCount(previous, candidate) > 2) {
      continue;
    }
    if (!buildArtistQuotaOk(args.pool, candidate)) continue;
    const popTracks = args.pool.filter((track) => (track.popularity ?? 0) >= 45).map((track) => track.id);
    if (popTracks.length && !candidate.some((id) => popTracks.includes(id))) {
      continue;
    }
    chosen = candidate;
    break;
  }

  if (!chosen) {
    chosen = takeRandom(poolIds, seedCount);
  }
  lastSeedSetByPlaylist.set(args.playlistKey, {
    ids: chosen,
    expiresAt: nowMs() + SHOWN_TTL_MS,
  });
  return chosen;
}

async function validateSeedTrackBatch(args: {
  userId: string;
  playlistId: string;
  market: string;
  correlationId: string;
  seedTrackIds: string[];
}) {
  if (args.seedTrackIds.length === 0) {
    return { validTrackIds: [] as string[], invalidTrackIds: [] as string[] };
  }
  const ids = Array.from(new Set(args.seedTrackIds)).slice(0, 50);
  const qs = new URLSearchParams({
    ids: ids.join(","),
    market: args.market,
  });
  const lookupUrl = `https://api.spotify.com/v1/tracks?${qs.toString()}`;
  const response = await spotifyFetch<TracksLookupResponse>({
    url: lookupUrl,
    userLevel: true,
    correlationId: args.correlationId,
    priority: "interactive",
    requestClass: "read",
    maxAttempts: 1,
    cacheTtlMs: 5_000,
    staleWhileRevalidateMs: 10_000,
  });

  const byId = new Map<string, boolean>();
  for (const track of Array.isArray(response?.tracks) ? response.tracks : []) {
    const trackId = normalizeTrackId(track?.id ?? null);
    if (!trackId) continue;
    const ok =
      (track?.type == null || track.type === "track") &&
      track?.is_local !== true &&
      track?.is_playable !== false &&
      (!Array.isArray(track?.available_markets) ||
        track.available_markets.length === 0 ||
        track.available_markets.includes(args.market));
    byId.set(trackId, ok);
  }

  const validTrackIds = ids.filter((id) => byId.get(id) === true);
  const invalidTrackIds = ids.filter((id) => !validTrackIds.includes(id));
  logEvent({
    level: "info",
    event: "playlist_only_recommendations_seed_validation",
    correlationId: args.correlationId,
    appUserId: args.userId,
    data: {
      playlistId: args.playlistId,
      market: args.market,
      requestedSeedCount: ids.length,
      validSeedCount: validTrackIds.length,
      invalidSeedCount: invalidTrackIds.length,
    },
  });
  return { validTrackIds, invalidTrackIds };
}

async function selectValidatedSeedSet(args: {
  userId: string;
  playlistId: string;
  playlistKey: string;
  pool: SeedTrackMeta[];
  market: string;
  correlationId: string;
  preferredSeedTracks?: string[];
}) {
  const targetSeedCount = 5;
  if (targetSeedCount <= 0) {
    return {
      seedTrackIds: [] as string[],
      rejectedSeedIds: [] as string[],
      targetSeedCount,
    };
  }
  if (args.pool.length < targetSeedCount) {
    return {
      seedTrackIds: [] as string[],
      rejectedSeedIds: [] as string[],
      targetSeedCount,
    };
  }

  const cacheKeyFor = (trackId: string) => `${args.market}:${trackId}`;
  const now = nowMs();
  const unknownIds = args.pool
    .map((track) => track.id)
    .filter((id) => {
      const cached = seedValidationCache.get(cacheKeyFor(id));
      return !cached || cached.expiresAt <= now;
    })
    .slice(0, 100);

  if (unknownIds.length > 0) {
    const validation = await validateSeedTrackBatch({
      userId: args.userId,
      playlistId: args.playlistId,
      market: args.market,
      correlationId: args.correlationId,
      seedTrackIds: unknownIds,
    });
    for (const validId of validation.validTrackIds) {
      seedValidationCache.set(cacheKeyFor(validId), {
        valid: true,
        expiresAt: now + SEED_VALIDATION_TTL_MS,
      });
    }
    for (const invalidId of validation.invalidTrackIds) {
      seedValidationCache.set(cacheKeyFor(invalidId), {
        valid: false,
        expiresAt: now + SEED_VALIDATION_TTL_MS,
      });
    }
  }

  const candidatePool = args.pool.filter((track) => {
    const cached = seedValidationCache.get(cacheKeyFor(track.id));
    return cached ? cached.valid : true;
  });

  if (candidatePool.length >= targetSeedCount) {
    const selected = Array.from(
      new Set(
        selectSeedSet({
          playlistKey: args.playlistKey,
          pool: candidatePool,
          preferredSeedTracks: args.preferredSeedTracks,
        }).map((id) => id.trim())
      )
    );
    if (selected.length >= targetSeedCount) {
      return {
        seedTrackIds: selected.slice(0, targetSeedCount),
        rejectedSeedIds: args.pool
          .map((track) => track.id)
          .filter((id) => !candidatePool.some((track) => track.id === id)),
        targetSeedCount,
      };
    }
    const secondPass = selectSeedSet({
      playlistKey: args.playlistKey,
      pool: candidatePool,
    });
    const secondSelection = Array.from(new Set(secondPass.map((id) => id.trim())));
    return {
      seedTrackIds: secondSelection.slice(0, targetSeedCount),
      rejectedSeedIds: args.pool
        .map((track) => track.id)
        .filter((id) => !candidatePool.some((track) => track.id === id)),
      targetSeedCount,
    };
  }

  return {
    seedTrackIds: [] as string[],
    rejectedSeedIds: args.pool
      .map((track) => track.id)
      .filter((id) => {
        const cached = seedValidationCache.get(cacheKeyFor(id));
        return cached ? !cached.valid : false;
      }),
    targetSeedCount,
  };
}

function getShownSet(key: string) {
  const now = nowMs();
  const existing = shownTracksBySession.get(key);
  if (existing && existing.expiresAt > now) return existing.ids;
  const next = new Set<string>();
  shownTracksBySession.set(key, { ids: next, expiresAt: now + SHOWN_TTL_MS });
  return next;
}

function mapTrackToItem(track: RecoTrack): RecommendationItem | null {
  const trackId = normalizeTrackId(track.id ?? null);
  if (!trackId) return null;
  if (track.type && track.type !== "track") return null;
  const linkedFromTrackId = normalizeTrackId(track.linked_from?.id ?? null);
  const imageUrl = track.album?.images?.find((img) => typeof img?.url === "string")?.url ?? null;
  const artistIds =
    Array.isArray(track.artists)
      ? track.artists
          .map((artist) => String(artist?.id ?? "").trim())
          .filter((id) => /^[A-Za-z0-9]{22}$/.test(id))
      : [];
  const artists =
    Array.isArray(track.artists)
      ? track.artists.map((artist) => artist?.name).filter(Boolean).join(", ")
      : null;
  const releaseDate = track.album?.release_date ?? null;
  return {
    trackId,
    name: track.name ?? "Onbekende track",
    albumId: track.album?.id ?? null,
    albumName: track.album?.name ?? null,
    albumReleaseDate: releaseDate,
    releaseYear: releaseDate && /^\d{4}/.test(releaseDate) ? Number(releaseDate.slice(0, 4)) : null,
    albumImageUrl: imageUrl,
    coverUrl: imageUrl,
    durationMs: typeof track.duration_ms === "number" ? track.duration_ms : null,
    explicit: typeof track.explicit === "boolean" ? (track.explicit ? 1 : 0) : null,
    isLocal: typeof track.is_local === "boolean" ? (track.is_local ? 1 : 0) : null,
    linkedFromTrackId,
    restrictionsReason: typeof track.restrictions?.reason === "string" ? track.restrictions.reason : null,
    popularity: typeof track.popularity === "number" ? track.popularity : null,
    artists,
    artistIds,
    playlists: [],
  };
}

function isPlayableForMarket(track: RecoTrack, market: string) {
  if (track.is_playable === false) return false;
  if (Array.isArray(track.available_markets) && track.available_markets.length > 0) {
    return track.available_markets.includes(market);
  }
  return true;
}

async function resolveUserMarket(args: { userId: string; correlationId: string }) {
  const now = nowMs();
  const cacheKey = args.userId;
  const cached = userMarketCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.market;
  try {
    const me = await spotifyFetch<UserProfileResponse>({
      url: "https://api.spotify.com/v1/me",
      userLevel: true,
      correlationId: args.correlationId,
      priority: "interactive",
      requestClass: "read",
      cacheTtlMs: 3_000,
      staleWhileRevalidateMs: 10_000,
    });
    const market = String(me?.country ?? "").trim().toUpperCase() || "US";
    userMarketCache.set(cacheKey, { market, expiresAt: now + USER_MARKET_TTL_MS });
    return market;
  } catch {
    return "US";
  }
}

async function buildSeedPool(args: {
  userId: string;
  playlistId: string;
  market: string;
  correlationId: string;
  forceRefresh?: boolean;
}) {
  cleanupCaches();
  const key = `pool:${args.userId}:${args.playlistId}:${args.market}`;
  const cached = seedPoolCache.get(key);
  if (cached && !args.forceRefresh && cached.generatedAt + SEED_POOL_TTL_MS > nowMs()) {
    return cached;
  }

  const dropStats: Record<string, number> = {};
  const increment = (k: string) => {
    dropStats[k] = (dropStats[k] || 0) + 1;
  };
  let snapshotId: string | null = null;
  try {
    const meta = await spotifyFetch<PlaylistMetaResponse>({
      url: `https://api.spotify.com/v1/playlists/${encodeURIComponent(
        args.playlistId
      )}?fields=snapshot_id,tracks(total)`,
      userLevel: true,
      correlationId: args.correlationId,
      priority: "interactive",
      requestClass: "read",
      cacheTtlMs: 5_000,
      staleWhileRevalidateMs: 10_000,
    });
    snapshotId = meta?.snapshot_id ?? null;
  } catch {
    // best-effort
  }

  const collected = new Map<string, SeedTrackMeta>();
  let offset = 0;
  let pages = 0;
  let keepGoing = true;
  while (keepGoing && offset < MAX_PLAYLIST_ITEMS_SCAN) {
    pages += 1;
    const data = await spotifyFetch<PlaylistTracksResponse>({
      url: `https://api.spotify.com/v1/playlists/${encodeURIComponent(
        args.playlistId
      )}/tracks?limit=100&offset=${offset}&fields=items(track(type,id,is_local,is_playable,available_markets,popularity,artists(id))),next,total`,
      userLevel: true,
      correlationId: args.correlationId,
      priority: "interactive",
      requestClass: "read",
      cacheTtlMs: 2_000,
      staleWhileRevalidateMs: 5_000,
    });

    const items = Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      const track = item?.track;
      if (!track || (track.type && track.type !== "track")) {
        increment("NON_TRACK_ITEM");
        continue;
      }
      const trackId = normalizeTrackId(track.id ?? null);
      if (!trackId) {
        increment("MISSING_ID");
        continue;
      }
      if (track.is_local) {
        increment("LOCAL_TRACK");
        continue;
      }
      const playable =
        track.is_playable !== false &&
        (!Array.isArray(track.available_markets) ||
          track.available_markets.length === 0 ||
          track.available_markets.includes(args.market));
      if (!playable) {
        increment("NOT_PLAYABLE_MARKET");
        continue;
      }
      if (!collected.has(trackId)) {
        collected.set(trackId, {
          id: trackId,
          artistIds: Array.isArray(track.artists)
            ? track.artists
                .map((artist) => String(artist?.id ?? "").trim())
                .filter((id) => /^[A-Za-z0-9]{22}$/.test(id))
            : [],
          popularity:
            typeof track.popularity === "number" && Number.isFinite(track.popularity)
              ? track.popularity
              : null,
        });
      }
    }
    offset += items.length;
    keepGoing = Boolean(data?.next) && items.length > 0;
    if (pages > 20) break;
  }

  const entry: SeedPoolEntry = {
    tracks: Array.from(collected.values()),
    snapshotId,
    generatedAt: nowMs(),
    dropStats,
  };
  seedPoolCache.set(key, entry);
  return entry;
}

async function fetchRecommendations(args: {
  userId: string;
  playlistId: string;
  market: string;
  seedTrackIds: string[];
  limit: number;
  correlationId: string;
}) {
  const normalizedSeeds = args.seedTrackIds.map((id) => String(id).trim()).filter(Boolean);
  const uniqueSeeds = Array.from(new Set(normalizedSeeds));
  const params = new URLSearchParams({
    seed_tracks: uniqueSeeds.join(","),
    limit: String(args.limit),
    market: args.market,
  });
  const recoUrl = `https://api.spotify.com/v1/recommendations?${params.toString()}`;
  const outboundHost = new URL(recoUrl).host;
  const outboundPath = toOutboundPath(recoUrl);
  const invalidSeeds = uniqueSeeds.filter((id) => !/^[A-Za-z0-9]{22}$/.test(id));
  const hasWhitespaceInAnySeed = uniqueSeeds.some((id) => id !== id.trim());
  if (invalidSeeds.length > 0 || uniqueSeeds.length !== 5) {
    logEvent({
      level: "warn",
      event: "playlist_only_recommendations_seed_invalid",
      correlationId: args.correlationId,
      appUserId: args.userId,
      data: {
        playlistId: args.playlistId,
        seedCountAfterAllFilters: uniqueSeeds.length,
        uniqueCount: uniqueSeeds.length,
        hasWhitespaceInAnySeed,
        seedTracksArray: uniqueSeeds,
        invalidSeedTracksSample: invalidSeeds.slice(0, 3).map((seed) => ({
          seed,
          length: seed.length,
        })),
        invalidSeedCount: invalidSeeds.length,
      },
    });
    return {
      tracks: [],
      status: "seed_invalid" as const,
      outboundHost,
      outboundPath,
      outboundUrl: recoUrl,
      outboundExecuted: false as const,
    };
  }

  const seedHash = hashText(uniqueSeeds.join(","));
  const cacheKey = `reco:${args.userId}:${args.playlistId}:${args.market}:${seedHash}:${args.limit}`;
  const cached = recommendationsCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs()) {
    return {
      tracks: cached.value,
      status: "cache" as const,
      spotifyStatus: 200 as const,
      spotifyErrorExcerpt: null,
      outboundHost,
      outboundPath,
      outboundUrl: recoUrl,
      outboundExecuted: false as const,
    };
  }
  try {
    logEvent({
      level: "info",
      event: "playlist_only_recommendations_request_built",
      correlationId: args.correlationId,
      appUserId: args.userId,
      data: {
        playlistId: args.playlistId,
        market: args.market,
        seedTracksFinal: uniqueSeeds,
        seedCountFinal: uniqueSeeds.length,
        seedTracksParam: uniqueSeeds.join(","),
        outboundPath,
      },
    });
    const response = await spotifyFetch<RecoResponse>({
      url: recoUrl,
      userLevel: true,
      correlationId: args.correlationId,
      priority: "interactive",
      requestClass: "read",
      maxAttempts: 1,
      cacheTtlMs: 3_000,
      staleWhileRevalidateMs: 8_000,
    });
    const tracks = Array.isArray(response?.tracks) ? response.tracks : [];
    logEvent({
      level: "info",
      event: "playlist_only_recommendations_spotify_response",
      correlationId: args.correlationId,
      appUserId: args.userId,
      data: {
        playlistId: args.playlistId,
        outboundHost,
        outboundPath,
        spotifyStatus: 200,
        marketUsed: args.market,
        rawTrackCount: tracks.length,
      },
    });
    recommendationsCache.set(cacheKey, { value: tracks, expiresAt: nowMs() + RECO_CACHE_TTL_MS });
    return {
      tracks,
      status: "ok" as const,
      spotifyStatus: 200 as const,
      spotifyErrorExcerpt: null,
      outboundHost,
      outboundPath,
      outboundUrl: recoUrl,
      outboundExecuted: true as const,
    };
  } catch (error) {
    if (error instanceof SpotifyFetchError) {
      const spotifyErrorExcerpt = getSpotifyErrorExcerpt(error.body);
      logEvent({
        level: "warn",
        event: "playlist_only_recommendations_spotify_error",
        correlationId: args.correlationId,
        appUserId: args.userId,
        data: {
          playlistId: args.playlistId,
          outboundUrl: recoUrl,
          outboundHost,
          outboundPath,
          hasAuthHeader:
            error.hasAuthHeader ?? (typeof error.url === "string" ? error.url.includes("api.spotify.com") : null),
          responseContentType: error.responseContentType ?? null,
          spotifyStatus: error.status,
          spotifyErrorCode: error.code,
          spotifyErrorMessage: spotifyErrorExcerpt,
          responseBodySnippet: spotifyErrorExcerpt,
          marketUsed: args.market,
        },
      });
      if (error.status === 429) {
        throw new RecommendationsServiceError({
          status: 429,
          code: "RATE_LIMIT",
          message: "Spotify tijdelijk geblokkeerd (rate limit).",
          retryAfterSec:
            error.retryAfterMs && error.retryAfterMs > 0
              ? Math.max(1, Math.ceil(error.retryAfterMs / 1000))
              : 5,
          correlationId: error.correlationId,
          upstreamStatus: error.status,
          upstreamErrorExcerpt: spotifyErrorExcerpt,
          outboundHost,
          outboundPath,
          outboundUrl: error.url ?? recoUrl,
          hasAuthHeader: error.hasAuthHeader,
          responseContentType: error.responseContentType ?? null,
        });
      }
      if (error.status === 401) {
        throw new RecommendationsServiceError({
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Log opnieuw in om aanbevelingen te laden.",
          correlationId: error.correlationId,
          upstreamStatus: error.status,
          upstreamErrorExcerpt: spotifyErrorExcerpt,
          outboundHost,
          outboundPath,
          outboundUrl: error.url ?? recoUrl,
          hasAuthHeader: error.hasAuthHeader,
          responseContentType: error.responseContentType ?? null,
        });
      }
      if (error.status === 403) {
        throw new RecommendationsServiceError({
          status: 403,
          code: "FORBIDDEN",
          message: "Spotify scope of rechten ontbreken voor recommendations.",
          correlationId: error.correlationId,
          upstreamStatus: error.status,
          upstreamErrorExcerpt: spotifyErrorExcerpt,
          outboundHost,
          outboundPath,
          outboundUrl: error.url ?? recoUrl,
          hasAuthHeader: error.hasAuthHeader,
          responseContentType: error.responseContentType ?? null,
        });
      }
      if (error.status === 404) {
        throw new RecommendationsServiceError({
          status: 502,
          code: "SPOTIFY_UPSTREAM",
          message: "Spotify endpoint niet gevonden voor recommendations.",
          correlationId: error.correlationId,
          upstreamStatus: error.status,
          upstreamErrorExcerpt: spotifyErrorExcerpt,
          outboundHost,
          outboundPath,
          outboundUrl: error.url ?? recoUrl,
          hasAuthHeader: error.hasAuthHeader,
          responseContentType: error.responseContentType ?? null,
        });
      }
      if (error.status === 400) {
        const body = String(error.body ?? "").toLowerCase();
        const looksLikeSeedIssue =
          body.includes("seed") ||
          body.includes("invalid id") ||
          body.includes("parameter") ||
          body.includes("track");
        if (looksLikeSeedIssue) {
          return {
            tracks: [],
            status: "seed_invalid" as const,
            spotifyStatus: error.status,
            spotifyErrorExcerpt,
            outboundHost,
            outboundPath,
            outboundUrl: recoUrl,
            outboundExecuted: true as const,
          };
        }
        throw new RecommendationsServiceError({
          status: 502,
          code: "SPOTIFY_UPSTREAM",
          message: "Spotify request ongeldig door upstream validatie.",
          correlationId: error.correlationId,
          upstreamStatus: error.status,
          upstreamErrorExcerpt: spotifyErrorExcerpt,
          outboundHost,
          outboundPath,
          outboundUrl: error.url ?? recoUrl,
          hasAuthHeader: error.hasAuthHeader,
          responseContentType: error.responseContentType ?? null,
        });
      }
    }
    throw new RecommendationsServiceError({
      status: 502,
      code: "SPOTIFY_UPSTREAM",
      message: "Spotify is tijdelijk niet bereikbaar.",
      correlationId:
        error instanceof SpotifyFetchError ? error.correlationId : args.correlationId,
      upstreamStatus: error instanceof SpotifyFetchError ? error.status : null,
      upstreamErrorExcerpt:
        error instanceof SpotifyFetchError ? getSpotifyErrorExcerpt(error.body) : null,
      outboundHost,
      outboundPath,
      outboundUrl: error instanceof SpotifyFetchError ? error.url : recoUrl,
      hasAuthHeader: error instanceof SpotifyFetchError ? error.hasAuthHeader : null,
      responseContentType:
        error instanceof SpotifyFetchError ? error.responseContentType : null,
    });
  }
}

type FilterResult = {
  items: RecommendationItem[];
  filteredReasons: Record<string, number>;
};

function filterRecommendationTracks(args: {
  tracks: RecoTrack[];
  market: string;
  shownSet: Set<string>;
  seedTrackIds: string[];
}) {
  const filteredReasons: Record<string, number> = {
    DUPLICATE: 0,
    NOT_PLAYABLE: 0,
    SESSION_DEDUP: 0,
    NON_TRACK: 0,
  };
  const dedup = new Set<string>();
  const seedSet = new Set(args.seedTrackIds);
  const items: RecommendationItem[] = [];
  for (const track of args.tracks) {
    const item = mapTrackToItem(track);
    if (!item) {
      filteredReasons.NON_TRACK += 1;
      continue;
    }
    if (!isPlayableForMarket(track, args.market)) {
      filteredReasons.NOT_PLAYABLE += 1;
      continue;
    }
    if (seedSet.has(item.trackId)) {
      filteredReasons.DUPLICATE += 1;
      continue;
    }
    if (dedup.has(item.trackId)) {
      filteredReasons.DUPLICATE += 1;
      continue;
    }
    if (args.shownSet.has(item.trackId)) {
      filteredReasons.SESSION_DEDUP += 1;
      continue;
    }
    dedup.add(item.trackId);
    items.push(item);
  }
  return { items, filteredReasons } satisfies FilterResult;
}

export type PlaylistOnlyRecommendationsResponse = {
  status: RecommendationStatus;
  playlistId: string;
  market: string;
  seed: {
    trackIds: string[];
    seedHash: string;
    poolSize: number;
  };
  tracks: Array<{
    id: string;
    name: string;
    artists: string[];
    album: string | null;
    imageUrl: string | null;
    previewUrl: null;
    uri: string;
    isPlayable: boolean;
  }>;
  meta: {
    requestedLimit: number;
    returnedRaw: number;
    afterFilter: number;
    topUpUsed: boolean;
    filteredReasons: Record<string, number>;
    spotifyStatus?: number | null;
    spotifyErrorMessage?: string | null;
    outboundHost?: string | null;
    outboundPath?: string | null;
    outboundUrl?: string | null;
    outboundExecuted?: boolean | null;
    tokenPresent?: boolean | null;
  };
  hints?: string[];
  code?: string;
  retryAfterSeconds?: number;
  requestId: string;
  legacyItems: RecommendationItem[];
  legacyReason?: "no_results" | "seed_rejected" | "upstream_fallback";
};

export async function getPlaylistOnlyRecommendations(args: {
  userId: string;
  playlistId: string;
  correlationId: string;
  limit: number;
  mode: RecommendationMode;
  preferredSeedTracks?: string[];
  forceRefresh?: boolean;
}) {
  cleanupCaches();
  const inflightKey = `reco-run:${args.userId}:${args.playlistId}:${args.mode}:${args.limit}`;
  if (inflightReco.has(inflightKey)) {
    return await inflightReco.get(inflightKey)!;
  }

  const run = (async () => {
    const started = nowMs();
    const market = await resolveUserMarket({
      userId: args.userId,
      correlationId: args.correlationId,
    });
    const seedPool = await buildSeedPool({
      userId: args.userId,
      playlistId: args.playlistId,
      market,
      correlationId: args.correlationId,
      forceRefresh: args.forceRefresh || args.mode === "refresh",
    });
    if (seedPool.tracks.length === 0) {
      return {
        status: "empty",
        playlistId: args.playlistId,
        market,
        seed: {
          trackIds: [],
          seedHash: hashText(""),
          poolSize: 0,
        },
        tracks: [],
        meta: {
          requestedLimit: args.limit,
          returnedRaw: 0,
          afterFilter: 0,
          topUpUsed: false,
          filteredReasons: {},
        },
        hints: ["PLAYLIST_TOO_SMALL_OR_NICHE"],
        requestId: args.correlationId,
        legacyItems: [],
        legacyReason: "no_results",
      } satisfies PlaylistOnlyRecommendationsResponse;
    }
    if (seedPool.tracks.length < 5) {
      return {
        status: "empty",
        playlistId: args.playlistId,
        market,
        seed: {
          trackIds: [],
          seedHash: hashText(""),
          poolSize: seedPool.tracks.length,
        },
        tracks: [],
        meta: {
          requestedLimit: args.limit,
          returnedRaw: 0,
          afterFilter: 0,
          topUpUsed: false,
          filteredReasons: {
            INSUFFICIENT_PLAYLIST_SEEDS: 1,
          },
          tokenPresent: true,
        },
        hints: ["PLAYLIST_TOO_SMALL_OR_NICHE", "SEED_INVALID"],
        requestId: args.correlationId,
        legacyItems: [],
        legacyReason: "seed_rejected",
      } satisfies PlaylistOnlyRecommendationsResponse;
    }

    const playlistKey = `${args.userId}:${args.playlistId}:${market}`;
    const firstSeedSelection = await selectValidatedSeedSet({
      userId: args.userId,
      playlistId: args.playlistId,
      playlistKey,
      pool: seedPool.tracks,
      market,
      correlationId: args.correlationId,
      preferredSeedTracks: args.preferredSeedTracks,
    });
    const firstSeeds = firstSeedSelection.seedTrackIds;
    if (firstSeeds.length < firstSeedSelection.targetSeedCount) {
      return {
        status: "empty",
        playlistId: args.playlistId,
        market,
        seed: {
          trackIds: [],
          seedHash: hashText(""),
          poolSize: seedPool.tracks.length,
        },
        tracks: [],
        meta: {
          requestedLimit: args.limit,
          returnedRaw: 0,
          afterFilter: 0,
          topUpUsed: false,
          filteredReasons: {
            SEED_REJECTED: firstSeedSelection.rejectedSeedIds.length,
          },
          tokenPresent: true,
        },
        hints: ["SEED_INVALID", "MARKET_RESTRICTIONS"],
        requestId: args.correlationId,
        legacyItems: [],
        legacyReason: "seed_rejected",
      } satisfies PlaylistOnlyRecommendationsResponse;
    }
    const shownSet = getShownSet(playlistKey);
    const firstReco = await fetchRecommendations({
      userId: args.userId,
      playlistId: args.playlistId,
      market,
      seedTrackIds: firstSeeds,
      limit: Math.min(25, Math.max(5, args.limit)),
      correlationId: args.correlationId,
    });
    let filtered = filterRecommendationTracks({
      tracks: firstReco.tracks,
      market,
      shownSet,
      seedTrackIds: firstSeeds,
    });
    let topUpUsed = false;
    let returnedRaw = firstReco.tracks.length;
    let seedTrackIds = firstSeeds;

    if (filtered.items.length < MIN_DISPLAY_TARGET && seedPool.tracks.length > firstSeeds.length) {
      const secondSeedSelection = await selectValidatedSeedSet({
        userId: args.userId,
        playlistId: args.playlistId,
        playlistKey,
        pool: seedPool.tracks,
        market,
        correlationId: args.correlationId,
      });
      const secondSeeds = secondSeedSelection.seedTrackIds;
      if (secondSeeds.length < secondSeedSelection.targetSeedCount) {
        return {
          status: "empty",
          playlistId: args.playlistId,
          market,
          seed: {
            trackIds: [],
            seedHash: hashText(""),
            poolSize: seedPool.tracks.length,
          },
          tracks: [],
          meta: {
            requestedLimit: args.limit,
            returnedRaw,
            afterFilter: 0,
            topUpUsed: true,
            filteredReasons: {
              SEED_REJECTED: secondSeedSelection.rejectedSeedIds.length,
            },
            tokenPresent: true,
          },
          hints: ["SEED_INVALID", "MARKET_RESTRICTIONS"],
          requestId: args.correlationId,
          legacyItems: [],
          legacyReason: "seed_rejected",
        } satisfies PlaylistOnlyRecommendationsResponse;
      }
      const topupReco = await fetchRecommendations({
        userId: args.userId,
        playlistId: args.playlistId,
        market,
        seedTrackIds: secondSeeds,
        limit: 50,
        correlationId: args.correlationId,
      });
      topUpUsed = true;
      returnedRaw += topupReco.tracks.length;
      const merged = filterRecommendationTracks({
        tracks: [...firstReco.tracks, ...topupReco.tracks],
        market,
        shownSet,
        seedTrackIds: secondSeeds,
      });
      seedTrackIds = secondSeeds;
      filtered = {
        items: merged.items,
        filteredReasons: Object.fromEntries(
          Array.from(new Set([...Object.keys(filtered.filteredReasons), ...Object.keys(merged.filteredReasons)])).map(
            (key) => [key, (filtered.filteredReasons[key] || 0) + (merged.filteredReasons[key] || 0)]
          )
        ),
      };
    }

    for (const item of filtered.items) {
      shownSet.add(item.trackId);
    }

    const tracks = filtered.items.map((item) => ({
      id: item.trackId,
      name: item.name,
      artists: item.artists ? item.artists.split(", ").filter(Boolean) : [],
      album: item.albumName,
      imageUrl: item.coverUrl,
      previewUrl: null,
      uri: `spotify:track:${item.trackId}`,
      isPlayable: true,
    }));

    const response: PlaylistOnlyRecommendationsResponse =
      filtered.items.length >= MIN_DISPLAY_ABSOLUTE
        ? {
            status: "success",
            playlistId: args.playlistId,
            market,
            seed: {
              trackIds: seedTrackIds,
              seedHash: hashText(seedTrackIds.join(",")),
              poolSize: seedPool.tracks.length,
            },
            tracks,
            meta: {
              requestedLimit: args.limit,
              returnedRaw,
              afterFilter: filtered.items.length,
              topUpUsed,
              filteredReasons: filtered.filteredReasons,
              spotifyStatus: firstReco.spotifyStatus ?? null,
              spotifyErrorMessage: firstReco.spotifyErrorExcerpt ?? null,
              outboundHost: firstReco.outboundHost ?? null,
              outboundPath: firstReco.outboundPath ?? null,
              outboundUrl: firstReco.outboundUrl ?? null,
              outboundExecuted: firstReco.outboundExecuted ?? null,
              tokenPresent: true,
            },
            requestId: args.correlationId,
            legacyItems: filtered.items,
          }
        : {
            status: "empty",
            playlistId: args.playlistId,
            market,
            seed: {
              trackIds: seedTrackIds,
              seedHash: hashText(seedTrackIds.join(",")),
              poolSize: seedPool.tracks.length,
            },
            tracks,
            meta: {
              requestedLimit: args.limit,
              returnedRaw,
              afterFilter: filtered.items.length,
              topUpUsed,
              filteredReasons: filtered.filteredReasons,
              spotifyStatus: firstReco.spotifyStatus ?? null,
              spotifyErrorMessage: firstReco.spotifyErrorExcerpt ?? null,
              outboundHost: firstReco.outboundHost ?? null,
              outboundPath: firstReco.outboundPath ?? null,
              outboundUrl: firstReco.outboundUrl ?? null,
              outboundExecuted: firstReco.outboundExecuted ?? null,
              tokenPresent: true,
            },
            hints: ["PLAYLIST_TOO_SMALL_OR_NICHE", "MARKET_RESTRICTIONS"],
            requestId: args.correlationId,
            legacyItems: filtered.items,
            legacyReason: firstReco.status === "seed_invalid" ? "seed_rejected" : "no_results",
          };

    logEvent({
      level: "info",
      event: "playlist_only_recommendations",
      correlationId: args.correlationId,
      appUserId: args.userId,
      data: {
        playlistId: args.playlistId,
        market,
        poolSize: seedPool.tracks.length,
        seedCount: seedTrackIds.length,
        seedHash: hashText(seedTrackIds.join(",")),
        status: response.status,
        returnedRaw,
        afterFilter: filtered.items.length,
        totalMs: nowMs() - started,
        topUpUsed,
      },
    });

    return response;
  })();

  inflightReco.set(inflightKey, run);
  try {
    return await run;
  } finally {
    inflightReco.delete(inflightKey);
  }
}
