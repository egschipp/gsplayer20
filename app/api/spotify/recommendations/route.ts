import crypto from "crypto";
import {
  jsonNoStore,
  rateLimitResponse,
  requireAppUser,
} from "@/lib/api/guards";
import {
  createCorrelationId,
  readCorrelationId,
} from "@/lib/observability/correlation";
import { logEvent } from "@/lib/observability/logger";
import { incCounter, observeHistogram } from "@/lib/observability/metrics";
import {
  normalizeSelectedIds,
  pickSeeds,
} from "@/lib/recommendations/seedPicker";
import type {
  RecommendationsErrorCode,
  RecommendationsErrorResponse,
  RecommendationsRequestBody,
  RecommendationsSuccessResponse,
} from "@/lib/recommendations/types";
import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import {
  mapSpotifyRecommendationItems,
  mapSpotifyRecommendationSeeds,
} from "@/lib/spotify/mappers/recommendations";
import {
  coalesceInflight,
  getCachedValue,
  setCachedValue,
} from "@/lib/spotify/requestCache";

export const runtime = "nodejs";

const CACHE_TTL_MS = 60_000;
const STALE_CACHE_TTL_MS = 10 * 60_000;
const DEFAULT_LIMIT = 20;
const DEFAULT_SEED_COUNT_MAX = 5;
const MAX_TUNING_KEYS = 12;
const MARKET_PATTERN = /^[A-Z]{2}$/;
const FEATURE_VALUES_TRUE = new Set(["1", "true", "yes", "on"]);

const ZERO_TO_ONE_ATTRS = new Set([
  "acousticness",
  "danceability",
  "energy",
  "instrumentalness",
  "liveness",
  "speechiness",
  "valence",
]);

const ZERO_TO_HUNDRED_ATTRS = new Set(["popularity"]);
const KEY_ATTRS = new Set(["key"]);
const MODE_ATTRS = new Set(["mode"]);
const TEMPO_ATTRS = new Set(["tempo"]);
const DURATION_ATTRS = new Set(["duration_ms"]);
const LOUDNESS_ATTRS = new Set(["loudness"]);
const TIME_SIGNATURE_ATTRS = new Set(["time_signature"]);

function isFeatureEnabled(): boolean {
  const server = String(process.env.FEATURE_RECOMMENDATIONS ?? "")
    .trim()
    .toLowerCase();
  const client = String(process.env.NEXT_PUBLIC_FEATURE_RECOMMENDATIONS ?? "")
    .trim()
    .toLowerCase();
  if (server || client) {
    return FEATURE_VALUES_TRUE.has(server) || FEATURE_VALUES_TRUE.has(client);
  }
  return true;
}

function stableStringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries.map(([key, val]) => `${key}:${stableStringify(val)}`).join(",")}}`;
  }
  return String(value);
}

function createHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function errorResponse(args: {
  status: number;
  code: RecommendationsErrorCode;
  message: string;
  correlationId: string;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
  retryAfterHeader?: boolean;
}) {
  const body: RecommendationsErrorResponse = {
    error: {
      code: args.code,
      message: args.message,
      correlationId: args.correlationId,
      ...(args.retryAfterMs && args.retryAfterMs > 0
        ? { retryAfterMs: Math.floor(args.retryAfterMs) }
        : {}),
      ...(args.details ? { details: args.details } : {}),
    },
  };
  const retryAfterSeconds =
    args.retryAfterHeader && args.retryAfterMs && args.retryAfterMs > 0
      ? Math.max(1, Math.ceil(args.retryAfterMs / 1000))
      : null;
  return jsonNoStore(body, args.status, {
    "x-correlation-id": args.correlationId,
    ...(retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : {}),
  });
}

function parseLimit(value: unknown): number | null {
  if (value == null) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.floor(parsed);
  if (normalized < 1 || normalized > 100) return null;
  return normalized;
}

function parseSeedCountMax(value: unknown): number | null {
  if (value == null) return DEFAULT_SEED_COUNT_MAX;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.floor(parsed);
  if (normalized < 1 || normalized > 5) return null;
  return normalized;
}

function parseSeedNonce(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 128) return null;
  return trimmed;
}

function parseMarket(value: unknown): { market: string; fromToken: boolean } | null {
  if (value == null || value === "") {
    return { market: "from_token", fromToken: true };
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return { market: "from_token", fromToken: true };
  if (trimmed === "from_token") {
    return { market: "from_token", fromToken: true };
  }
  const upper = trimmed.toUpperCase();
  if (!MARKET_PATTERN.test(upper)) return null;
  return { market: upper, fromToken: false };
}

function validateTuning(
  tuning: unknown
): { params: Record<string, number>; error: string | null } {
  if (tuning == null) return { params: {}, error: null };
  if (typeof tuning !== "object" || Array.isArray(tuning)) {
    return { params: {}, error: "Tuning moet een object zijn." };
  }

  const entries = Object.entries(tuning as Record<string, unknown>);
  if (entries.length > MAX_TUNING_KEYS) {
    return {
      params: {},
      error: `Maximaal ${MAX_TUNING_KEYS} tuning velden toegestaan.`,
    };
  }

  const params: Record<string, number> = {};
  for (const [key, value] of entries) {
    if (!/^(min|max|target)_[a-z_]+$/.test(key)) {
      return { params: {}, error: `Onbekende tuning parameter: ${key}` };
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { params: {}, error: `Tuning waarde voor ${key} moet een getal zijn.` };
    }

    const attr = key.replace(/^(min|max|target)_/, "");
    const num = Number(value);

    const inRange = (() => {
      if (ZERO_TO_ONE_ATTRS.has(attr)) return num >= 0 && num <= 1;
      if (ZERO_TO_HUNDRED_ATTRS.has(attr)) return num >= 0 && num <= 100;
      if (KEY_ATTRS.has(attr)) return Number.isInteger(num) && num >= 0 && num <= 11;
      if (MODE_ATTRS.has(attr)) return Number.isInteger(num) && (num === 0 || num === 1);
      if (TEMPO_ATTRS.has(attr)) return num >= 0 && num <= 300;
      if (DURATION_ATTRS.has(attr)) return num >= 0 && num <= 1_200_000;
      if (LOUDNESS_ATTRS.has(attr)) return num >= -60 && num <= 0;
      if (TIME_SIGNATURE_ATTRS.has(attr))
        return Number.isInteger(num) && num >= 0 && num <= 11;
      return false;
    })();

    if (!inRange) {
      return { params: {}, error: `Ongeldige tuning range voor ${key}.` };
    }

    params[key] = Number.isInteger(num) ? Math.floor(num) : Number(num.toFixed(4));
  }

  return { params, error: null };
}

function mapSpotifyError(
  error: SpotifyFetchError,
  correlationId: string
): {
  status: number;
  code: RecommendationsErrorCode;
  message: string;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
  retryAfterHeader?: boolean;
} {
  if (error.status === 401) {
    return {
      status: 401,
      code: "AUTH_REQUIRED",
      message: "Log opnieuw in om recommendations te laden.",
    };
  }
  if (error.status === 403) {
    return {
      status: 403,
      code: "FORBIDDEN",
      message: "Onvoldoende rechten om recommendations op te halen.",
    };
  }
  if (error.status === 429) {
    return {
      status: 429,
      code: "RATE_LIMITED",
      message: "Spotify rate limit bereikt. Probeer zo opnieuw.",
      retryAfterMs: error.retryAfterMs ?? 1000,
      retryAfterHeader: true,
      details: { source: "spotify" },
    };
  }
  if (error.status === 504 || error.code === "QUEUE_TIMEOUT") {
    return {
      status: 504,
      code: "QUEUE_TIMEOUT",
      message: "De Spotify wachtrij is te druk. Probeer opnieuw.",
    };
  }
  if (error.status === 400) {
    const lower = String(error.body || "").toLowerCase();
    return {
      status: 400,
      code: "INVALID_TUNING",
      message: lower.includes("seed")
        ? "Spotify heeft deze seed set afgewezen."
        : "Ongeldige recommendation parameters.",
      details: {
        spotifyCode: error.code,
        spotifyMessage: String(error.body || "").slice(0, 400),
        correlationId,
      },
    };
  }

  return {
    status: error.status >= 500 ? 503 : 502,
    code: "SPOTIFY_UNAVAILABLE",
    message: "Spotify recommendations zijn tijdelijk niet beschikbaar.",
    details: {
      spotifyCode: error.code,
      spotifyMessage: String(error.body || "").slice(0, 400),
    },
  };
}

export async function POST(req: Request) {
  const started = Date.now();
  const correlationId = readCorrelationId(req.headers) || createCorrelationId();

  if (!isFeatureEnabled()) {
    return errorResponse({
      status: 404,
      code: "FEATURE_DISABLED",
      message: "Recommendations feature staat uit.",
      correlationId,
    });
  }

  const { session, response } = await requireAppUser();
  if (response) return response;

  const appUserId = String(session.appUserId ?? "").trim();
  if (!appUserId) {
    return errorResponse({
      status: 401,
      code: "AUTH_REQUIRED",
      message: "Log opnieuw in om recommendations te laden.",
      correlationId,
    });
  }

  const rl = await rateLimitResponse({
    key: `recommendations:${appUserId}`,
    limit: 120,
    windowMs: 60_000,
    includeRetryAfter: true,
    body: {
      error: {
        code: "RATE_LIMITED",
        message: "Te veel requests. Probeer opnieuw.",
        correlationId,
      },
    },
  });
  if (rl) return rl;

  const body = (await req.json().catch(() => null)) as RecommendationsRequestBody | null;
  if (!body || typeof body !== "object") {
    return errorResponse({
      status: 400,
      code: "INVALID_BODY",
      message: "Request body ontbreekt of is ongeldig.",
      correlationId,
    });
  }

  const selectedTrackIds = Array.isArray(body.selectedTrackIds)
    ? body.selectedTrackIds
    : [];
  if (!selectedTrackIds.length) {
    return errorResponse({
      status: 400,
      code: "INVALID_SELECTED_TRACK_IDS",
      message: "selectedTrackIds is verplicht en moet minimaal 1 id bevatten.",
      correlationId,
    });
  }

  const normalizedIds = normalizeSelectedIds(selectedTrackIds);
  if (!normalizedIds.length) {
    return errorResponse({
      status: 400,
      code: "INVALID_SELECTED_TRACK_IDS",
      message: "Geen geldige Spotify track IDs in selectedTrackIds.",
      correlationId,
    });
  }

  const seedCountMax = parseSeedCountMax(body.seedCountMax);
  if (!seedCountMax) {
    return errorResponse({
      status: 400,
      code: "INVALID_SEED_COUNT_MAX",
      message: "seedCountMax moet tussen 1 en 5 liggen.",
      correlationId,
    });
  }

  const seedNonce = parseSeedNonce(body.seedNonce);
  if (body.seedNonce != null && !seedNonce) {
    return errorResponse({
      status: 400,
      code: "INVALID_SEED_NONCE",
      message: "seedNonce is ongeldig.",
      correlationId,
    });
  }

  const limit = parseLimit(body.limit);
  if (!limit) {
    return errorResponse({
      status: 400,
      code: "INVALID_LIMIT",
      message: "limit moet tussen 1 en 100 liggen.",
      correlationId,
    });
  }

  const marketInput = parseMarket(body.market);
  if (!marketInput) {
    return errorResponse({
      status: 400,
      code: "INVALID_MARKET",
      message: "market moet 'from_token' of een ISO landcode zijn.",
      correlationId,
    });
  }

  const tuningValidation = validateTuning(body.tuning);
  if (tuningValidation.error) {
    return errorResponse({
      status: 400,
      code: "INVALID_TUNING",
      message: tuningValidation.error,
      correlationId,
    });
  }

  const { seedTrackIds, selectionHash } = pickSeeds({
    normalizedIds,
    seedCountMax,
    seedNonce,
    userId: appUserId,
  });

  if (!seedTrackIds.length) {
    return errorResponse({
      status: 400,
      code: "NO_VALID_SEEDS",
      message: "Er konden geen bruikbare seeds worden bepaald.",
      correlationId,
    });
  }

  try {
    let marketUsed = marketInput.market;
    let omitMarketParam = false;
    if (marketInput.fromToken) {
      try {
        const profile = await spotifyFetch<{ country?: string }>({
          url: "https://api.spotify.com/v1/me",
          userLevel: true,
          correlationId,
          priority: "default",
          cacheTtlMs: 60_000,
          dedupeWindowMs: 2_000,
        });
        const tokenCountry = String(profile?.country ?? "")
          .trim()
          .toUpperCase();
        if (MARKET_PATTERN.test(tokenCountry)) {
          marketUsed = tokenCountry;
        } else {
          marketUsed = "from_token";
          omitMarketParam = true;
        }
      } catch (error) {
        if (error instanceof SpotifyFetchError) {
          if (error.status === 401) {
            return errorResponse({
              status: 401,
              code: "AUTH_REQUIRED",
              message: "Log opnieuw in om recommendations te laden.",
              correlationId,
            });
          }
          if (error.status === 403) {
            return errorResponse({
              status: 403,
              code: "FORBIDDEN",
              message: "Onvoldoende rechten om recommendations te laden.",
              correlationId,
            });
          }
        }
        marketUsed = "from_token";
        omitMarketParam = true;
        logEvent({
          level: "warn",
          event: "recommendations_market_resolution_fallback",
          correlationId,
          route: "/api/spotify/recommendations",
          method: "POST",
          appUserId,
          data: {
            reason: error instanceof SpotifyFetchError ? error.code : "UNKNOWN",
          },
        });
      }
    }

    const tuningHash = createHash(stableStringify(tuningValidation.params)).slice(0, 24);
    const sortedSeeds = [...seedTrackIds].sort().join(",");
    const cacheKey = `rec:v1:u=${appUserId}:seeds=${sortedSeeds}:market=${marketUsed}:limit=${limit}:tuning=${tuningHash}:nonce=${seedNonce ?? ""}:sel=${selectionHash.slice(0, 16)}`;
    const staleCacheKey = `rec:stale:v1:u=${appUserId}:sel=${selectionHash.slice(0, 24)}:market=${marketUsed}:limit=${limit}:tuning=${tuningHash}`;
    const cached = getCachedValue<RecommendationsSuccessResponse>(cacheKey);
    if (cached) {
      const payload: RecommendationsSuccessResponse = {
        ...cached,
        meta: {
          ...cached.meta,
          correlationId,
          cache: {
            hit: true,
            ttlSeconds: Math.floor(CACHE_TTL_MS / 1000),
          },
        },
      };
      incCounter("recommendations_requests_total", { status: "cache_hit" });
      observeHistogram("recommendations_latency_ms", Date.now() - started, {
        status: "cache_hit",
      });
      return jsonNoStore(payload, 200, {
        "x-correlation-id": correlationId,
        "x-recommendations-cache": "hit",
      });
    }

    const payload = await coalesceInflight<RecommendationsSuccessResponse>(
      `inflight:${cacheKey}`,
      1_500,
      async () => {
        const params = new URLSearchParams();
        params.set("seed_tracks", seedTrackIds.join(","));
        params.set("limit", String(limit));
        if (!omitMarketParam && marketUsed !== "from_token") {
          params.set("market", marketUsed);
        }
        for (const [key, value] of Object.entries(tuningValidation.params)) {
          params.set(key, String(value));
        }
        const url = `https://api.spotify.com/v1/recommendations?${params.toString()}`;

        const spotifyResponse = await spotifyFetch<{
          seeds?: unknown[];
          tracks?: unknown[];
        }>({
          url,
          userLevel: true,
          correlationId,
          priority: "default",
          cacheTtlMs: 0,
          dedupeWindowMs: 300,
          bypassCache: true,
        });

        const mapped: RecommendationsSuccessResponse = {
          seedTrackIds,
          spotify: {
            seeds: mapSpotifyRecommendationSeeds(spotifyResponse?.seeds),
          },
          items: mapSpotifyRecommendationItems(spotifyResponse?.tracks),
          meta: {
            correlationId,
            cache: {
              hit: false,
              ttlSeconds: Math.floor(CACHE_TTL_MS / 1000),
            },
            limiter: {
              queued: false,
              queueWaitMs: 0,
            },
            marketUsed,
          },
        };

        setCachedValue(cacheKey, mapped, CACHE_TTL_MS);
        setCachedValue(staleCacheKey, mapped, STALE_CACHE_TTL_MS);
        return mapped;
      }
    );

    incCounter("recommendations_requests_total", {
      status: payload.items.length ? "success" : "empty",
    });
    observeHistogram("recommendations_latency_ms", Date.now() - started, {
      status: payload.items.length ? "success" : "empty",
    });

    logEvent({
      level: "info",
      event: "recommendations_request_succeeded",
      correlationId,
      route: "/api/spotify/recommendations",
      method: "POST",
      appUserId,
      data: {
        selectedCount: normalizedIds.length,
        seedCount: seedTrackIds.length,
        itemCount: payload.items.length,
        marketUsed,
      },
    });

    return jsonNoStore(payload, 200, {
      "x-correlation-id": correlationId,
      "x-recommendations-cache": "miss",
    });
  } catch (error) {
    incCounter("recommendations_requests_total", { status: "error" });
    observeHistogram("recommendations_latency_ms", Date.now() - started, {
      status: "error",
    });

    if (error instanceof SpotifyFetchError) {
      const mapped = mapSpotifyError(error, correlationId);
      if (mapped.code === "SPOTIFY_UNAVAILABLE" || mapped.code === "RATE_LIMITED") {
        const stale = getCachedValue<RecommendationsSuccessResponse>(staleCacheKey);
        if (stale) {
          const fallbackPayload: RecommendationsSuccessResponse = {
            ...stale,
            meta: {
              ...stale.meta,
              correlationId,
              cache: {
                hit: true,
                ttlSeconds: Math.floor(STALE_CACHE_TTL_MS / 1000),
              },
            },
          };
          logEvent({
            level: "warn",
            event: "recommendations_stale_fallback_served",
            correlationId,
            route: "/api/spotify/recommendations",
            method: "POST",
            appUserId,
            data: {
              reason: mapped.code,
              seedCount: seedTrackIds.length,
              itemCount: fallbackPayload.items.length,
            },
          });
          return jsonNoStore(fallbackPayload, 200, {
            "x-correlation-id": correlationId,
            "x-recommendations-cache": "stale",
          });
        }
      }

      logEvent({
        level: mapped.status >= 500 ? "error" : "warn",
        event: "recommendations_request_failed",
        correlationId,
        route: "/api/spotify/recommendations",
        method: "POST",
        appUserId,
        errorCode: mapped.code,
        errorMessage: mapped.message,
        data: {
          status: mapped.status,
          spotifyCode: error.code,
          spotifyMessage: String(error.body || "").slice(0, 200),
          retryAfterMs: mapped.retryAfterMs ?? null,
        },
      });
      return errorResponse({
        status: mapped.status,
        code: mapped.code,
        message: mapped.message,
        correlationId,
        retryAfterMs: mapped.retryAfterMs,
        retryAfterHeader: mapped.retryAfterHeader,
        details: mapped.details,
      });
    }

    logEvent({
      level: "error",
      event: "recommendations_request_failed",
      correlationId,
      route: "/api/spotify/recommendations",
      method: "POST",
      appUserId,
      errorCode: "UNEXPECTED_ERROR",
      errorMessage: String(error),
    });

    return errorResponse({
      status: 500,
      code: "UNEXPECTED_ERROR",
      message: "Onverwachte fout bij laden van recommendations.",
      correlationId,
    });
  }
}
