import { getDb } from "@/lib/db/client";
import {
  artists,
  trackArtists,
  userSavedTracks,
  playlistItems,
  userPlaylists,
} from "@/lib/db/schema";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { decodeCursor, encodeCursor } from "@/lib/spotify/cursor";
import { requireAppUser, jsonNoStore } from "@/lib/api/guards";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { session, response } = await requireAppUser();
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? "50"), 50);
  const cursor = searchParams.get("cursor");

  const db = getDb();
  const baseWhere = cursor
    ? (() => {
        const decoded = decodeCursor(cursor);
        return lt(artists.artistId, decoded.id);
      })()
    : undefined;

  const userWhere = or(
    eq(userSavedTracks.userId, session.appUserId as string),
    eq(userPlaylists.userId, session.appUserId as string)
  );

  const rows = await db
    .select({
      artistId: artists.artistId,
      name: artists.name,
      genres: artists.genres,
      popularity: artists.popularity,
    })
    .from(artists)
    .leftJoin(trackArtists, eq(trackArtists.artistId, artists.artistId))
    .leftJoin(
      userSavedTracks,
      and(
        eq(userSavedTracks.trackId, trackArtists.trackId),
        eq(userSavedTracks.userId, session.appUserId as string)
      )
    )
    .leftJoin(playlistItems, eq(playlistItems.trackId, trackArtists.trackId))
    .leftJoin(
      userPlaylists,
      and(
        eq(userPlaylists.playlistId, playlistItems.playlistId),
        eq(userPlaylists.userId, session.appUserId as string)
      )
    )
    .where(baseWhere ? and(baseWhere, userWhere) : userWhere)
    .groupBy(artists.artistId)
    .orderBy(desc(artists.artistId))
    .limit(limit);

  const last = rows[rows.length - 1];
  const nextCursor = last ? encodeCursor(0, last.artistId) : null;

  return jsonNoStore({ items: rows, nextCursor, asOf: Date.now() });
}
