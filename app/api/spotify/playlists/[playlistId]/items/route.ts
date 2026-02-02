import { NextResponse, type NextRequest } from "next/server";
import { rateLimit } from "@/lib/rate-limit/ratelimit";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { getDb } from "@/lib/db/client";
import {
  playlistItems,
  tracks,
  userPlaylists,
  syncState,
  trackArtists,
  artists,
} from "@/lib/db/schema";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { decodeCursor, encodeCursor } from "@/lib/spotify/cursor";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ playlistId: string }> }
) {
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  const rl = rateLimit(`playlist-items:${ip}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "RATE_LIMIT" }, { status: 429 });
  }

  const session = await getServerSession(getAuthOptions());
  if (!session?.appUserId) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { playlistId } = await ctx.params;
  if (!playlistId) {
    return NextResponse.json({ error: "MISSING_PLAYLIST" }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? "50"), 50);
  const cursor = searchParams.get("cursor");

  const db = getDb();
  const whereClause = cursor
    ? (() => {
        const decoded = decodeCursor(cursor);
        return and(
          eq(userPlaylists.userId, session.appUserId as string),
          eq(playlistItems.playlistId, playlistId),
          or(
            lt(playlistItems.position, decoded.addedAt),
            and(
              eq(playlistItems.position, decoded.addedAt),
              lt(playlistItems.itemId, decoded.id)
            )
          )
        );
      })()
    : and(
        eq(userPlaylists.userId, session.appUserId as string),
        eq(playlistItems.playlistId, playlistId)
      );

  const rows = await db
    .select({
      itemId: playlistItems.itemId,
      playlistId: playlistItems.playlistId,
      trackId: tracks.trackId,
      name: tracks.name,
      albumName: tracks.albumName,
      albumImageUrl: tracks.albumImageUrl,
      durationMs: tracks.durationMs,
      artists: sql<string | null>`group_concat(${artists.name}, ', ')`,
      addedAt: playlistItems.addedAt,
      position: playlistItems.position,
    })
    .from(playlistItems)
    .innerJoin(
      userPlaylists,
      eq(userPlaylists.playlistId, playlistItems.playlistId)
    )
    .leftJoin(tracks, eq(tracks.trackId, playlistItems.trackId))
    .leftJoin(trackArtists, eq(trackArtists.trackId, tracks.trackId))
    .leftJoin(artists, eq(artists.artistId, trackArtists.artistId))
    .where(whereClause)
    .groupBy(
      playlistItems.itemId,
      playlistItems.playlistId,
      playlistItems.addedAt,
      playlistItems.position,
      tracks.trackId
    )
    .orderBy(desc(playlistItems.position), desc(playlistItems.itemId))
    .limit(limit);

  const last = rows[rows.length - 1];
  const nextCursor = last
    ? encodeCursor(last.position ?? 0, last.itemId)
    : null;

  const sync = await db
    .select()
    .from(syncState)
    .where(
      and(
        eq(syncState.userId, session.appUserId as string),
        eq(syncState.resource, `playlist_items:${playlistId}`)
      )
    )
    .get();

  const lastSuccessfulAt = sync?.lastSuccessfulAt ?? null;
  const lagSec = lastSuccessfulAt
    ? Math.floor((Date.now() - lastSuccessfulAt) / 1000)
    : null;

  return NextResponse.json({
    items: rows,
    nextCursor,
    asOf: Date.now(),
    sync: {
      status: sync?.status ?? "idle",
      lastSuccessfulAt,
      lagSec,
    },
  });
}
