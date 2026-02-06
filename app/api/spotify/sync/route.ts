import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { jobs, syncState } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { cryptoRandomId } from "@/lib/db/queries";
import { getRequestIp, rateLimitResponse, requireAppUser, requireSameOrigin } from "@/lib/api/guards";

export const runtime = "nodejs";

const jobMap: Record<string, string> = {
  tracks_initial: "SYNC_TRACKS_INITIAL",
  tracks_incremental: "SYNC_TRACKS_INCREMENTAL",
  playlists: "SYNC_PLAYLISTS",
  playlist_items: "SYNC_PLAYLIST_ITEMS",
  artists: "SYNC_ARTISTS",
  track_metadata: "SYNC_TRACK_METADATA",
  covers: "SYNC_COVERS",
};

export async function POST(req: Request) {
  const originCheck = requireSameOrigin(req);
  if (originCheck) return originCheck;

  const ip = getRequestIp(req);
  const body = await req.json().catch(() => ({}));
  const type = jobMap[body?.type] ?? null;
  const rlKey = type ? `sync:${type}:${ip}` : `sync:${ip}`;
  const rl = await rateLimitResponse({
    key: rlKey,
    limit: 30,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rl) return rl;

  const { session, response } = await requireAppUser();
  if (response) return response;

  if (!type) {
    return NextResponse.json({ error: "INVALID_TYPE" }, { status: 400 });
  }

  const db = getDb();
  const jobId = cryptoRandomId();
  const payload = body?.payload ? JSON.stringify(body.payload) : null;

  await db.insert(jobs).values({
    id: jobId,
    userId: session.appUserId as string,
    type,
    payload,
    runAfter: Date.now(),
    status: "queued",
    attempts: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  await db
    .insert(syncState)
    .values({
      userId: session.appUserId as string,
      resource:
        type === "SYNC_PLAYLISTS"
          ? "playlists"
          : type === "SYNC_PLAYLIST_ITEMS"
          ? "playlist_items"
          : type === "SYNC_ARTISTS"
          ? "artists"
          : type === "SYNC_COVERS"
          ? "covers"
          : "tracks",
      status: "queued",
      cursorOffset: null,
      cursorLimit: null,
      lastSuccessfulAt: null,
      retryAfterAt: null,
      failureCount: 0,
      lastErrorCode: null,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: [syncState.userId, syncState.resource],
      set: {
        status: "queued",
        retryAfterAt: null,
        lastErrorCode: null,
      },
    });

  return NextResponse.json({ jobId, status: "queued" });
}
