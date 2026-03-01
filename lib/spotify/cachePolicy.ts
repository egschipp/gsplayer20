export type SpotifyResourceKey =
  | "player"
  | "devices"
  | "tracks"
  | "playlists"
  | "playlist_items"
  | "recently_played";

type SpotifyResourcePolicy = {
  cacheTtlMs: number;
  dedupeWindowMs: number;
  privateMaxAgeSec: number;
  freshnessBudgetSec: number;
};

const RESOURCE_POLICY: Record<SpotifyResourceKey, SpotifyResourcePolicy> = {
  player: {
    cacheTtlMs: 0,
    dedupeWindowMs: 200,
    privateMaxAgeSec: 0,
    freshnessBudgetSec: 2,
  },
  devices: {
    cacheTtlMs: 1_500,
    dedupeWindowMs: 300,
    privateMaxAgeSec: 0,
    freshnessBudgetSec: 5,
  },
  tracks: {
    cacheTtlMs: 6_000,
    dedupeWindowMs: 1_200,
    privateMaxAgeSec: 30,
    freshnessBudgetSec: 60,
  },
  playlists: {
    cacheTtlMs: 6_000,
    dedupeWindowMs: 1_200,
    privateMaxAgeSec: 30,
    freshnessBudgetSec: 60,
  },
  playlist_items: {
    cacheTtlMs: 8_000,
    dedupeWindowMs: 1_500,
    privateMaxAgeSec: 30,
    freshnessBudgetSec: 90,
  },
  recently_played: {
    cacheTtlMs: 10_000,
    dedupeWindowMs: 2_000,
    privateMaxAgeSec: 15,
    freshnessBudgetSec: 45,
  },
};

export function getSpotifyResourcePolicy(resource: SpotifyResourceKey) {
  return RESOURCE_POLICY[resource];
}

export function computeStaleSec(lastSuccessfulAt: number | null | undefined, now = Date.now()) {
  if (!lastSuccessfulAt || !Number.isFinite(lastSuccessfulAt)) return null;
  return Math.max(0, Math.floor((now - lastSuccessfulAt) / 1000));
}

export function buildDataSourceMeta(args: {
  resource: SpotifyResourceKey;
  source: "live" | "db";
  asOf: number;
  staleSec?: number | null;
  degraded?: boolean;
  degradeReason?: string | null;
  liveRequested?: boolean;
}) {
  const policy = getSpotifyResourcePolicy(args.resource);
  const staleSec =
    typeof args.staleSec === "number" && Number.isFinite(args.staleSec)
      ? Math.max(0, Math.floor(args.staleSec))
      : null;

  return {
    source: args.source,
    asOf: args.asOf,
    liveRequested: Boolean(args.liveRequested),
    freshnessBudgetSec: policy.freshnessBudgetSec,
    staleSec,
    degraded: Boolean(args.degraded),
    degradeReason:
      typeof args.degradeReason === "string" && args.degradeReason.trim()
        ? args.degradeReason.trim()
        : null,
  };
}
