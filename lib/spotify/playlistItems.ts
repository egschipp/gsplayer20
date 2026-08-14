export type SpotifyPlaylistTrack = {
  id?: string;
  name?: string;
  duration_ms?: number;
  explicit?: boolean;
  is_local?: boolean;
  linked_from?: { id?: string | null };
  restrictions?: { reason?: string | null };
  popularity?: number;
  album?: {
    id?: string;
    name?: string;
    release_date?: string;
    images?: Array<{ url?: string }>;
  };
  artists?: Array<{ name?: string }>;
};

export type SpotifyPlaylistItem = {
  added_at?: string;
  added_by?: { id?: string };
  item?: SpotifyPlaylistTrack;
  /** @deprecated Compatibility with pre-February 2026 responses. */
  track?: SpotifyPlaylistTrack;
};

export type SpotifyPlaylistItemsResponse = {
  items?: SpotifyPlaylistItem[];
  total?: number;
  next?: string | null;
};

const TRACK_ID_REGEX = /^[A-Za-z0-9]{22}$/;

export function normalizeTrackId(value: unknown) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (TRACK_ID_REGEX.test(raw)) return raw;
  if (raw.startsWith("spotify:track:")) {
    const id = raw.split(":").pop() ?? "";
    return TRACK_ID_REGEX.test(id) ? id : null;
  }
  try {
    const url = new URL(raw);
    const match = url.pathname.match(/\/track\/([A-Za-z0-9]{22})/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function normalizeSpotifyTotal(total: unknown) {
  return typeof total === "number" && Number.isFinite(total)
    ? Math.max(0, Math.floor(total))
    : null;
}

export function mapLivePlaylistItems(
  items: SpotifyPlaylistItem[] | undefined,
  playlistId: string,
  offset: number
) {
  return (Array.isArray(items) ? items : []).map((item, index) => {
    const track = item?.item ?? item?.track;
    const trackId = typeof track?.id === "string" ? track.id : null;
    const releaseDate = track?.album?.release_date ?? null;
    const releaseYear =
      releaseDate && /^\d{4}/.test(releaseDate) ? Number(releaseDate.slice(0, 4)) : null;
    const addedAtValue = item?.added_at ? Date.parse(item.added_at) : NaN;
    const albumImageUrl =
      track?.album?.images?.find((image) => typeof image?.url === "string")?.url ?? null;
    return {
      itemId: `${playlistId}:${offset + index}:${trackId ?? "unknown"}`,
      playlistId,
      trackId,
      name: track?.name ?? "Unknown track",
      albumId: track?.album?.id ?? null,
      albumName: track?.album?.name ?? null,
      albumReleaseDate: releaseDate,
      releaseYear,
      albumImageUrl,
      coverUrl: albumImageUrl,
      durationMs: typeof track?.duration_ms === "number" ? track.duration_ms : null,
      explicit: typeof track?.explicit === "boolean" ? (track.explicit ? 1 : 0) : null,
      isLocal: typeof track?.is_local === "boolean" ? (track.is_local ? 1 : 0) : null,
      linkedFromTrackId:
        typeof track?.linked_from?.id === "string" ? track.linked_from.id : null,
      restrictionsReason:
        typeof track?.restrictions?.reason === "string"
          ? track.restrictions.reason
          : null,
      popularity: typeof track?.popularity === "number" ? track.popularity : null,
      artists: Array.isArray(track?.artists)
        ? track.artists
            .map((artist) => artist?.name)
            .filter(Boolean)
            .join(", ")
        : null,
      addedAt: Number.isFinite(addedAtValue) ? addedAtValue : null,
      addedBySpotifyUserId: item?.added_by?.id ?? null,
      position: offset + index,
      snapshotIdAtSync: null,
      syncRunId: null,
      playlists: [
        {
          id: playlistId,
          name: "Geselecteerde playlist",
          spotifyUrl: `https://open.spotify.com/playlist/${playlistId}`,
        },
      ],
    };
  });
}
