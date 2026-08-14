import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { tracks, userSavedTracks, playlistItems, userPlaylists } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { requireAppUser } from "@/lib/api/guards";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ trackId: string }> }) {
  const { session, response } = await requireAppUser();
  if (response) return response;

  const { trackId } = await ctx.params;
  if (!trackId) {
    return NextResponse.json({ error: "MISSING_TRACK" }, { status: 400 });
  }

  const db = getDb();
  const ownsSaved = await db
    .select({ id: userSavedTracks.trackId })
    .from(userSavedTracks)
    .where(
      and(
        eq(userSavedTracks.userId, session.appUserId as string),
        eq(userSavedTracks.trackId, trackId)
      )
    )
    .get();

  if (!ownsSaved) {
    const ownsPlaylist = await db
      .select({ id: playlistItems.trackId })
      .from(playlistItems)
      .innerJoin(userPlaylists, eq(userPlaylists.playlistId, playlistItems.playlistId))
      .where(
        and(
          eq(userPlaylists.userId, session.appUserId as string),
          eq(playlistItems.trackId, trackId)
        )
      )
      .get();

    if (!ownsPlaylist) {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }
  }

  const track = await db
    .select({
      blob: tracks.albumImageBlob,
      mime: tracks.albumImageMime,
      url: tracks.albumImageUrl,
    })
    .from(tracks)
    .where(eq(tracks.trackId, trackId))
    .get();

  if (track?.blob) {
    return new NextResponse(new Uint8Array(track.blob as Buffer), {
      status: 200,
      headers: {
        "Content-Type": track.mime || "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }

  if (track?.url) {
    try {
      const imageUrl = new URL(track.url);
      const allowedHost =
        imageUrl.hostname === "i.scdn.co" || imageUrl.hostname.endsWith(".scdn.co");
      if (
        imageUrl.protocol === "https:" &&
        !imageUrl.port &&
        !imageUrl.username &&
        !imageUrl.password &&
        allowedHost
      ) {
        return NextResponse.redirect(imageUrl);
      }
    } catch {
      // Treat invalid legacy database values as unavailable.
    }
  }

  return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
}
