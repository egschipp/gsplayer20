import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { getDb } from "@/lib/db/client";
import { artists } from "@/lib/db/schema";
import { desc, lt } from "drizzle-orm";
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
        return lt(artists.artistId, decoded.id);
      })()
    : undefined;

  const rows = await db
    .select({
      artistId: artists.artistId,
      name: artists.name,
      genres: artists.genres,
      popularity: artists.popularity,
    })
    .from(artists)
    .where(whereClause)
    .orderBy(desc(artists.artistId))
    .limit(limit);

  const last = rows[rows.length - 1];
  const nextCursor = last ? encodeCursor(0, last.artistId) : null;

  return NextResponse.json({ items: rows, nextCursor, asOf: Date.now() });
}
