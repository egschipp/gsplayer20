import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { getDb } from "@/lib/db/client";
import {
  artists,
  trackArtists,
  userSavedTracks,
  playlistItems,
  userPlaylists,
} from "@/lib/db/schema";
import { and, eq, or } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ trackId: string }> }
) {
  const session = await getServerSession(getAuthOptions());
  if (!session?.appUserId) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { trackId } = await ctx.params;
  if (!trackId) {
    return NextResponse.json({ error: "MISSING_TRACK" }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select({
      artistId: artists.artistId,
      name: artists.name,
      genres: artists.genres,
      popularity: artists.popularity,
    })
    .from(trackArtists)
    .innerJoin(artists, eq(artists.artistId, trackArtists.artistId))
    .leftJoin(
      userSavedTracks,
      and(
        eq(userSavedTracks.trackId, trackArtists.trackId),
        eq(userSavedTracks.userId, session.appUserId as string)
      )
    )
    .leftJoin(playlistItems, eq(playlistItems.trackId, trackArtists.trackId))
    .leftJoin(
      userPlaylists,
      and(
        eq(userPlaylists.playlistId, playlistItems.playlistId),
        eq(userPlaylists.userId, session.appUserId as string)
      )
    )
    .where(
      and(
        eq(trackArtists.trackId, trackId),
        or(
          eq(userSavedTracks.userId, session.appUserId as string),
          eq(userPlaylists.userId, session.appUserId as string)
        )
      )
    )
    .groupBy(artists.artistId)
    .orderBy(artists.name);

  return NextResponse.json({ items: rows, asOf: Date.now() });
}
