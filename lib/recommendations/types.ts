export type RecommendationTuningInput = Record<string, number>;

export type RecommendationsRequestBody = {
  selectedTrackIds: string[];
  seedCountMax?: number;
  seedNonce?: string;
  limit?: number;
  market?: "from_token" | string;
  tuning?: RecommendationTuningInput;
};

export type RecommendationSeedDebug = {
  id: string;
  type: "track";
  href: string | null;
  initialPoolSize: number;
  afterFilteringSize: number;
  afterRelinkingSize: number;
};

export type RecommendationArtist = {
  id: string;
  name: string;
};

export type RecommendationAlbumImage = {
  url: string;
  width: number | null;
  height: number | null;
};

export type RecommendationAlbum = {
  id: string | null;
  name: string | null;
  images: RecommendationAlbumImage[];
};

export type RecommendationItem = {
  id: string;
  uri: string;
  name: string;
  durationMs: number | null;
  explicit: boolean;
  previewUrl: string | null;
  popularity: number | null;
  artists: RecommendationArtist[];
  album: RecommendationAlbum;
};

export type RecommendationsSuccessResponse = {
  seedTrackIds: string[];
  spotify: {
    seeds: RecommendationSeedDebug[];
  };
  items: RecommendationItem[];
  meta: {
    correlationId: string;
    cache: {
      hit: boolean;
      ttlSeconds: number;
    };
    limiter: {
      queued: boolean;
      queueWaitMs: number;
    };
    marketUsed: string;
  };
};

export type RecommendationsErrorCode =
  | "FEATURE_DISABLED"
  | "INVALID_BODY"
  | "INVALID_SELECTED_TRACK_IDS"
  | "INVALID_SEED_COUNT_MAX"
  | "INVALID_SEED_NONCE"
  | "INVALID_LIMIT"
  | "INVALID_MARKET"
  | "MARKET_REQUIRED"
  | "INVALID_TUNING"
  | "NO_VALID_SEEDS"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "QUEUE_TIMEOUT"
  | "SPOTIFY_UNAVAILABLE"
  | "UNEXPECTED_ERROR";

export type RecommendationsErrorResponse = {
  error: {
    code: RecommendationsErrorCode;
    message: string;
    correlationId: string;
    retryAfterMs?: number;
    details?: Record<string, unknown>;
  };
};
