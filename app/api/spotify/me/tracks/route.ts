import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit/ratelimit";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { getDb } from "@/lib/db/client";
import { userSavedTracks, tracks, syncState, trackArtists, artists } from "@/lib/db/schema";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { decodeCursor, encodeCursor } from "@/lib/spotify/cursor";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  const rl = rateLimit(`tracks:${ip}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "RATE_LIMIT" }, { status: 429 });
  }

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
        return and(
          eq(userSavedTracks.userId, session.appUserId as string),
          or(
            lt(userSavedTracks.addedAt, decoded.addedAt),
            and(
              eq(userSavedTracks.addedAt, decoded.addedAt),
              lt(userSavedTracks.trackId, decoded.id)
            )
          )
        );
      })()
    : eq(userSavedTracks.userId, session.appUserId as string);

  const rows = await db
    .select({
      trackId: tracks.trackId,
      name: tracks.name,
      durationMs: tracks.durationMs,
      explicit: tracks.explicit,
      albumId: tracks.albumId,
      albumName: tracks.albumName,
      albumImageUrl: tracks.albumImageUrl,
      hasCover: sql<number>`(${tracks.albumImageBlob} IS NOT NULL)`,
      popularity: tracks.popularity,
      addedAt: userSavedTracks.addedAt,
      artists: sql<string | null>`group_concat(${artists.name}, ', ')`,
    })
    .from(userSavedTracks)
    .innerJoin(tracks, eq(tracks.trackId, userSavedTracks.trackId))
    .leftJoin(trackArtists, eq(trackArtists.trackId, tracks.trackId))
    .leftJoin(artists, eq(artists.artistId, trackArtists.artistId))
    .where(whereClause)
    .groupBy(tracks.trackId, userSavedTracks.addedAt, userSavedTracks.trackId)
    .orderBy(desc(userSavedTracks.addedAt), desc(userSavedTracks.trackId))
    .limit(limit);

  const last = rows[rows.length - 1];
  const nextCursor = last ? encodeCursor(last.addedAt, last.trackId) : null;

  const sync = await db
    .select()
    .from(syncState)
    .where(
      and(
        eq(syncState.userId, session.appUserId as string),
        eq(syncState.resource, "tracks")
      )
    )
    .get();

  const lastSuccessfulAt = sync?.lastSuccessfulAt ?? null;
  const lagSec = lastSuccessfulAt
    ? Math.floor((Date.now() - lastSuccessfulAt) / 1000)
    : null;

  return NextResponse.json({
    items: rows.map((row) => ({
      ...row,
      coverUrl: row.hasCover ? `/api/spotify/cover/${row.trackId}` : row.albumImageUrl,
    })),
    nextCursor,
    asOf: Date.now(),
    sync: {
      status: sync?.status ?? "idle",
      lastSuccessfulAt,
      lagSec,
    },
  });
}
