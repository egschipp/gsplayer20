import { getDb } from "@/lib/db/client";
import { artists, trackArtists } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { requireAppUser, jsonPrivateCache } from "@/lib/api/guards";
import { getAppAccessToken } from "@/lib/spotify/tokens";
import { upsertArtist } from "@/lib/db/queries";

export const runtime = "nodejs";

type SpotifyArtistPayload = {
  id?: string;
  name?: string;
  genres?: unknown;
  popularity?: unknown;
  followers?: { total?: unknown };
  images?: Array<{ url?: unknown }>;
};

function parseStoredGenres(raw: string | null | undefined) {
  if (!raw) return [] as string[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [] as string[];
    return parsed
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
}

async function fetchArtistFromSpotify(artistId: string) {
  try {
    const token = await getAppAccessToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(
        `https://api.spotify.com/v1/artists/${encodeURIComponent(artistId)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
          signal: controller.signal,
        }
      );
      if (!res.ok) return null;
      const data = (await res.json()) as SpotifyArtistPayload;
      const name = typeof data?.name === "string" ? data.name.trim() : "";
      if (!name) return null;
      const genres = Array.isArray(data?.genres)
        ? data.genres
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean)
        : [];
      const popularityRaw = data?.popularity;
      const popularity =
        typeof popularityRaw === "number" && Number.isFinite(popularityRaw)
          ? Math.max(0, Math.min(100, Math.floor(popularityRaw)))
          : null;
      const followersRaw = data?.followers?.total;
      const followersTotal =
        typeof followersRaw === "number" && Number.isFinite(followersRaw)
          ? Math.max(0, Math.floor(followersRaw))
          : null;
      const imageCandidate = Array.isArray(data?.images)
        ? data.images.find(
            (image): image is { url: string } => typeof image?.url === "string"
          ) ?? null
        : null;
      const imageUrl = imageCandidate?.url ?? null;
      return {
        artistId:
          typeof data?.id === "string" && data.id.trim() ? data.id : artistId,
        name,
        genres,
        popularity,
        followersTotal,
        imageUrl,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

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
      followersTotal: artists.followersTotal,
      imageUrl: artists.imageUrl,
      updatedAt: artists.updatedAt,
    })
    .from(artists)
    .where(eq(artists.artistId, artistId))
    .get();

  const tracksCountRow = await db
    .select({
      count: sql<number>`count(distinct ${trackArtists.trackId})`,
    })
    .from(trackArtists)
    .where(eq(trackArtists.artistId, artistId))
    .get();

  const tracksCount =
    typeof tracksCountRow?.count === "number" && Number.isFinite(tracksCountRow.count)
      ? Math.max(0, Math.floor(tracksCountRow.count))
      : 0;

  let resolvedArtistId = row?.artistId ?? artistId;
  let name = row?.name ?? "";
  let genres = parseStoredGenres(row?.genres);
  let popularity = row?.popularity ?? null;
  let followersTotal = row?.followersTotal ?? null;
  let imageUrl = row?.imageUrl ?? null;
  let updatedAt = row?.updatedAt ?? null;
  const needsEnrichment =
    !row || genres.length === 0 || popularity === null || followersTotal === null;

  if (needsEnrichment) {
    const live = await fetchArtistFromSpotify(artistId);
    if (live) {
      resolvedArtistId = live.artistId;
      name = live.name;
      genres = live.genres;
      popularity = live.popularity;
      followersTotal = live.followersTotal;
      imageUrl = live.imageUrl;
      updatedAt = Date.now();
      await upsertArtist({
        artistId: live.artistId,
        name: live.name,
        genres: live.genres,
        popularity: live.popularity,
        followersTotal: live.followersTotal,
        imageUrl: live.imageUrl,
      });
    }
  }

  if (!name) {
    return jsonPrivateCache({ error: "NOT_FOUND" }, 404);
  }

  return jsonPrivateCache({
    artistId: resolvedArtistId,
    name,
    genres,
    popularity,
    followersTotal,
    imageUrl,
    updatedAt,
    tracksCount,
    spotifyUrl: resolvedArtistId
      ? `https://open.spotify.com/artist/${resolvedArtistId}`
      : null,
  });
}
