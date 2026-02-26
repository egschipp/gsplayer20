import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { playlistItems, userPlaylists, userSavedTracks } from "@/lib/db/schema";
import { jsonError, jsonNoStore, rateLimitResponse, requireAppUser } from "@/lib/api/guards";

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
    // ignore parse issues
  }
  return null;
}

export async function GET(req: Request) {
  const { session, response } = await requireAppUser();
  if (response) return response;

  const rl = await rateLimitResponse({
    key: `track-playlists:${session.appUserId}`,
    limit: 360,
    windowMs: 60_000,
  });
  if (rl) return rl;

  const { searchParams } = new URL(req.url);
  const trackId = normalizeTrackId(searchParams.get("trackId"));
  if (!trackId) return jsonError("INVALID_TRACK_ID", 400);

  const db = getDb();

  const [playlistRows, savedRows] = await Promise.all([
    db
      .select({ playlistId: playlistItems.playlistId })
      .from(playlistItems)
      .innerJoin(
        userPlaylists,
        and(
          eq(userPlaylists.playlistId, playlistItems.playlistId),
          eq(userPlaylists.userId, session.appUserId as string)
        )
      )
      .where(eq(playlistItems.trackId, trackId))
      .groupBy(playlistItems.playlistId),
    db
      .select({ trackId: userSavedTracks.trackId })
      .from(userSavedTracks)
      .where(
        and(
          eq(userSavedTracks.userId, session.appUserId as string),
          eq(userSavedTracks.trackId, trackId)
        )
      )
      .limit(1),
  ]);

  const playlistIds = playlistRows
    .map((row) => String(row.playlistId ?? "").trim())
    .filter(Boolean);
  const liked = savedRows.length > 0;

  return jsonNoStore({
    trackId,
    playlistIds,
    liked,
    asOf: Date.now(),
  });
}

