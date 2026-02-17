import { getDb } from "@/lib/db/client";
import { tracks, playlistItems, syncState, userPlaylists } from "@/lib/db/schema";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { encodeCursor, tryDecodeCursor } from "@/lib/spotify/cursor";
import {
  jsonError,
  rateLimitResponse,
  requireAppUser,
  jsonPrivateCache,
} from "@/lib/api/guards";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { session, response } = await requireAppUser();
  if (response) return response;
  const rl = await rateLimitResponse({
    key: `library:${session.appUserId}`,
    limit: 600,
    windowMs: 60_000,
  });
  if (rl) return rl;

  const { searchParams } = new URL(req.url);
  const limitValue = Number(searchParams.get("limit") ?? "50");
  const limit =
    Number.isFinite(limitValue) && limitValue > 0
      ? Math.min(Math.floor(limitValue), 50)
      : 50;
  const cursor = searchParams.get("cursor");

  const db = getDb();
  const baseWhere = eq(userPlaylists.userId, session.appUserId as string);
  let whereClause = baseWhere;

  if (cursor) {
    const decoded = tryDecodeCursor(cursor);
    if (!decoded) {
      return jsonError("INVALID_CURSOR", 400);
    }
    const cursorWhere = and(
      baseWhere,
      or(
        lt(playlistItems.position, decoded.addedAt),
        and(
          eq(playlistItems.position, decoded.addedAt),
          lt(playlistItems.itemId, decoded.id)
        )
      )
    );
    if (!cursorWhere) {
      return jsonError("INVALID_CURSOR", 400);
    }
    whereClause = cursorWhere;
  }

  const rows = await db
    .select({
      itemId: playlistItems.itemId,
      playlistId: playlistItems.playlistId,
      trackId: tracks.trackId,
      name: tracks.name,
      addedAt: playlistItems.addedAt,
      position: playlistItems.position,
    })
    .from(playlistItems)
    .innerJoin(
      userPlaylists,
      eq(userPlaylists.playlistId, playlistItems.playlistId)
    )
    .leftJoin(tracks, eq(tracks.trackId, playlistItems.trackId))
    .where(whereClause)
    .orderBy(desc(playlistItems.position), desc(playlistItems.itemId))
    .limit(limit);

  const last = rows[rows.length - 1];
  const nextCursor = last
    ? encodeCursor(last.position ?? 0, last.itemId)
    : null;

  const sync = await db
    .select()
    .from(syncState)
    .where(eq(syncState.userId, session.appUserId as string));

  return jsonPrivateCache({
    items: rows,
    nextCursor,
    asOf: Date.now(),
    sync,
  });
}
