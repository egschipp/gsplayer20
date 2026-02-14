import { jsonError, jsonNoStore, rateLimitResponse, requireAppUser, requireSameOrigin } from "@/lib/api/guards";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { spotifyFetch } from "@/lib/spotify/client";

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
    const liked = await getLikedState(trackId);
    return jsonNoStore({ trackId, liked });
  } catch (error) {
    const mapped = mapSpotifyError(error);
    return jsonError(mapped.code, mapped.status);
  }
}
