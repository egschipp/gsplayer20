export type RecommendationItem = {
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

export type RecommendationsSeedDiagnostics = {
  seedSource: "db" | "live";
  candidateTrackCount: number;
  validatedTrackCount: number;
  seedTrackPoolCount: number;
  preferredSeedTrackCount: number;
  seedArtistPoolCount: number;
  attemptsPlanned: number;
  attemptsUsed: number;
  fallbackUsed: "none" | "artist_top_tracks";
};

export type PlaylistRecommendationsPayload = {
  items: RecommendationItem[];
  totalCount: number;
  asOf: number;
  reason?: "no_results" | "seed_rejected" | "upstream_fallback";
  playlistId: string;
  snapshotId: string | null;
  seedTrackCount: number;
  seedArtistCount: number;
  diagnostics?: RecommendationsSeedDiagnostics;
  cacheState: "hit" | "miss" | "coalesced" | "stale";
};

export type RecommendationsErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "PLAYLIST_NOT_FOUND"
  | "INVALID_PLAYLIST_ID"
  | "MISSING_PLAYLIST_ID"
  | "INVALID_LIMIT"
  | "INSUFFICIENT_PLAYLIST_SEEDS"
  | "RATE_LIMIT"
  | "RECOMMENDATIONS_UNAVAILABLE"
  | "SPOTIFY_UPSTREAM"
  | "INTERNAL_ERROR";

export class RecommendationsServiceError extends Error {
  status: number;
  code: RecommendationsErrorCode;
  retryAfterSec: number | null;
  correlationId: string | null;
  upstreamStatus: number | null;
  upstreamErrorExcerpt: string | null;
  outboundHost: string | null;

  constructor(args: {
    status: number;
    code: RecommendationsErrorCode;
    message: string;
    retryAfterSec?: number | null;
    correlationId?: string | null;
    upstreamStatus?: number | null;
    upstreamErrorExcerpt?: string | null;
    outboundHost?: string | null;
  }) {
    super(args.message);
    this.name = "RecommendationsServiceError";
    this.status = args.status;
    this.code = args.code;
    this.retryAfterSec =
      typeof args.retryAfterSec === "number" && Number.isFinite(args.retryAfterSec)
        ? Math.max(1, Math.floor(args.retryAfterSec))
        : null;
    this.correlationId =
      typeof args.correlationId === "string" && args.correlationId.trim()
        ? args.correlationId
        : null;
    this.upstreamStatus =
      typeof args.upstreamStatus === "number" && Number.isFinite(args.upstreamStatus)
        ? Math.floor(args.upstreamStatus)
        : null;
    this.upstreamErrorExcerpt =
      typeof args.upstreamErrorExcerpt === "string" && args.upstreamErrorExcerpt.trim()
        ? args.upstreamErrorExcerpt.trim()
        : null;
    this.outboundHost =
      typeof args.outboundHost === "string" && args.outboundHost.trim()
        ? args.outboundHost.trim()
        : null;
  }
}
