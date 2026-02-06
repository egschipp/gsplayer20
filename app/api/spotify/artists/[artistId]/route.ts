import { getDb } from "@/lib/db/client";
import { artists, trackArtists, tracks } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { getAppAccessToken } from "@/lib/spotify/tokens";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { requireAppUser, jsonPrivateCache } from "@/lib/api/guards";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ artistId: string }> }
) {
  const { response } = await requireAppUser();
  if (response) return response;

  const { artistId } = await ctx.params;
  if (!artistId) {
    return jsonPrivateCache({ error: "MISSING_ARTIST" }, 400);
  }

  const db = getDb();
  const row = await db
    .select({
      artistId: artists.artistId,
      name: artists.name,
      genres: artists.genres,
      popularity: artists.popularity,
      updatedAt: artists.updatedAt,
      tracksCount: sql<number>`count(${tracks.trackId})`.as("tracksCount"),
    })
    .from(artists)
    .leftJoin(trackArtists, eq(trackArtists.artistId, artists.artistId))
    .leftJoin(tracks, eq(tracks.trackId, trackArtists.trackId))
    .where(eq(artists.artistId, artistId))
    .groupBy(artists.artistId)
    .get();

  if (!row) {
    return jsonPrivateCache({ error: "NOT_FOUND" }, 404);
  }

  let genres: string[] = [];
  if (row.genres) {
    try {
      const parsed = JSON.parse(row.genres);
      genres = Array.isArray(parsed)
        ? parsed.filter((value) => typeof value === "string")
        : [];
    } catch {
      genres = row.genres
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
  }
  let popularity = row.popularity ?? null;

  if (!genres || genres.length === 0 || popularity === null) {
    try {
      const token = await getAppAccessToken();
      let res = await fetch(`https://api.spotify.com/v1/artists/${artistId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const session = await getServerSession(getAuthOptions());
        const userToken = session?.accessToken as string | undefined;
        if (userToken) {
          res = await fetch(
            `https://api.spotify.com/v1/artists/${artistId}`,
            {
              headers: { Authorization: `Bearer ${userToken}` },
            }
          );
        }
      }
      if (res.ok) {
        const data = await res.json();
        genres = Array.isArray(data?.genres) ? data.genres : [];
        popularity =
          data?.popularity === null || data?.popularity === undefined
            ? null
            : Number(data.popularity);
        await db
          .update(artists)
          .set({
            genres: genres.length ? JSON.stringify(genres) : null,
            popularity,
            updatedAt: Date.now(),
          })
          .where(eq(artists.artistId, artistId))
          .run();
      }
      if ((!genres || genres.length === 0) || popularity === null) {
        const session = await getServerSession(getAuthOptions());
        const userToken = session?.accessToken as string | undefined;
        if (userToken) {
          const userRes = await fetch(
            `https://api.spotify.com/v1/artists/${artistId}`,
            {
              headers: { Authorization: `Bearer ${userToken}` },
            }
          );
          if (userRes.ok) {
            const data = await userRes.json();
            const nextGenres = Array.isArray(data?.genres) ? data.genres : [];
            const nextPopularity =
              data?.popularity === null || data?.popularity === undefined
                ? null
                : Number(data.popularity);
            genres = nextGenres;
            popularity = nextPopularity;
            await db
              .update(artists)
              .set({
                genres: genres.length ? JSON.stringify(genres) : null,
                popularity,
                updatedAt: Date.now(),
              })
              .where(eq(artists.artistId, artistId))
              .run();
          }
        }
      }
    } catch {
      // best-effort enrichment; keep existing values
    }
  }

  return jsonPrivateCache({
    artistId: row.artistId,
    name: row.name,
    genres,
    popularity,
    updatedAt: row.updatedAt,
    tracksCount: row.tracksCount ?? 0,
    spotifyUrl: row.artistId
      ? `https://open.spotify.com/artist/${row.artistId}`
      : null,
  });
}
