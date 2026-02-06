import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit/ratelimit";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { getDb } from "@/lib/db/client";
import { playlists, userPlaylists, syncState } from "@/lib/db/schema";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { decodeCursor, encodeCursor } from "@/lib/spotify/cursor";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await getServerSession(getAuthOptions());
  if (!session?.appUserId) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const rl = rateLimit(`playlists:${session.appUserId}`, 600, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "RATE_LIMIT" }, { status: 429 });
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
          or(
            lt(userPlaylists.lastSeenAt, decoded.addedAt),
            and(
              eq(userPlaylists.lastSeenAt, decoded.addedAt),
              lt(userPlaylists.playlistId, decoded.id)
            )
          )
        );
      })()
    : eq(userPlaylists.userId, session.appUserId as string);

  const rows = await db
    .select({
      playlistId: playlists.playlistId,
      name: playlists.name,
      ownerSpotifyUserId: playlists.ownerSpotifyUserId,
      isPublic: playlists.isPublic,
      collaborative: playlists.collaborative,
      snapshotId: playlists.snapshotId,
      tracksTotal: playlists.tracksTotal,
      lastSeenAt: userPlaylists.lastSeenAt,
    })
    .from(userPlaylists)
    .innerJoin(playlists, eq(playlists.playlistId, userPlaylists.playlistId))
    .where(whereClause)
    .orderBy(desc(userPlaylists.lastSeenAt), desc(userPlaylists.playlistId))
    .limit(limit);

  const last = rows[rows.length - 1];
  const nextCursor = last
    ? encodeCursor(last.lastSeenAt, last.playlistId)
    : null;

  const sync = await db
    .select()
    .from(syncState)
    .where(
      and(
        eq(syncState.userId, session.appUserId as string),
        eq(syncState.resource, "playlists")
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
