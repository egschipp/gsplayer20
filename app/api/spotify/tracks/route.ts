import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { getDb } from "@/lib/db/client";
import {
  tracks,
  userSavedTracks,
  playlistItems,
  userPlaylists,
} from "@/lib/db/schema";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { decodeCursor, encodeCursor } from "@/lib/spotify/cursor";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await getServerSession(getAuthOptions());
  if (!session?.appUserId) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? "50"), 100);
  const cursor = searchParams.get("cursor");

  const db = getDb();
  const baseWhere = cursor
    ? (() => {
        const decoded = decodeCursor(cursor);
        return lt(tracks.trackId, decoded.id);
      })()
    : undefined;

  const userWhere = or(
    eq(userSavedTracks.userId, session.appUserId as string),
    eq(userPlaylists.userId, session.appUserId as string)
  );

  const rows = await db
    .select({
      trackId: tracks.trackId,
      name: tracks.name,
      albumName: tracks.albumName,
      albumImageUrl: tracks.albumImageUrl,
      hasCover: sql<number>`(${tracks.albumImageBlob} IS NOT NULL)`,
    })
    .from(tracks)
    .leftJoin(
      userSavedTracks,
      and(
        eq(userSavedTracks.trackId, tracks.trackId),
        eq(userSavedTracks.userId, session.appUserId as string)
      )
    )
    .leftJoin(playlistItems, eq(playlistItems.trackId, tracks.trackId))
    .leftJoin(
      userPlaylists,
      and(
        eq(userPlaylists.playlistId, playlistItems.playlistId),
        eq(userPlaylists.userId, session.appUserId as string)
      )
    )
    .where(baseWhere ? and(baseWhere, userWhere) : userWhere)
    .groupBy(tracks.trackId)
    .orderBy(desc(tracks.trackId))
    .limit(limit);

  const last = rows[rows.length - 1];
  const nextCursor = last ? encodeCursor(0, last.trackId) : null;

  return NextResponse.json({
    items: rows.map((row) => ({
      ...row,
      coverUrl: row.hasCover ? `/api/spotify/cover/${row.trackId}` : row.albumImageUrl,
    })),
    nextCursor,
    asOf: Date.now(),
  });
}
