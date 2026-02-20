import { getDb } from "@/lib/db/client";
import {
  artists,
  trackArtists,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { spotifyFetch } from "@/lib/spotify/client";
import { requireAppUser, jsonPrivateCache, rateLimitResponse } from "@/lib/api/guards";
import { upsertArtist, upsertTrackArtist } from "@/lib/db/queries";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ trackId: string }> }
) {
  const { session, response } = await requireAppUser();
  if (response) return response;
  const rl = await rateLimitResponse({
    key: `track-artists:${session.appUserId}`,
    limit: 300,
    windowMs: 60_000,
  });
  if (rl) return rl;

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
      followersTotal: artists.followersTotal,
      imageUrl: artists.imageUrl,
    })
    .from(trackArtists)
    .innerJoin(artists, eq(artists.artistId, trackArtists.artistId))
    .where(eq(trackArtists.trackId, trackId))
    .groupBy(artists.artistId)
    .orderBy(artists.name);

  const dbItems = rows.map((row) => ({
    artistId: row.artistId,
    name: row.name,
    genres: row.genres,
    popularity: row.popularity,
    followersTotal: row.followersTotal,
    imageUrl: row.imageUrl,
  }));

  if (dbItems.length > 0) {
    return jsonPrivateCache({ items: dbItems, asOf: Date.now() });
  }

  try {
    // Fallback: fetch artists directly from Spotify track endpoint when local cache is empty.
    const track = await spotifyFetch<{
      artists?: { id?: string; name?: string }[];
    }>({
      url: `https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`,
      userLevel: true,
    });
    const fetched = Array.isArray(track?.artists)
      ? track.artists
          .map((artist) => ({
            artistId: String(artist?.id ?? ""),
            name: String(artist?.name ?? ""),
            genres: null as string[] | null,
            popularity: null as number | null,
          }))
          .filter((artist) => artist.artistId && artist.name)
      : [];
    if (fetched.length) {
      for (const artist of fetched) {
        await upsertArtist({
          artistId: artist.artistId,
          name: artist.name,
          genres: null,
          popularity: null,
          followersTotal: null,
          imageUrl: null,
        });
        await upsertTrackArtist(trackId, artist.artistId);
      }
      return jsonPrivateCache({ items: fetched, asOf: Date.now() });
    }
  } catch {
    // fall through to empty payload
  }

  return jsonPrivateCache({ items: [], asOf: Date.now() });
}
