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

const SPOTIFY_ID_REGEX = /^[A-Za-z0-9]{22}$/;

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(Math.floor(parsed), max));
}

function normalizePayload(type: string, payload: unknown) {
  const raw =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};

  if (
    type === "SYNC_TRACKS_INITIAL" ||
    type === "SYNC_TRACKS_INCREMENTAL" ||
    type === "SYNC_PLAYLISTS"
  ) {
    return {
      offset: clampInt(raw.offset, 0, 500_000, 0),
      limit: clampInt(raw.limit, 1, 50, 50),
      maxPagesPerRun: clampInt(raw.maxPagesPerRun, 1, 100, 10),
    };
  }

  if (type === "SYNC_PLAYLIST_ITEMS") {
    const playlistId =
      typeof raw.playlistId === "string" && SPOTIFY_ID_REGEX.test(raw.playlistId)
        ? raw.playlistId
        : null;

    if (!playlistId) {
      return null;
    }

    return {
      playlistId,
      snapshotId:
        typeof raw.snapshotId === "string" ? raw.snapshotId.slice(0, 128) : null,
      offset: clampInt(raw.offset, 0, 200_000, 0),
      limit: clampInt(raw.limit, 1, 50, 50),
      maxPagesPerRun: clampInt(raw.maxPagesPerRun, 1, 100, 10),
      runId: typeof raw.runId === "string" ? raw.runId.slice(0, 64) : undefined,
    };
  }

  if (
    type === "SYNC_ARTISTS" ||
    type === "SYNC_TRACK_METADATA" ||
    type === "SYNC_COVERS"
  ) {
    return {
      cursor: typeof raw.cursor === "string" ? raw.cursor.slice(0, 128) : "",
      limit: clampInt(raw.limit, 1, 50, 50),
      maxBatches: clampInt(raw.maxBatches, 1, 100, 20),
    };
  }

  return {};
}

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
  const normalizedPayload = normalizePayload(type, body?.payload);
  if (normalizedPayload === null) {
    return NextResponse.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
  }
  const payload = JSON.stringify(normalizedPayload);

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
