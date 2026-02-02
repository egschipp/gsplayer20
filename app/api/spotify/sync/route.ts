import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { rateLimit } from "@/lib/rate-limit/ratelimit";
import { getDb } from "@/lib/db/client";
import { jobs, syncState } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { cryptoRandomId } from "@/lib/db/queries";
import { getBaseUrl } from "@/lib/env";

export const runtime = "nodejs";

const jobMap: Record<string, string> = {
  tracks_initial: "SYNC_TRACKS_INITIAL",
  tracks_incremental: "SYNC_TRACKS_INCREMENTAL",
  playlists: "SYNC_PLAYLISTS",
  playlist_items: "SYNC_PLAYLIST_ITEMS",
  track_metadata: "SYNC_TRACK_METADATA",
  covers: "SYNC_COVERS",
};

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  const rl = rateLimit(`sync:${ip}`, 10, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "RATE_LIMIT" }, { status: 429 });
  }

  const baseUrl = getBaseUrl() || new URL(req.url).origin;
  const expectedOrigin = new URL(baseUrl).origin;
  const origin = req.headers.get("origin") || req.headers.get("referer") || "";
  if (origin && !origin.startsWith(expectedOrigin)) {
    return NextResponse.json({ error: "INVALID_ORIGIN" }, { status: 403 });
  }

  const session = await getServerSession(getAuthOptions());
  if (!session?.appUserId) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const type = jobMap[body?.type] ?? null;
  if (!type) {
    return NextResponse.json({ error: "INVALID_TYPE" }, { status: 400 });
  }

  const db = getDb();
  const jobId = cryptoRandomId();
  const payload = body?.payload ? JSON.stringify(body.payload) : null;

  await db.insert(jobs).values({
    id: jobId,
    userId: session.appUserId,
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
      userId: session.appUserId,
      resource:
        type === "SYNC_PLAYLISTS"
          ? "playlists"
          : type === "SYNC_PLAYLIST_ITEMS"
          ? "playlist_items"
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
