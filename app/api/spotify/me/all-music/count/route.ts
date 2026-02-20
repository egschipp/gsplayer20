import { getDb } from "@/lib/db/client";
import { playlistItems, playlists, userPlaylists } from "@/lib/db/schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  jsonPrivateCache,
  rateLimitResponse,
  requireAppUser,
} from "@/lib/api/guards";

export const runtime = "nodejs";

const LEADING_EMOJI_PATTERN =
  /^[\s\u200B-\u200D\u200E\u200F\u2060\uFEFF]*(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]{2}|[#*0-9]\uFE0F?\u20E3)/u;

function startsWithEmoji(value: string | null | undefined) {
  return LEADING_EMOJI_PATTERN.test(String(value ?? ""));
}

export async function GET() {
  const { session, response } = await requireAppUser();
  if (response) return response;

  const rl = await rateLimitResponse({
    key: `all-music-count:${session.appUserId}`,
    limit: 300,
    windowMs: 60_000,
  });
  if (rl) return rl;

  const db = getDb();
  const playlistRows = await db
    .select({
      playlistId: playlists.playlistId,
      name: playlists.name,
    })
    .from(userPlaylists)
    .innerJoin(playlists, eq(playlists.playlistId, userPlaylists.playlistId))
    .where(eq(userPlaylists.userId, session.appUserId as string));

  const emojiPlaylistIds = playlistRows
    .filter((row) => startsWithEmoji(row.name))
    .map((row) => row.playlistId);

  if (!emojiPlaylistIds.length) {
    return jsonPrivateCache({
      totalCount: 0,
      asOf: Date.now(),
    });
  }

  const totalRow = await db
    .select({
      count: sql<number>`count(distinct ${playlistItems.trackId})`,
    })
    .from(playlistItems)
    .where(
      and(
        inArray(playlistItems.playlistId, emojiPlaylistIds),
        isNotNull(playlistItems.trackId)
      )
    )
    .get();

  const totalCount =
    typeof totalRow?.count === "number" && Number.isFinite(totalRow.count)
      ? Math.max(0, Math.floor(totalRow.count))
      : 0;

  return jsonPrivateCache({
    totalCount,
    asOf: Date.now(),
  });
}
