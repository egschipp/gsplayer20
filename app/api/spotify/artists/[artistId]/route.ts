import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { getDb } from "@/lib/db/client";
import { artists, trackArtists, tracks } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ artistId: string }> }
) {
  const session = await getServerSession(getAuthOptions());
  if (!session?.appUserId) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { artistId } = await ctx.params;
  if (!artistId) {
    return NextResponse.json({ error: "MISSING_ARTIST" }, { status: 400 });
  }

  const db = getDb();
  const row = await db
    .select({
      artistId: artists.artistId,
      name: artists.name,
      genres: artists.genres,
      popularity: artists.popularity,
      updatedAt: artists.updatedAt,
      tracksCount: sql<number>`count(${tracks.trackId})`.as("tracksCount"),
    })
    .from(artists)
    .leftJoin(trackArtists, eq(trackArtists.artistId, artists.artistId))
    .leftJoin(tracks, eq(tracks.trackId, trackArtists.trackId))
    .where(eq(artists.artistId, artistId))
    .groupBy(artists.artistId)
    .get();

  if (!row) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const genres = row.genres ? JSON.parse(row.genres) : [];

  return NextResponse.json({
    artistId: row.artistId,
    name: row.name,
    genres,
    popularity: row.popularity,
    updatedAt: row.updatedAt,
    tracksCount: row.tracksCount ?? 0,
    spotifyUrl: row.artistId
      ? `https://open.spotify.com/artist/${row.artistId}`
      : null,
  });
}
