import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { getDb } from "@/lib/db/client";
import { tracks, playlistItems, syncState } from "@/lib/db/schema";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { decodeCursor, encodeCursor } from "@/lib/spotify/cursor";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await getServerSession(getAuthOptions());
  if (!session?.appUserId) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? "50"), 50);
  const cursor = searchParams.get("cursor");

  const db = getDb();
  const whereClause = cursor
    ? (() => {
        const decoded = decodeCursor(cursor);
        return or(
          lt(playlistItems.position, decoded.addedAt),
          and(
            eq(playlistItems.position, decoded.addedAt),
            lt(playlistItems.itemId, decoded.id)
          )
        );
      })()
    : undefined;

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
