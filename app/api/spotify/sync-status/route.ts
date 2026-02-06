import { getDb } from "@/lib/db/client";
import { syncState } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireAppUser, jsonNoStore } from "@/lib/api/guards";

export const runtime = "nodejs";

export async function GET() {
  const { session, response } = await requireAppUser();
  if (response) return response;

  const db = getDb();
  const rows = await db
    .select()
    .from(syncState)
    .where(eq(syncState.userId, session.appUserId as string));

  return jsonNoStore({
    resources: rows,
    asOf: Date.now(),
  });
}
