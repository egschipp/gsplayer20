import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  users,
  oauthTokens,
  jobs,
  syncState,
  userSavedTracks,
  playlists,
} from "@/lib/db/schema";
import { sql, eq } from "drizzle-orm";
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
  ] = await Promise.all([
    count(users, db),
    count(oauthTokens, db),
    count(jobs, db),
    count(syncState, db),
    count(userSavedTracks, db),
    count(playlists, db),
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
    },
    sync: {
      running,
      lastSuccessfulAt: lastSuccessfulAt || null,
      resources: syncRows,
    },
    asOf: Date.now(),
  });
}
