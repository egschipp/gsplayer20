import { getDb } from "@/lib/db/client";
import {
  artists,
  trackArtists,
  userSavedTracks,
  playlistItems,
  userPlaylists,
} from "@/lib/db/schema";
import { and, eq, or } from "drizzle-orm";
import { spotifyFetch } from "@/lib/spotify/client";
import { requireAppUser, jsonPrivateCache } from "@/lib/api/guards";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ trackId: string }> }
) {
  const { session, response } = await requireAppUser();
  if (response) return response;

  const { trackId } = await ctx.params;
  if (!trackId) {
    return jsonPrivateCache({ error: "MISSING_TRACK" }, 400);
  }

  const db = getDb();
  const rows = await db
    .select({
      artistId: artists.artistId,
      name: artists.name,
      genres: artists.genres,
      popularity: artists.popularity,
    })
    .from(trackArtists)
    .innerJoin(artists, eq(artists.artistId, trackArtists.artistId))
    .leftJoin(
      userSavedTracks,
      and(
        eq(userSavedTracks.trackId, trackArtists.trackId),
        eq(userSavedTracks.userId, session.appUserId as string)
      )
    )
    .leftJoin(playlistItems, eq(playlistItems.trackId, trackArtists.trackId))
    .leftJoin(
      userPlaylists,
      and(
        eq(userPlaylists.playlistId, playlistItems.playlistId),
        eq(userPlaylists.userId, session.appUserId as string)
      )
    )
    .where(
      and(
        eq(trackArtists.trackId, trackId),
        or(
          eq(userSavedTracks.userId, session.appUserId as string),
          eq(userPlaylists.userId, session.appUserId as string)
        )
      )
    )
    .groupBy(artists.artistId)
    .orderBy(artists.name);

  const items = rows.map((row) => ({
    artistId: row.artistId,
    name: row.name,
    genres: row.genres,
    popularity: row.popularity,
  }));

  const missing = items.filter(
    (artist) =>
      !artist.genres ||
      artist.genres === "[]" ||
      artist.genres === "null" ||
      artist.genres === ""
  );

  if (missing.length) {
    try {
      const ids = missing.map((artist) => artist.artistId).filter(Boolean);
      if (!ids.length) {
        return jsonPrivateCache({ items, asOf: Date.now() });
      }
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        const data = await spotifyFetch({
          url: `https://api.spotify.com/v1/artists?ids=${batch.join(",")}`,
          userLevel: false,
        });
        for (const artist of data.artists || []) {
          if (!artist?.id) continue;
          await db
            .update(artists)
            .set({
              genres: artist.genres ? JSON.stringify(artist.genres) : null,
              popularity: artist.popularity ?? null,
              updatedAt: Date.now(),
            })
            .where(eq(artists.artistId, artist.id))
            .run();
        }
      }
    } catch {
      // ignore enrichment errors
    }
  }

  const refreshed = await db
    .select({
      artistId: artists.artistId,
      name: artists.name,
      genres: artists.genres,
      popularity: artists.popularity,
    })
    .from(trackArtists)
    .innerJoin(artists, eq(artists.artistId, trackArtists.artistId))
    .where(eq(trackArtists.trackId, trackId))
    .groupBy(artists.artistId)
    .orderBy(artists.name);

  return jsonPrivateCache({ items: refreshed, asOf: Date.now() });
}
