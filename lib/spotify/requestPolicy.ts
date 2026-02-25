export type SpotifyRequestPriority = "ui_critical" | "interactive" | "background";
export type SpotifyRequestClass = "read" | "write";

export type SpotifyRequestPolicy = {
  priority: SpotifyRequestPriority;
  requestClass: SpotifyRequestClass;
  cacheTtlMs: number;
  staleWhileRevalidateMs: number;
  maxAttempts: number;
  circuitBreakerProtected: boolean;
};

const DEFAULT_READ_POLICY: SpotifyRequestPolicy = {
  priority: "interactive",
  requestClass: "read",
  cacheTtlMs: 0,
  staleWhileRevalidateMs: 0,
  maxAttempts: 2,
  circuitBreakerProtected: true,
};

const DEFAULT_WRITE_POLICY: SpotifyRequestPolicy = {
  priority: "ui_critical",
  requestClass: "write",
  cacheTtlMs: 0,
  staleWhileRevalidateMs: 0,
  maxAttempts: 2,
  circuitBreakerProtected: true,
};

function isPlaybackEndpoint(group: string) {
  return group === "me_player" || group === "me_player_devices";
}

function isRecommendationsEndpoint(group: string) {
  return group === "v1_recommendations";
}

function isLibraryEndpoint(group: string) {
  return group === "me_playlists" || group === "me_tracks";
}

export function resolveSpotifyRequestPolicy(args: {
  method: string;
  endpointGroup: string;
}): SpotifyRequestPolicy {
  const method = args.method.toUpperCase();
  const group = args.endpointGroup;
  const isRead = method === "GET" || method === "HEAD";
  if (!isRead) {
    if (isPlaybackEndpoint(group)) {
      return {
        ...DEFAULT_WRITE_POLICY,
        maxAttempts: 1,
      };
    }
    return DEFAULT_WRITE_POLICY;
  }

  if (isPlaybackEndpoint(group)) {
    return {
      priority: "ui_critical",
      requestClass: "read",
      cacheTtlMs: 400,
      staleWhileRevalidateMs: 1200,
      maxAttempts: 1,
      circuitBreakerProtected: true,
    };
  }

  if (isRecommendationsEndpoint(group)) {
    return {
      priority: "interactive",
      requestClass: "read",
      cacheTtlMs: 3_000,
      staleWhileRevalidateMs: 8_000,
      maxAttempts: 1,
      circuitBreakerProtected: true,
    };
  }

  if (isLibraryEndpoint(group)) {
    return {
      priority: "interactive",
      requestClass: "read",
      cacheTtlMs: 2_500,
      staleWhileRevalidateMs: 10_000,
      maxAttempts: 2,
      circuitBreakerProtected: true,
    };
  }

  return DEFAULT_READ_POLICY;
}

