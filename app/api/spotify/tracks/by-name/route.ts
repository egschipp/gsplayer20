import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { getDb } from "@/lib/db/client";
import {
  artists,
  trackArtists,
  tracks,
  userSavedTracks,
  playlistItems,
  userPlaylists,
} from "@/lib/db/schema";
import { and, eq, or } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await getServerSession(getAuthOptions());
  if (!session?.appUserId) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const name = (searchParams.get("name") ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "MISSING_NAME" }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select({
      artistId: artists.artistId,
      name: artists.name,
      genres: artists.genres,
      popularity: artists.popularity,
    })
    .from(tracks)
    .innerJoin(trackArtists, eq(trackArtists.trackId, tracks.trackId))
    .innerJoin(artists, eq(artists.artistId, trackArtists.artistId))
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
    .where(
      and(
        eq(tracks.name, name),
        or(
          eq(userSavedTracks.userId, session.appUserId as string),
          eq(userPlaylists.userId, session.appUserId as string)
        )
      )
    )
    .groupBy(artists.artistId)
    .orderBy(artists.name);

  const unique = new Map<string, typeof rows[number]>();
  for (const row of rows) unique.set(row.artistId, row);

  return NextResponse.json({
    items: Array.from(unique.values()),
    asOf: Date.now(),
  });
}
