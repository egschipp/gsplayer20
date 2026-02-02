import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { eq } from "drizzle-orm";
import { getAuthOptions } from "@/lib/auth/options";
import { getDb } from "@/lib/db/client";
import { workerHeartbeat } from "@/lib/db/schema";

export const runtime = "nodejs";

const STALE_AFTER_MS = 30_000;

export async function GET() {
  const session = await getServerSession(getAuthOptions());
  if (!session?.appUserId) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const db = getDb();
  const row = db
    .select()
    .from(workerHeartbeat)
    .where(eq(workerHeartbeat.id, "worker"))
    .get();

  const now = Date.now();
  const lastHeartbeat = row?.updatedAt ?? null;
  let status = "MISSING";

  if (lastHeartbeat) {
    status = now - lastHeartbeat > STALE_AFTER_MS ? "STALE" : "OK";
  }

  return NextResponse.json({
    status,
    lastHeartbeat,
    staleAfterMs: STALE_AFTER_MS,
    now,
  });
}
