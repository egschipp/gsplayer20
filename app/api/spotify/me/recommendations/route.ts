import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { jsonNoStore, rateLimitResponse, requireAppUser } from "@/lib/api/guards";

export const runtime = "nodejs";

const TRACK_ID_REGEX = /^[A-Za-z0-9]{22}$/;

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

function parseLimit(value: string | null) {
  const parsed = Number(value ?? "25");
  if (!Number.isFinite(parsed) || parsed <= 0) return 25;
  return Math.min(Math.floor(parsed), 100);
}

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
    artists?: Array<{ name?: string | null }>;
  }>;
};

function pickRandomSubset(values: string[], count: number) {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const temp = shuffled[index];
    shuffled[index] = shuffled[swapIndex];
    shuffled[swapIndex] = temp;
  }
  return shuffled.slice(0, Math.max(1, count));
}

function buildSeedAttempts(seedPool: string[]) {
  if (!seedPool.length) return [] as string[][];
  const size = Math.min(5, seedPool.length);
  const attemptsLimit = seedPool.length >= 12 ? 10 : 6;
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

function mapRecommendationTracks(
  data: RecommendationsResponse | undefined,
  blockedTrackIds: Set<string>
) {
  const seen = new Set<string>();
  return (Array.isArray(data?.tracks) ? data.tracks : [])
    .map((track) => {
      const trackId = normalizeTrackId(track?.id ?? null);
      if (!trackId) return null;
      const canonicalTrackId =
        normalizeTrackId(track?.linked_from?.id ?? null) ?? trackId;
      if (seen.has(canonicalTrackId) || blockedTrackIds.has(canonicalTrackId)) return null;
      if (track?.is_playable === false) return null;
      if (typeof track?.restrictions?.reason === "string") return null;
      seen.add(canonicalTrackId);
      const releaseDate = track?.album?.release_date ?? null;
      const releaseYear =
        releaseDate && /^\d{4}/.test(releaseDate)
          ? Number(releaseDate.slice(0, 4))
          : null;
      const imageUrl =
        track?.album?.images?.find((image) => typeof image?.url === "string")?.url ??
        null;
      return {
        trackId,
        name: track?.name ?? "Onbekend nummer",
        albumId: track?.album?.id ?? null,
        albumName: track?.album?.name ?? null,
        albumReleaseDate: releaseDate,
        releaseYear,
        albumImageUrl: imageUrl,
        coverUrl: imageUrl,
        durationMs: typeof track?.duration_ms === "number" ? track.duration_ms : null,
        explicit:
          typeof track?.explicit === "boolean" ? (track.explicit ? 1 : 0) : null,
        isLocal:
          typeof track?.is_local === "boolean" ? (track.is_local ? 1 : 0) : null,
        linkedFromTrackId: normalizeTrackId(track?.linked_from?.id ?? null),
        restrictionsReason:
          typeof track?.restrictions?.reason === "string"
            ? track.restrictions.reason
            : null,
        popularity: typeof track?.popularity === "number" ? track.popularity : null,
        artists: Array.isArray(track?.artists)
          ? track.artists
              .map((artist) => artist?.name)
              .filter(Boolean)
              .join(", ")
          : null,
        playlists: [] as Array<{ id: string; name: string; spotifyUrl: string }>,
      };
    })
    .filter(Boolean);
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
  const limit = parseLimit(searchParams.get("limit"));

  try {
    const seedAttempts = buildSeedAttempts(seedTracks);
    const blockedTrackIds = new Set(seedTracks);
    let lastBadRequest = false;
    for (const seedAttempt of seedAttempts) {
      try {
        const params = new URLSearchParams();
        params.set("seed_tracks", seedAttempt.join(","));
        params.set("limit", String(limit));
        const data = await spotifyFetch<RecommendationsResponse>({
          url: `https://api.spotify.com/v1/recommendations?${params.toString()}`,
          userLevel: true,
        });
        const items = mapRecommendationTracks(data, blockedTrackIds);
        return jsonNoStore({
          items,
          totalCount: items.length,
          asOf: Date.now(),
        });
      } catch (error) {
        if (error instanceof SpotifyFetchError && error.status === 400) {
          lastBadRequest = true;
          continue;
        }
        throw error;
      }
    }

    if (lastBadRequest) {
      return jsonNoStore({
        items: [],
        totalCount: 0,
        asOf: Date.now(),
      });
    }

    return jsonNoStore({
      items: [],
      totalCount: 0,
      asOf: Date.now(),
    });
  } catch (error) {
    if (error instanceof SpotifyFetchError) {
      if (error.status === 401) return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
      if (error.status === 403) return jsonNoStore({ error: "FORBIDDEN" }, 403);
      if (error.status === 400) return jsonNoStore({ error: "INVALID_SEED_TRACKS" }, 422);
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
      return jsonNoStore({ error: "SPOTIFY_UPSTREAM" }, 502);
    }
    if (String(error).includes("UserNotAuthenticated")) {
      return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
    }
    return jsonNoStore({ error: "SPOTIFY_UPSTREAM" }, 502);
  }
}
