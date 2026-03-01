import { jsonError, jsonNoStore, rateLimitResponse, requireAppUser, requireSameOrigin } from "@/lib/api/guards";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { spotifyFetch } from "@/lib/spotify/client";
import { getDb } from "@/lib/db/client";
import { userSavedTracks } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { updateUserSavedTrackSeen, upsertTrack } from "@/lib/db/queries";

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
  try {
    const url = new URL(raw);
    const match = url.pathname.match(/\/track\/([A-Za-z0-9]{22})/);
    if (match?.[1]) return match[1];
  } catch {
    // ignore
  }
  return null;
}

async function getLikedState(trackId: string) {
  const data = await spotifyFetch<boolean[]>({
    url: `https://api.spotify.com/v1/me/tracks/contains?ids=${encodeURIComponent(trackId)}`,
    userLevel: true,
  });
  return Array.isArray(data) ? Boolean(data[0]) : false;
}

function mapSpotifyError(error: unknown) {
  if (error instanceof SpotifyFetchError) {
    if (error.status === 401) return { status: 401, code: "SPOTIFY_AUTH" };
    if (error.status === 403) return { status: 403, code: "SPOTIFY_SCOPE_OR_PREMIUM" };
    if (error.status === 429) return { status: 429, code: "SPOTIFY_RATE_LIMIT" };
    return { status: 502, code: `SPOTIFY_${error.status}` };
  }
  const message = String(error);
  if (message.includes("UserNotAuthenticated")) {
    return { status: 401, code: "UNAUTHENTICATED" };
  }
  return { status: 502, code: "SPOTIFY_UPSTREAM" };
}

function createMutationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `mut_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function GET(req: Request) {
  const { session, response } = await requireAppUser();
  if (response) return response;

  const rl = await rateLimitResponse({
    key: `liked:contains:${session.appUserId}`,
    limit: 300,
    windowMs: 60_000,
  });
  if (rl) return rl;

  const { searchParams } = new URL(req.url);
  const trackId = normalizeTrackId(searchParams.get("trackId"));
  if (!trackId) return jsonError("INVALID_TRACK_ID", 400);

  try {
    const liked = await getLikedState(trackId);
    return jsonNoStore({ trackId, liked });
  } catch (error) {
    const mapped = mapSpotifyError(error);
    return jsonError(mapped.code, mapped.status);
  }
}

export async function POST(req: Request) {
  const originCheck = requireSameOrigin(req);
  if (originCheck) return originCheck;

  const { session, response } = await requireAppUser();
  if (response) return response;

  const rl = await rateLimitResponse({
    key: `liked:save:${session.appUserId}`,
    limit: 120,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rl) return rl;

  const body = await req.json().catch(() => ({}));
  const trackId = normalizeTrackId(body?.trackId);
  if (!trackId) return jsonError("INVALID_TRACK_ID", 400);

  try {
    await spotifyFetch({
      url: `https://api.spotify.com/v1/me/tracks?ids=${encodeURIComponent(trackId)}`,
      method: "PUT",
      userLevel: true,
    });
    try {
      const track = await spotifyFetch<{
        id?: string;
        name?: string;
        duration_ms?: number;
        explicit?: boolean;
        is_local?: boolean;
        linked_from?: { id?: string | null };
        restrictions?: { reason?: string | null };
        popularity?: number;
        album?: { id?: string | null };
      }>({
        url: `https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`,
        userLevel: true,
        priority: "default",
        cacheTtlMs: 20_000,
        dedupeWindowMs: 2_000,
      });
      if (track?.id) {
        await upsertTrack({
          trackId: track.id,
          name: track.name ?? "Onbekend nummer",
          durationMs:
            typeof track.duration_ms === "number" ? Math.max(0, track.duration_ms) : 0,
          explicit: Boolean(track.explicit),
          isLocal:
            typeof track.is_local === "boolean" ? track.is_local : null,
          linkedFromTrackId:
            typeof track.linked_from?.id === "string" ? track.linked_from.id : null,
          restrictionsReason:
            typeof track.restrictions?.reason === "string"
              ? track.restrictions.reason
              : null,
          albumId: typeof track.album?.id === "string" ? track.album.id : null,
          popularity:
            typeof track.popularity === "number" ? Math.floor(track.popularity) : null,
        });
      }
      await updateUserSavedTrackSeen(session.appUserId as string, trackId);
    } catch {
      // Spotify mutation already succeeded; local DB update is best effort.
    }
    const liked = await getLikedState(trackId);
    return jsonNoStore({
      trackId,
      liked,
      mutationId: createMutationId(),
      localSync: "best_effort",
      mutatedAt: Date.now(),
    });
  } catch (error) {
    const mapped = mapSpotifyError(error);
    return jsonError(mapped.code, mapped.status);
  }
}

export async function DELETE(req: Request) {
  const originCheck = requireSameOrigin(req);
  if (originCheck) return originCheck;

  const { session, response } = await requireAppUser();
  if (response) return response;

  const rl = await rateLimitResponse({
    key: `liked:remove:${session.appUserId}`,
    limit: 120,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rl) return rl;

  const body = await req.json().catch(() => ({}));
  const trackId = normalizeTrackId(body?.trackId);
  if (!trackId) return jsonError("INVALID_TRACK_ID", 400);

  try {
    await spotifyFetch({
      url: `https://api.spotify.com/v1/me/tracks?ids=${encodeURIComponent(trackId)}`,
      method: "DELETE",
      userLevel: true,
    });
    try {
      const db = getDb();
      await db
        .delete(userSavedTracks)
        .where(
          and(
            eq(userSavedTracks.userId, session.appUserId as string),
            eq(userSavedTracks.trackId, trackId)
          )
        );
    } catch {
      // Spotify mutation already succeeded; local DB update is best effort.
    }
    const liked = await getLikedState(trackId);
    return jsonNoStore({
      trackId,
      liked,
      mutationId: createMutationId(),
      localSync: "best_effort",
      mutatedAt: Date.now(),
    });
  } catch (error) {
    const mapped = mapSpotifyError(error);
    return jsonError(mapped.code, mapped.status);
  }
}
