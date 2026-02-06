import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { tracks, playlistItems, syncState, userPlaylists } from "@/lib/db/schema";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { decodeCursor, encodeCursor } from "@/lib/spotify/cursor";
import { rateLimitResponse, requireAppUser } from "@/lib/api/guards";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { session, response } = await requireAppUser();
  if (response) return response;
  const rl = rateLimitResponse({
    key: `library:${session.appUserId}`,
    limit: 600,
    windowMs: 60_000,
  });
  if (rl) return rl;

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? "50"), 50);
  const cursor = searchParams.get("cursor");

  const db = getDb();
  const whereClause = cursor
    ? (() => {
        const decoded = decodeCursor(cursor);
        return and(
          eq(userPlaylists.userId, session.appUserId as string),
          or(
            lt(playlistItems.position, decoded.addedAt),
            and(
              eq(playlistItems.position, decoded.addedAt),
              lt(playlistItems.itemId, decoded.id)
            )
          )
        );
      })()
    : eq(userPlaylists.userId, session.appUserId as string);

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

  return NextResponse.json({
    items: rows,
    nextCursor,
    asOf: Date.now(),
    sync,
  });
}
