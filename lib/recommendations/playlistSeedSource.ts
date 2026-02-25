import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { playlistItems, playlists, tracks, userPlaylists } from "@/lib/db/schema";
import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { RecommendationsServiceError } from "@/lib/recommendations/types";
import {
  normalizeTrackId,
  type PlaylistSeedCandidate,
} from "@/lib/recommendations/seedSelector";

const DEFAULT_MAX_DB_CANDIDATES = 1200;
const DEFAULT_MAX_LIVE_CANDIDATES = 250;
const LIVE_PAGE_LIMIT = 100;
const LIVE_MAX_PAGES = 4;
const FETCH_TIMEOUT_MS = Number(process.env.SPOTIFY_RECOMMENDATIONS_UPSTREAM_TIMEOUT_MS || "8000");
const FETCH_MAX_ATTEMPTS = Number(
  process.env.SPOTIFY_RECOMMENDATIONS_UPSTREAM_MAX_ATTEMPTS || "2"
);

export type PlaylistSeedSourceResult = {
  playlistId: string;
  snapshotId: string | null;
  totalCount: number | null;
  candidates: PlaylistSeedCandidate[];
  source: "db" | "live";
};

function clampInt(value: number, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

const SAFE_FETCH_TIMEOUT_MS = clampInt(FETCH_TIMEOUT_MS, 8_000, 2_000, 20_000);
const SAFE_FETCH_MAX_ATTEMPTS = clampInt(FETCH_MAX_ATTEMPTS, 2, 1, 3);

function parseSpotifyScopeError(body: string) {
  const raw = String(body || "").toLowerCase();
  return raw.includes("insufficient client scope") || raw.includes("scope");
}

async function ensurePlaylistAccess(args: { userId: string; playlistId: string }) {
  const db = getDb();
  const row = await db
    .select({
      playlistId: userPlaylists.playlistId,
      snapshotId: playlists.snapshotId,
      tracksTotal: playlists.tracksTotal,
    })
    .from(userPlaylists)
    .leftJoin(playlists, eq(playlists.playlistId, userPlaylists.playlistId))
    .where(
      and(eq(userPlaylists.userId, args.userId), eq(userPlaylists.playlistId, args.playlistId))
    )
    .get();

  if (!row?.playlistId) {
    throw new RecommendationsServiceError({
      status: 404,
      code: "PLAYLIST_NOT_FOUND",
      message: "De geselecteerde playlist is niet beschikbaar.",
    });
  }

  const tracksTotal =
    typeof row.tracksTotal === "number" && Number.isFinite(row.tracksTotal)
      ? Math.max(0, Math.floor(row.tracksTotal))
      : null;
  return {
    snapshotId: row.snapshotId ?? null,
    tracksTotal,
  };
}

async function loadDbCandidates(args: {
  userId: string;
  playlistId: string;
  maxCandidates: number;
}) {
  const db = getDb();
  const rows = await db
    .select({
      itemId: playlistItems.itemId,
      position: playlistItems.position,
      itemTrackId: playlistItems.trackId,
      trackId: tracks.trackId,
      linkedFromTrackId: tracks.linkedFromTrackId,
      isLocal: tracks.isLocal,
      restrictionsReason: tracks.restrictionsReason,
    })
    .from(playlistItems)
    .innerJoin(
      userPlaylists,
      and(
        eq(userPlaylists.playlistId, playlistItems.playlistId),
        eq(userPlaylists.userId, args.userId)
      )
    )
    .leftJoin(tracks, eq(tracks.trackId, playlistItems.trackId))
    .where(eq(playlistItems.playlistId, args.playlistId))
    .orderBy(asc(playlistItems.position), asc(playlistItems.itemId))
    .limit(args.maxCandidates);

  return rows.map((row) => ({
    itemId: row.itemId ?? null,
    position:
      typeof row.position === "number" && Number.isFinite(row.position)
        ? Math.floor(row.position)
        : null,
    trackId: normalizeTrackId(row.trackId ?? null) ?? normalizeTrackId(row.itemTrackId ?? null),
    linkedFromTrackId: normalizeTrackId(row.linkedFromTrackId ?? null),
    trackType: null,
    isLocal:
      typeof row.isLocal === "number" && Number.isFinite(row.isLocal) ? Math.floor(row.isLocal) : null,
    restrictionsReason:
      typeof row.restrictionsReason === "string" ? row.restrictionsReason : null,
  }));
}

async function loadLiveCandidates(args: {
  playlistId: string;
  maxCandidates: number;
  snapshotId: string | null;
  totalCount: number | null;
}) {
  let offset = 0;
  let next = true;
  let page = 0;
  const candidates: PlaylistSeedCandidate[] = [];
  let snapshotId = args.snapshotId;
  let totalCount = args.totalCount;

  if (!snapshotId || totalCount === null) {
    try {
      const playlistMeta = await spotifyFetch<{
        snapshot_id?: string | null;
        tracks?: { total?: number | null };
      }>({
        url: `https://api.spotify.com/v1/playlists/${encodeURIComponent(
          args.playlistId
        )}?fields=snapshot_id,tracks(total)`,
        userLevel: true,
        timeoutMs: SAFE_FETCH_TIMEOUT_MS,
        maxAttempts: SAFE_FETCH_MAX_ATTEMPTS,
      });
      snapshotId = playlistMeta?.snapshot_id ?? snapshotId ?? null;
      if (totalCount === null) {
        totalCount =
          typeof playlistMeta?.tracks?.total === "number" &&
          Number.isFinite(playlistMeta.tracks.total)
            ? Math.max(0, Math.floor(playlistMeta.tracks.total))
            : null;
      }
    } catch {
      // metadata best-effort
    }
  }

  while (next && page < LIVE_MAX_PAGES && candidates.length < args.maxCandidates) {
    const remaining = args.maxCandidates - candidates.length;
    const limit = Math.max(1, Math.min(LIVE_PAGE_LIMIT, remaining));
    const fields =
      "items(added_at,track(type,id,is_local,linked_from(id),restrictions(reason))),next,total";
    const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(
      args.playlistId
    )}/tracks?limit=${limit}&offset=${offset}&fields=${encodeURIComponent(fields)}`;

    const data = await spotifyFetch<{
      items?: Array<{
        track?: {
          type?: string | null;
          id?: string | null;
          is_local?: boolean | null;
          linked_from?: { id?: string | null } | null;
          restrictions?: { reason?: string | null } | null;
        } | null;
      } | null>;
      next?: string | null;
      total?: number;
    }>({
      url,
      userLevel: true,
      timeoutMs: SAFE_FETCH_TIMEOUT_MS,
      maxAttempts: SAFE_FETCH_MAX_ATTEMPTS,
    });

    const items = Array.isArray(data?.items) ? data.items : [];
    if (totalCount === null && typeof data?.total === "number" && Number.isFinite(data.total)) {
      totalCount = Math.max(0, Math.floor(data.total));
    }
    for (let index = 0; index < items.length; index += 1) {
      const track = items[index]?.track;
      candidates.push({
        itemId: `${args.playlistId}:${offset + index}`,
        position: offset + index,
        trackId: normalizeTrackId(track?.id ?? null),
        linkedFromTrackId: normalizeTrackId(track?.linked_from?.id ?? null),
        trackType: typeof track?.type === "string" ? track.type : null,
        isLocal: typeof track?.is_local === "boolean" ? (track.is_local ? 1 : 0) : null,
        restrictionsReason:
          typeof track?.restrictions?.reason === "string" ? track.restrictions.reason : null,
      });
      if (candidates.length >= args.maxCandidates) break;
    }

    offset += items.length;
    next = Boolean(data?.next) && items.length > 0;
    page += 1;
    if (items.length === 0) break;
  }

  return {
    candidates,
    snapshotId: snapshotId ?? null,
    totalCount,
  };
}

function countEligibleCandidates(candidates: PlaylistSeedCandidate[]) {
  let count = 0;
  for (const candidate of candidates) {
    if (
      typeof candidate.trackType === "string" &&
      candidate.trackType.trim().length > 0 &&
      candidate.trackType !== "track"
    ) {
      continue;
    }
    const trackId = normalizeTrackId(candidate.linkedFromTrackId) ?? normalizeTrackId(candidate.trackId);
    if (!trackId) continue;
    if (candidate.isLocal === 1) continue;
    if (
      typeof candidate.restrictionsReason === "string" &&
      candidate.restrictionsReason.trim().length > 0
    ) {
      continue;
    }
    count += 1;
  }
  return count;
}

export async function getPlaylistSeedSource(args: {
  userId: string;
  playlistId: string;
  maxDbCandidates?: number;
  maxLiveCandidates?: number;
}) {
  const maxDbCandidates = clampInt(args.maxDbCandidates ?? DEFAULT_MAX_DB_CANDIDATES, 1200, 100, 3000);
  const maxLiveCandidates = clampInt(
    args.maxLiveCandidates ?? DEFAULT_MAX_LIVE_CANDIDATES,
    250,
    50,
    500
  );
  const access = await ensurePlaylistAccess({
    userId: args.userId,
    playlistId: args.playlistId,
  });

  const dbCandidates = await loadDbCandidates({
    userId: args.userId,
    playlistId: args.playlistId,
    maxCandidates: maxDbCandidates,
  });
  const dbEligible = countEligibleCandidates(dbCandidates);
  if (dbEligible > 0) {
    const result: PlaylistSeedSourceResult = {
      playlistId: args.playlistId,
      snapshotId: access.snapshotId,
      totalCount: access.tracksTotal,
      candidates: dbCandidates,
      source: "db",
    };
    return result;
  }

  try {
    const live = await loadLiveCandidates({
      playlistId: args.playlistId,
      maxCandidates: maxLiveCandidates,
      snapshotId: access.snapshotId,
      totalCount: access.tracksTotal,
    });
    const liveEligible = countEligibleCandidates(live.candidates);
    if (liveEligible <= 0) {
      return {
        playlistId: args.playlistId,
        snapshotId: live.snapshotId,
        totalCount: live.totalCount,
        candidates: [],
        source: "live",
      };
    }
    return {
      playlistId: args.playlistId,
      snapshotId: live.snapshotId,
      totalCount: live.totalCount,
      candidates: live.candidates,
      source: "live",
    };
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
      if (error.status === 403) {
        const scopeMissing = parseSpotifyScopeError(error.body);
        throw new RecommendationsServiceError({
          status: 403,
          code: scopeMissing ? "FORBIDDEN" : "FORBIDDEN",
          message: scopeMissing
            ? "Spotify scope ontbreekt om playlist recommendations op te halen."
            : "Geen toegang tot deze playlist.",
          correlationId: error.correlationId,
        });
      }
      if (error.status === 404) {
        throw new RecommendationsServiceError({
          status: 404,
          code: "PLAYLIST_NOT_FOUND",
          message: "De geselecteerde playlist bestaat niet of is niet beschikbaar.",
          correlationId: error.correlationId,
        });
      }
      if (error.status === 429) {
        const retryAfterSec =
          error.retryAfterMs && error.retryAfterMs > 0
            ? Math.max(1, Math.ceil(error.retryAfterMs / 1000))
            : null;
        throw new RecommendationsServiceError({
          status: 429,
          code: "RATE_LIMIT",
          message: "Spotify rate limit actief.",
          retryAfterSec,
          correlationId: error.correlationId,
        });
      }
      throw new RecommendationsServiceError({
        status: 502,
        code: "SPOTIFY_UPSTREAM",
        message: "Spotify is tijdelijk niet bereikbaar.",
        correlationId: error.correlationId,
      });
    }
    if (String(error).includes("UserNotAuthenticated")) {
      throw new RecommendationsServiceError({
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Je bent nog niet verbonden met Spotify.",
      });
    }
    throw error;
  }
}
