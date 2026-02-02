import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  users,
  oauthTokens,
  jobs,
  syncState,
  userSavedTracks,
  playlists,
  tracks,
  artists,
  playlistItems,
  userPlaylists,
  trackArtists,
} from "@/lib/db/schema";
import { sql, eq, isNotNull } from "drizzle-orm";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";

export const runtime = "nodejs";

function count(table: any, db: ReturnType<typeof getDb>) {
  return db.select({ count: sql<number>`count(*)` }).from(table).get();
}

export async function GET() {
  const session = await getServerSession(getAuthOptions());
  if (!session?.appUserId) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const db = getDb();
  const [
    usersCount,
    tokensCount,
    jobsCount,
    syncCount,
    savedCount,
    playlistsCount,
    tracksCount,
    coversCount,
    artistsCount,
    playlistItemsCount,
    userPlaylistsCount,
    trackArtistsCount,
  ] = await Promise.all([
    count(users, db),
    count(oauthTokens, db),
    count(jobs, db),
    count(syncState, db),
    count(userSavedTracks, db),
    count(playlists, db),
    count(tracks, db),
    db
      .select({ count: sql<number>`count(*)` })
      .from(tracks)
      .where(isNotNull(tracks.albumImageBlob))
      .get(),
    count(artists, db),
    count(playlistItems, db),
    count(userPlaylists, db),
    count(trackArtists, db),
  ]);

  const syncRows = await db
    .select()
    .from(syncState)
    .where(eq(syncState.userId, session.appUserId as string));

  const running = syncRows.some((row) => row.status === "running");
  const lastSuccessfulAt = syncRows
    .map((row) => row.lastSuccessfulAt || 0)
    .reduce((a, b) => Math.max(a, b), 0);

  return NextResponse.json({
    counts: {
      users: usersCount?.count ?? 0,
      oauth_tokens: tokensCount?.count ?? 0,
      jobs: jobsCount?.count ?? 0,
      sync_state: syncCount?.count ?? 0,
      user_saved_tracks: savedCount?.count ?? 0,
      playlists: playlistsCount?.count ?? 0,
      tracks: tracksCount?.count ?? 0,
      cover_images: coversCount?.count ?? 0,
      artists: artistsCount?.count ?? 0,
      playlist_items: playlistItemsCount?.count ?? 0,
      user_playlists: userPlaylistsCount?.count ?? 0,
      track_artists: trackArtistsCount?.count ?? 0,
    },
    sync: {
      running,
      lastSuccessfulAt: lastSuccessfulAt || null,
      resources: syncRows,
    },
    asOf: Date.now(),
  });
}
