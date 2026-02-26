import type {
  RecommendationItem,
  RecommendationSeedDebug,
} from "@/lib/recommendations/types";

type SpotifyRecommendationSeedRaw = {
  id?: string;
  type?: string;
  href?: string | null;
  initialPoolSize?: number;
  initial_pool_size?: number;
  afterFilteringSize?: number;
  after_filtering_size?: number;
  afterRelinkingSize?: number;
  after_relinking_size?: number;
};

type SpotifyRecommendationArtistRaw = {
  id?: string;
  name?: string;
};

type SpotifyRecommendationAlbumImageRaw = {
  url?: string;
  width?: number | null;
  height?: number | null;
};

type SpotifyRecommendationTrackRaw = {
  id?: string;
  uri?: string;
  name?: string;
  duration_ms?: number;
  explicit?: boolean;
  preview_url?: string | null;
  popularity?: number;
  artists?: SpotifyRecommendationArtistRaw[];
  album?: {
    id?: string;
    name?: string;
    images?: SpotifyRecommendationAlbumImageRaw[];
  };
};

const TRACK_ID_PATTERN = /^[0-9A-Za-z]{22}$/;

function toPoolNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function mapSpotifyRecommendationSeeds(
  seedsRaw: unknown
): RecommendationSeedDebug[] {
  if (!Array.isArray(seedsRaw)) return [];
  return seedsRaw
    .map((seed) => {
      const source = seed as SpotifyRecommendationSeedRaw;
      const id = String(source?.id ?? "").trim();
      if (!TRACK_ID_PATTERN.test(id)) return null;
      const type = String(source?.type ?? "").trim().toLowerCase();
      if (type && type !== "track") return null;

      return {
        id,
        type: "track" as const,
        href:
          typeof source?.href === "string" && source.href.trim()
            ? source.href.trim()
            : null,
        initialPoolSize: toPoolNumber(
          source?.initialPoolSize ?? source?.initial_pool_size
        ),
        afterFilteringSize: toPoolNumber(
          source?.afterFilteringSize ?? source?.after_filtering_size
        ),
        afterRelinkingSize: toPoolNumber(
          source?.afterRelinkingSize ?? source?.after_relinking_size
        ),
      };
    })
    .filter((seed): seed is RecommendationSeedDebug => Boolean(seed));
}

export function mapSpotifyRecommendationItems(
  tracksRaw: unknown
): RecommendationItem[] {
  if (!Array.isArray(tracksRaw)) return [];

  const seen = new Set<string>();
  const items: RecommendationItem[] = [];

  for (const trackRaw of tracksRaw) {
    const track = trackRaw as SpotifyRecommendationTrackRaw;
    const id = String(track?.id ?? "").trim();
    if (!TRACK_ID_PATTERN.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    const artists = Array.isArray(track?.artists)
      ? track.artists
          .map((artist) => {
            const artistId = String(artist?.id ?? "").trim();
            const name = String(artist?.name ?? "").trim();
            if (!name) return null;
            return { id: artistId || `artist:${name.toLowerCase()}`, name };
          })
          .filter((artist): artist is { id: string; name: string } => Boolean(artist))
      : [];

    const images = Array.isArray(track?.album?.images)
      ? track.album.images
          .map((image) => {
            const url = String(image?.url ?? "").trim();
            if (!url) return null;
            return {
              url,
              width:
                typeof image?.width === "number" && Number.isFinite(image.width)
                  ? Math.floor(image.width)
                  : null,
              height:
                typeof image?.height === "number" && Number.isFinite(image.height)
                  ? Math.floor(image.height)
                  : null,
            };
          })
          .filter(
            (image): image is { url: string; width: number | null; height: number | null } =>
              Boolean(image)
          )
      : [];

    items.push({
      id,
      uri: String(track?.uri ?? `spotify:track:${id}`),
      name: String(track?.name ?? "Onbekende track"),
      durationMs:
        typeof track?.duration_ms === "number" && Number.isFinite(track.duration_ms)
          ? Math.max(0, Math.floor(track.duration_ms))
          : null,
      explicit: Boolean(track?.explicit),
      previewUrl:
        typeof track?.preview_url === "string" && track.preview_url.trim()
          ? track.preview_url.trim()
          : null,
      popularity:
        typeof track?.popularity === "number" && Number.isFinite(track.popularity)
          ? Math.max(0, Math.min(100, Math.floor(track.popularity)))
          : null,
      artists,
      album: {
        id:
          typeof track?.album?.id === "string" && track.album.id.trim()
            ? track.album.id.trim()
            : null,
        name:
          typeof track?.album?.name === "string" && track.album.name.trim()
            ? track.album.name.trim()
            : null,
        images,
      },
    });
  }

  return items;
}
