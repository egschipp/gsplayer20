import type { TrackItem, TrackRow } from "./types";
import { sortPlaylistLinks } from "./normalizers";
import { dedupeArtistText } from "./utils";

export type TrackApiItem = {
  id?: string;
  trackId?: string;
  name?: string;
  artists?: { id?: string; name?: string }[];
  album?: {
    id?: string | null;
    name?: string | null;
    images?: { url: string }[];
    release_date?: string | null;
  };
  releaseYear?: number | null;
  durationMs?: number | null;
  explicit?: boolean | number | null;
  isLocal?: boolean | number | null;
  restrictionsReason?: string | null;
  linkedFromTrackId?: string | null;
  popularity?: number | null;
  albumImageUrl?: string | null;
  playlists?: { id: string; name: string; spotifyUrl?: string }[];
};

export function mapTrackApiItems(items: TrackApiItem[]): TrackItem[] {
  return items.map((track): TrackItem => ({
    id: String(track.id ?? track.trackId ?? ""),
    trackId: track.trackId ?? null,
    name: String(track.name ?? ""),
    artists: Array.isArray(track.artists)
      ? track.artists
          .filter((artist): artist is { id: string; name: string } =>
            Boolean(artist?.id && artist?.name)
          )
          .map((artist) => ({ id: artist.id, name: artist.name }))
      : [],
    album: {
      id: track.album?.id ?? null,
      name: track.album?.name ?? null,
      images: Array.isArray(track.album?.images) ? track.album.images : [],
      release_date: track.album?.release_date ?? null,
    },
    releaseYear: typeof track.releaseYear === "number" ? track.releaseYear : null,
    durationMs: track.durationMs ?? null,
    explicit:
      typeof track.explicit === "boolean"
        ? track.explicit
          ? 1
          : 0
        : (track.explicit ?? null),
    isLocal:
      typeof track.isLocal === "number"
        ? track.isLocal
        : typeof track.isLocal === "boolean"
          ? track.isLocal
            ? 1
            : 0
          : null,
    restrictionsReason:
      typeof track.restrictionsReason === "string" ? track.restrictionsReason : null,
    linkedFromTrackId:
      typeof track.linkedFromTrackId === "string" ? track.linkedFromTrackId : null,
    popularity: track.popularity ?? null,
    albumImageUrl: track.albumImageUrl ?? null,
    playlists: Array.isArray(track.playlists)
      ? sortPlaylistLinks(
          track.playlists
            .filter(
              (playlist): playlist is { id: string; name: string; spotifyUrl?: string } =>
                Boolean(playlist?.id && playlist?.name)
            )
            .map((playlist) => ({
              id: playlist.id,
              name: playlist.name,
              spotifyUrl:
                playlist.spotifyUrl || `https://open.spotify.com/playlist/${playlist.id}`,
            }))
        )
      : [],
  }));
}

export function mapTrackItemToRow(track: TrackItem): TrackRow {
  const trackId =
    typeof track.trackId === "string" && track.trackId ? track.trackId : track.id;
  const artistsText =
    dedupeArtistText(
      (Array.isArray(track.artists) ? track.artists : [])
        .map((artist) => artist?.name)
        .filter(Boolean)
        .join(", ")
    ) || null;
  const coverUrl = track.album?.images?.[0]?.url ?? track.albumImageUrl ?? null;
  const albumReleaseDate = track.album?.release_date ?? null;
  const releaseYear =
    typeof track.releaseYear === "number"
      ? track.releaseYear
      : albumReleaseDate && /^\d{4}/.test(albumReleaseDate)
        ? Number(albumReleaseDate.slice(0, 4))
        : null;
  return {
    trackId: trackId || null,
    name: track.name || null,
    albumId: track.album?.id ?? null,
    albumName: track.album?.name ?? null,
    albumReleaseDate,
    releaseYear,
    albumImageUrl: track.albumImageUrl ?? null,
    coverUrl,
    artists: artistsText,
    durationMs: track.durationMs ?? null,
    explicit: track.explicit ?? null,
    isLocal: track.isLocal ?? null,
    restrictionsReason: track.restrictionsReason ?? null,
    linkedFromTrackId: track.linkedFromTrackId ?? null,
    popularity: track.popularity ?? null,
    playlists: Array.isArray(track.playlists)
      ? sortPlaylistLinks(
          track.playlists.map((playlist) => ({
            id: playlist.id,
            name: playlist.name,
            spotifyUrl:
              playlist.spotifyUrl ||
              (playlist.id === "liked"
                ? "https://open.spotify.com/collection/tracks"
                : `https://open.spotify.com/playlist/${playlist.id}`),
          }))
        )
      : [],
  };
}
