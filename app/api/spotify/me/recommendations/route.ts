import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { jsonNoStore, rateLimitResponse, requireAppUser } from "@/lib/api/guards";
import { getDb } from "@/lib/db/client";
import { artists, trackArtists, tracks, userSavedTracks } from "@/lib/db/schema";
import { desc, eq, sql } from "drizzle-orm";

export const runtime = "nodejs";

const TRACK_ID_REGEX = /^[A-Za-z0-9]{22}$/;
const ARTIST_ID_REGEX = /^[A-Za-z0-9]{22}$/;

type RecommendationsMode = "auto" | "on" | "off";

function clampInteger(value: number, fallback: number, min: number, max: number) {
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

const RECOMMENDATIONS_UNSUPPORTED_TTL_MS = clampInteger(
  Number(process.env.SPOTIFY_RECOMMENDATIONS_UNSUPPORTED_TTL_MS ?? "300000"),
  300_000,
  60_000,
  3_600_000
);

const RECOMMENDATIONS_MAX_ATTEMPTS = clampInteger(
  Number(process.env.SPOTIFY_RECOMMENDATIONS_MAX_ATTEMPTS ?? "10"),
  10,
  1,
  20
);

const RECOMMENDATIONS_UPSTREAM_TIMEOUT_MS = clampInteger(
  Number(process.env.SPOTIFY_RECOMMENDATIONS_UPSTREAM_TIMEOUT_MS ?? "8000"),
  8_000,
  2_000,
  20_000
);

const RECOMMENDATIONS_UPSTREAM_MAX_ATTEMPTS = clampInteger(
  Number(process.env.SPOTIFY_RECOMMENDATIONS_UPSTREAM_MAX_ATTEMPTS ?? "1"),
  1,
  1,
  2
);

const recommendationsCapabilityState = {
  unsupportedUntil: 0,
  reason: "",
};

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

type RecommendationItem = {
  trackId: string;
  name: string;
  albumId: string | null;
  albumName: string | null;
  albumReleaseDate: string | null;
  releaseYear: number | null;
  albumImageUrl: string | null;
  coverUrl: string | null;
  durationMs: number | null;
  explicit: number | null;
  isLocal: number | null;
  linkedFromTrackId: string | null;
  restrictionsReason: string | null;
  popularity: number | null;
  artists: string | null;
  artistIds: string[];
  playlists: Array<{ id: string; name: string; spotifyUrl: string }>;
};

type SeedAttempt = {
  seedTracks: string[];
  seedArtists: string[];
  key: string;
};

function normalizeTrackId(value: unknown) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (TRACK_ID_REGEX.test(raw)) return raw;
  if (raw.startsWith("spotify:track:")) {
    const id = raw.split(":").pop() ?? "";
    return TRACK_ID_REGEX.test(id) ? id : null;
  }
  return null;
}

function normalizeArtistId(value: unknown) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (ARTIST_ID_REGEX.test(raw)) return raw;
  if (raw.startsWith("spotify:artist:")) {
    const id = raw.split(":").pop() ?? "";
    return ARTIST_ID_REGEX.test(id) ? id : null;
  }
  return null;
}

function parseSeedTracks(value: string | null) {
  if (!value) return [] as string[];
  const seen = new Set<string>();
  const seeds: string[] = [];
  for (const part of value.split(",")) {
    const id = normalizeTrackId(part);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    seeds.push(id);
    if (seeds.length >= 50) break;
  }
  return seeds;
}

function parseSeedArtists(value: string | null) {
  if (!value) return [] as string[];
  const seen = new Set<string>();
  const seeds: string[] = [];
  for (const part of value.split(",")) {
    const id = normalizeArtistId(part);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    seeds.push(id);
    if (seeds.length >= 50) break;
  }
  return seeds;
}

function parseLimit(value: string | null) {
  const parsed = Number(value ?? "25");
  if (!Number.isFinite(parsed) || parsed <= 0) return 25;
  return Math.min(Math.floor(parsed), 100);
}

function uniqueIds(primary: string[], secondary: string[], maxSize = 50) {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const source of [primary, secondary]) {
    for (const id of source) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      deduped.push(id);
      if (deduped.length >= maxSize) {
        return deduped;
      }
    }
  }
  return deduped;
}

function pickRandomSubset(values: string[], count: number) {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const temp = shuffled[index];
    shuffled[index] = shuffled[swapIndex];
    shuffled[swapIndex] = temp;
  }
  const safeCount = Math.max(0, Math.floor(count));
  return shuffled.slice(0, Math.min(safeCount, shuffled.length));
}

function buildTrackAttempts(seedPool: string[]) {
  if (!seedPool.length) return [] as string[][];
  const size = Math.min(5, seedPool.length);
  const attemptsLimit = seedPool.length >= 12 ? 8 : 5;
  const attempts: string[][] = [];
  const seen = new Set<string>();
  while (attempts.length < attemptsLimit) {
    const candidate = pickRandomSubset(seedPool, size);
    const key = [...candidate].sort().join(",");
    if (!key || seen.has(key)) {
      if (seedPool.length <= size) break;
      continue;
    }
    seen.add(key);
    attempts.push(candidate);
    if (seedPool.length <= size) break;
  }
  return attempts;
}

function createSeedAttemptKey(seedTracks: string[], seedArtists: string[]) {
  const trackKey = [...seedTracks].sort().join(",");
  const artistKey = [...seedArtists].sort().join(",");
  return `t:${trackKey}|a:${artistKey}`;
}

function buildSeedAttempts(seedTracks: string[], seedArtists: string[]) {
  const attempts: SeedAttempt[] = [];
  const seen = new Set<string>();
  const trackAttempts = buildTrackAttempts(seedTracks);

  function addAttempt(next: { seedTracks: string[]; seedArtists?: string[] }) {
    const normalizedTracks = uniqueIds(next.seedTracks, [], 5);
    const normalizedArtists = uniqueIds(next.seedArtists ?? [], [], 5);
    if (!normalizedTracks.length) return;
    const availableArtistSlots = Math.max(0, 5 - normalizedTracks.length);
    const attemptArtists =
      availableArtistSlots > 0
        ? normalizedArtists.slice(0, availableArtistSlots)
        : ([] as string[]);
    const key = createSeedAttemptKey(normalizedTracks, attemptArtists);
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({
      seedTracks: normalizedTracks,
      seedArtists: attemptArtists,
      key,
    });
  }

  for (const trackAttempt of trackAttempts) {
    addAttempt({ seedTracks: trackAttempt });
  }

  if (seedArtists.length > 0 && trackAttempts.length > 0) {
    const mixedAttemptLimit = Math.min(RECOMMENDATIONS_MAX_ATTEMPTS, trackAttempts.length + 6);
    let guard = 0;
    while (attempts.length < mixedAttemptLimit && guard < 24) {
      const baseTracks =
        trackAttempts[guard % trackAttempts.length] ??
        pickRandomSubset(seedTracks, Math.min(4, seedTracks.length));
      const maxTrackCount = seedArtists.length >= 2 ? 3 : 4;
      const trackPart = pickRandomSubset(
        baseTracks,
        Math.max(1, Math.min(maxTrackCount, baseTracks.length))
      );
      const artistCount = Math.min(2, seedArtists.length, Math.max(0, 5 - trackPart.length));
      if (artistCount > 0) {
        addAttempt({
          seedTracks: trackPart,
          seedArtists: pickRandomSubset(seedArtists, artistCount),
        });
      }
      guard += 1;
    }
  }

  return attempts.slice(0, RECOMMENDATIONS_MAX_ATTEMPTS);
}

function mapRecommendationTracks(
  data: RecommendationsResponse | undefined,
  blockedTrackIds: Set<string>
) {
  const seen = new Set<string>();
  const mapped: RecommendationItem[] = [];
  for (const track of Array.isArray(data?.tracks) ? data.tracks : []) {
    const trackId = normalizeTrackId(track?.id ?? null);
    if (!trackId) continue;
    const canonicalTrackId = normalizeTrackId(track?.linked_from?.id ?? null) ?? trackId;
    if (seen.has(canonicalTrackId) || blockedTrackIds.has(canonicalTrackId)) continue;
    if (track?.is_playable === false) continue;
    if (typeof track?.restrictions?.reason === "string") continue;
    seen.add(canonicalTrackId);
    const releaseDate = track?.album?.release_date ?? null;
    const releaseYear =
      releaseDate && /^\d{4}/.test(releaseDate) ? Number(releaseDate.slice(0, 4)) : null;
    const imageUrl =
      track?.album?.images?.find((image) => typeof image?.url === "string")?.url ?? null;
    const artistIds = Array.isArray(track?.artists)
      ? uniqueIds(
          track.artists
            .map((artist) => normalizeArtistId(artist?.id ?? null))
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
      playlists: [] as Array<{ id: string; name: string; spotifyUrl: string }>,
    });
  }
  return mapped;
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
    // not json
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
  return text.includes("seed") || text.includes("invalid id") || text.includes("invalid base62");
}

function isRecommendationsUnavailableError(error: SpotifyFetchError) {
  if (![403, 404, 410, 501].includes(error.status)) return false;
  const text = normalizeSpotifyErrorText(error.body);
  if (text.includes("seed")) return false;
  if (error.status === 410 || error.status === 501) {
    return true;
  }
  const containsUnavailableSignal =
    text.includes("deprecated") ||
    text.includes("unsupported") ||
    text.includes("security requirement") ||
    text.includes("not available") ||
    text.includes("endpoint is disabled");
  if (error.status === 403) {
    return containsUnavailableSignal || text.includes("recommendation");
  }
  if (error.status === 404) {
    return (
      containsUnavailableSignal &&
      (text.includes("recommendation") ||
        text.includes("endpoint") ||
        text.includes("not found"))
    );
  }
  return false;
}

function markRecommendationsUnavailable(reason: string) {
  if (RECOMMENDATIONS_MODE !== "auto") return;
  recommendationsCapabilityState.unsupportedUntil =
    Date.now() + RECOMMENDATIONS_UNSUPPORTED_TTL_MS;
  recommendationsCapabilityState.reason = reason.slice(0, 160);
}

function recommendationsUnavailableResponse(args?: {
  retryAfterSec?: number | null;
  reason?: string | null;
}) {
  const retryAfterSec =
    typeof args?.retryAfterSec === "number" && Number.isFinite(args.retryAfterSec)
      ? Math.max(1, Math.floor(args.retryAfterSec))
      : null;
  return jsonNoStore(
    {
      error: "RECOMMENDATIONS_UNAVAILABLE",
      message:
        "Spotify Recommendations API is momenteel niet beschikbaar voor deze app. Gebruik de playlistlijst als fallback.",
      ...(retryAfterSec ? { retryAfter: retryAfterSec } : {}),
      ...(args?.reason ? { reason: args.reason } : {}),
    },
    503,
    retryAfterSec ? { "Retry-After": String(retryAfterSec) } : undefined
  );
}

async function fetchSeedArtistsFromTracks(seedTracks: string[]) {
  if (!seedTracks.length) return [] as string[];
  const ids = seedTracks.slice(0, 50).join(",");
  if (!ids) return [] as string[];
  const params = new URLSearchParams();
  params.set("ids", ids);
  params.set("market", "from_token");
  try {
    const data = await spotifyFetch<{
      tracks?: Array<{
        artists?: Array<{ id?: string | null }>;
      } | null>;
    }>({
      url: `https://api.spotify.com/v1/tracks?${params.toString()}`,
      userLevel: true,
      timeoutMs: RECOMMENDATIONS_UPSTREAM_TIMEOUT_MS,
      maxAttempts: RECOMMENDATIONS_UPSTREAM_MAX_ATTEMPTS,
    });
    const resolved: string[] = [];
    const seen = new Set<string>();
    for (const track of Array.isArray(data?.tracks) ? data.tracks : []) {
      for (const artist of Array.isArray(track?.artists) ? track.artists : []) {
        const artistId = normalizeArtistId(artist?.id ?? null);
        if (!artistId || seen.has(artistId)) continue;
        seen.add(artistId);
        resolved.push(artistId);
        if (resolved.length >= 50) {
          return resolved;
        }
      }
    }
    return resolved;
  } catch {
    return [] as string[];
  }
}

function parseArtistIdsCsv(value: string | null | undefined) {
  if (typeof value !== "string" || !value.trim()) return [] as string[];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const part of value.split(",")) {
    const id = normalizeArtistId(part);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function buildLocalFallbackRecommendations(args: {
  userId: string;
  limit: number;
  blockedTrackIds: Set<string>;
  seedArtists: string[];
}) {
  const db = getDb();
  const rows = await db
    .select({
      trackId: tracks.trackId,
      name: tracks.name,
      albumId: tracks.albumId,
      albumName: tracks.albumName,
      albumReleaseDate: tracks.albumReleaseDate,
      releaseYear: tracks.albumReleaseYear,
      albumImageUrl: tracks.albumImageUrl,
      durationMs: tracks.durationMs,
      explicit: tracks.explicit,
      isLocal: tracks.isLocal,
      linkedFromTrackId: tracks.linkedFromTrackId,
      restrictionsReason: tracks.restrictionsReason,
      popularity: tracks.popularity,
      artistsText: sql<string | null>`replace(group_concat(DISTINCT ${artists.name}), ',', ', ')`,
      artistIdsCsv: sql<string | null>`group_concat(DISTINCT ${artists.artistId})`,
      addedAt: userSavedTracks.addedAt,
    })
    .from(userSavedTracks)
    .innerJoin(tracks, eq(tracks.trackId, userSavedTracks.trackId))
    .leftJoin(trackArtists, eq(trackArtists.trackId, tracks.trackId))
    .leftJoin(artists, eq(artists.artistId, trackArtists.artistId))
    .where(eq(userSavedTracks.userId, args.userId))
    .groupBy(tracks.trackId, userSavedTracks.addedAt)
    .orderBy(desc(userSavedTracks.addedAt))
    .limit(700);

  if (!rows.length) return [] as RecommendationItem[];

  const seedArtistSet = new Set(args.seedArtists);
  const blockedTrackIds = args.blockedTrackIds;
  const candidates: Array<{ item: RecommendationItem; score: number }> = [];
  const now = Date.now();
  for (const row of rows) {
    const trackId = normalizeTrackId(row.trackId);
    if (!trackId) continue;
    const canonicalTrackId = normalizeTrackId(row.linkedFromTrackId ?? null) ?? trackId;
    if (blockedTrackIds.has(canonicalTrackId)) continue;
    if (typeof row.restrictionsReason === "string" && row.restrictionsReason.trim()) continue;
    if (typeof row.isLocal === "number" && row.isLocal === 1) continue;
    const artistIds = parseArtistIdsCsv(row.artistIdsCsv);
    const matchingArtistCount = artistIds.reduce(
      (count, id) => (seedArtistSet.has(id) ? count + 1 : count),
      0
    );
    const popularityScore =
      typeof row.popularity === "number" && Number.isFinite(row.popularity) ? row.popularity : 0;
    const recencyDays =
      typeof row.addedAt === "number" && Number.isFinite(row.addedAt)
        ? Math.max(0, Math.floor((now - row.addedAt) / 86_400_000))
        : 3650;
    const recencyScore = Math.max(0, 90 - Math.min(90, recencyDays));
    const explorationNoise = Math.random() * 6;
    const score =
      matchingArtistCount * 120 + popularityScore * 1.2 + recencyScore * 0.35 + explorationNoise;
    candidates.push({
      item: {
        trackId,
        name: row.name ?? "Onbekend nummer",
        albumId: row.albumId ?? null,
        albumName: row.albumName ?? null,
        albumReleaseDate: row.albumReleaseDate ?? null,
        releaseYear: typeof row.releaseYear === "number" ? row.releaseYear : null,
        albumImageUrl: row.albumImageUrl ?? null,
        coverUrl: row.albumImageUrl ?? null,
        durationMs: typeof row.durationMs === "number" ? row.durationMs : null,
        explicit:
          typeof row.explicit === "number" && Number.isFinite(row.explicit)
            ? row.explicit
            : null,
        isLocal:
          typeof row.isLocal === "number" && Number.isFinite(row.isLocal) ? row.isLocal : null,
        linkedFromTrackId: normalizeTrackId(row.linkedFromTrackId ?? null),
        restrictionsReason:
          typeof row.restrictionsReason === "string" ? row.restrictionsReason : null,
        popularity:
          typeof row.popularity === "number" && Number.isFinite(row.popularity)
            ? row.popularity
            : null,
        artists:
          typeof row.artistsText === "string" && row.artistsText.trim()
            ? row.artistsText
            : null,
        artistIds,
        playlists: [],
      },
      score,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const deduped: RecommendationItem[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const canonicalId =
      normalizeTrackId(candidate.item.linkedFromTrackId ?? null) ??
      normalizeTrackId(candidate.item.trackId) ??
      candidate.item.trackId;
    if (!canonicalId || seen.has(canonicalId)) continue;
    seen.add(canonicalId);
    deduped.push(candidate.item);
    if (deduped.length >= args.limit) break;
  }
  return deduped;
}

async function buildLocalFallbackRecommendationsSafe(args: {
  userId: string;
  limit: number;
  blockedTrackIds: Set<string>;
  seedArtists: string[];
}) {
  try {
    return await buildLocalFallbackRecommendations(args);
  } catch {
    return [] as RecommendationItem[];
  }
}

export async function GET(req: Request) {
  const { session, response } = await requireAppUser();
  if (response) return response;
  const rl = await rateLimitResponse({
    key: `recommendations:${session.appUserId}`,
    limit: 240,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rl) return rl;

  const { searchParams } = new URL(req.url);
  const seedTracks = parseSeedTracks(searchParams.get("seed_tracks"));
  if (seedTracks.length === 0) {
    return jsonNoStore({ error: "MISSING_SEED_TRACKS" }, 400);
  }
  const seedArtistsFromRequest = parseSeedArtists(searchParams.get("seed_artists"));
  const limit = parseLimit(searchParams.get("limit"));
  const blockedTrackIds = new Set(seedTracks);

  if (RECOMMENDATIONS_MODE === "off") {
    const localFallback = await buildLocalFallbackRecommendationsSafe({
      userId: session.appUserId as string,
      limit,
      blockedTrackIds,
      seedArtists: seedArtistsFromRequest,
    });
    if (localFallback.length > 0) {
      return jsonNoStore({
        items: localFallback,
        totalCount: localFallback.length,
        asOf: Date.now(),
        source: "local_fallback",
        reason: "disabled_by_config",
      });
    }
    return recommendationsUnavailableResponse({ reason: "disabled_by_config" });
  }

  if (
    RECOMMENDATIONS_MODE === "auto" &&
    recommendationsCapabilityState.unsupportedUntil > Date.now()
  ) {
    const localFallback = await buildLocalFallbackRecommendationsSafe({
      userId: session.appUserId as string,
      limit,
      blockedTrackIds,
      seedArtists: seedArtistsFromRequest,
    });
    if (localFallback.length > 0) {
      return jsonNoStore({
        items: localFallback,
        totalCount: localFallback.length,
        asOf: Date.now(),
        source: "local_fallback",
        reason: "cached_unavailable",
      });
    }
    const retryAfterSec = Math.max(
      1,
      Math.ceil((recommendationsCapabilityState.unsupportedUntil - Date.now()) / 1000)
    );
    return recommendationsUnavailableResponse({
      retryAfterSec,
      reason: recommendationsCapabilityState.reason || "cached_unavailable",
    });
  }

  try {
    const derivedSeedArtists = await fetchSeedArtistsFromTracks(seedTracks);
    const seedArtists = uniqueIds(seedArtistsFromRequest, derivedSeedArtists, 50);
    const seedAttempts = buildSeedAttempts(seedTracks, seedArtists);
    const collected: RecommendationItem[] = [];
    const collectedTrackIds = new Set<string>();
    let hadRejectedSeedAttempt = false;
    let unavailableReason: string | null = null;

    for (const seedAttempt of seedAttempts) {
      try {
        const params = new URLSearchParams();
        params.set("seed_tracks", seedAttempt.seedTracks.join(","));
        if (seedAttempt.seedArtists.length > 0) {
          params.set("seed_artists", seedAttempt.seedArtists.join(","));
        }
        params.set("limit", String(limit));
        params.set("market", "from_token");
        const data = await spotifyFetch<RecommendationsResponse>({
          url: `https://api.spotify.com/v1/recommendations?${params.toString()}`,
          userLevel: true,
          timeoutMs: RECOMMENDATIONS_UPSTREAM_TIMEOUT_MS,
          maxAttempts: RECOMMENDATIONS_UPSTREAM_MAX_ATTEMPTS,
        });
        const items = mapRecommendationTracks(data, blockedTrackIds);
        for (const item of items) {
          const canonicalId =
            normalizeTrackId(item.linkedFromTrackId ?? null) ??
            normalizeTrackId(item.trackId) ??
            item.trackId;
          if (!canonicalId || collectedTrackIds.has(canonicalId)) continue;
          collectedTrackIds.add(canonicalId);
          collected.push(item);
          if (collected.length >= limit) break;
        }
        if (collected.length >= limit) break;
      } catch (error) {
        if (error instanceof SpotifyFetchError) {
          if (isRejectedSeedError(error)) {
            hadRejectedSeedAttempt = true;
            continue;
          }
          if (isRecommendationsUnavailableError(error)) {
            const reason = extractSpotifyErrorMessage(error.body) || "upstream_unavailable";
            markRecommendationsUnavailable(reason);
            unavailableReason = reason;
            break;
          }
        }
        throw error;
      }
    }

    if (collected.length > 0) {
      return jsonNoStore({
        items: collected.slice(0, limit),
        totalCount: collected.length,
        asOf: Date.now(),
      });
    }

    const localFallback = await buildLocalFallbackRecommendationsSafe({
      userId: session.appUserId as string,
      limit,
      blockedTrackIds,
      seedArtists,
    });
    if (localFallback.length > 0) {
      return jsonNoStore({
        items: localFallback,
        totalCount: localFallback.length,
        asOf: Date.now(),
        source: "local_fallback",
        reason: unavailableReason ? "spotify_unavailable" : hadRejectedSeedAttempt ? "seed_rejected" : "no_results",
      });
    }

    if (unavailableReason) {
      const retryAfterSec =
        RECOMMENDATIONS_MODE === "auto"
          ? Math.max(1, Math.ceil(RECOMMENDATIONS_UNSUPPORTED_TTL_MS / 1000))
          : null;
      return recommendationsUnavailableResponse({
        retryAfterSec,
        reason: unavailableReason,
      });
    }

    return jsonNoStore({
      items: [],
      totalCount: 0,
      asOf: Date.now(),
      reason: hadRejectedSeedAttempt ? "seed_rejected" : "no_results",
    });
  } catch (error) {
    if (error instanceof SpotifyFetchError) {
      if (error.status === 401) return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
      if (error.status === 403) return jsonNoStore({ error: "FORBIDDEN" }, 403);
      if (isRejectedSeedError(error) || error.status === 400) {
        return jsonNoStore({ error: "INVALID_SEED_TRACKS" }, 422);
      }
      if (isRecommendationsUnavailableError(error)) {
        const reason = extractSpotifyErrorMessage(error.body) || "upstream_unavailable";
        markRecommendationsUnavailable(reason);
        const localFallback = await buildLocalFallbackRecommendationsSafe({
          userId: session.appUserId as string,
          limit,
          blockedTrackIds,
          seedArtists: seedArtistsFromRequest,
        });
        if (localFallback.length > 0) {
          return jsonNoStore({
            items: localFallback,
            totalCount: localFallback.length,
            asOf: Date.now(),
            source: "local_fallback",
            reason: "spotify_unavailable",
          });
        }
        const retryAfterSec =
          RECOMMENDATIONS_MODE === "auto"
            ? Math.max(1, Math.ceil(RECOMMENDATIONS_UNSUPPORTED_TTL_MS / 1000))
            : null;
        return recommendationsUnavailableResponse({
          retryAfterSec,
          reason,
        });
      }
      if (error.status === 429) {
        const retryAfter =
          error.retryAfterMs && error.retryAfterMs > 0
            ? Math.max(1, Math.ceil(error.retryAfterMs / 1000))
            : null;
        return jsonNoStore(
          { error: "RATE_LIMIT", ...(retryAfter ? { retryAfter } : {}) },
          429,
          retryAfter ? { "Retry-After": String(retryAfter) } : undefined
        );
      }
      const localFallback = await buildLocalFallbackRecommendationsSafe({
        userId: session.appUserId as string,
        limit,
        blockedTrackIds,
        seedArtists: seedArtistsFromRequest,
      });
      if (localFallback.length > 0) {
        return jsonNoStore({
          items: localFallback,
          totalCount: localFallback.length,
          asOf: Date.now(),
          source: "local_fallback",
          reason: "spotify_upstream",
        });
      }
      return jsonNoStore({
        items: [],
        totalCount: 0,
        asOf: Date.now(),
        reason: "spotify_upstream",
      });
    }
    if (String(error).includes("UserNotAuthenticated")) {
      return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
    }
    const localFallback = await buildLocalFallbackRecommendationsSafe({
      userId: session.appUserId as string,
      limit,
      blockedTrackIds,
      seedArtists: seedArtistsFromRequest,
    });
    if (localFallback.length > 0) {
      return jsonNoStore({
        items: localFallback,
        totalCount: localFallback.length,
        asOf: Date.now(),
        source: "local_fallback",
        reason: "internal_recovery",
      });
    }
    return jsonNoStore({
      items: [],
      totalCount: 0,
      asOf: Date.now(),
      reason: "internal_recovery",
    });
  }
}
