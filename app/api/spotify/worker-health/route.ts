import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { workerHeartbeat } from "@/lib/db/schema";
import { requireAppUser, jsonNoStore } from "@/lib/api/guards";

export const runtime = "nodejs";

const STALE_AFTER_MS = 30_000;

export async function GET() {
  const { response } = await requireAppUser();
  if (response) return response;

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

  return jsonNoStore({
    status,
    lastHeartbeat,
    staleAfterMs: STALE_AFTER_MS,
    now,
  });
}
