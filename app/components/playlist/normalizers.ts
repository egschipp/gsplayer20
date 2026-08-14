import {
  ALL_MY_MUSIC_OPTION,
  LIKED_OPTION,
  type AlbumOption,
  type ArtistOption,
  type PlaylistLink,
  type PlaylistOption,
  type TrackItem,
  type TrackRow,
} from "./types";
import { dedupeArtistText } from "./utils";

const LEADING_EMOJI_PATTERN =
  /^[\s\u200B-\u200D\u200E\u200F\u2060\uFEFF]*(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]{2}|[#*0-9]\uFE0F?\u20E3)/u;

export function normalizeTrackName(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("nl");
}

export function startsWithEmoji(value: string | null | undefined) {
  return LEADING_EMOJI_PATTERN.test(String(value ?? ""));
}

export function sortPlaylistLinks(
  playlists: PlaylistLink[] | null | undefined
): PlaylistLink[] {
  if (!Array.isArray(playlists) || playlists.length === 0) return [];
  return [...playlists].sort((a, b) =>
    String(a?.name ?? "").localeCompare(String(b?.name ?? ""), "nl", {
      sensitivity: "base",
      ignorePunctuation: true,
      numeric: true,
    })
  );
}

export function normalizeArtistOptions(options: ArtistOption[]) {
  const unique = new Map<string, ArtistOption>();
  for (const option of options) {
    if (!option?.id) continue;
    const name = String(option.name ?? "").trim();
    if (!name) continue;
    unique.set(option.id, {
      id: option.id,
      name,
      spotifyUrl: option.spotifyUrl || `https://open.spotify.com/artist/${option.id}`,
    });
  }
  return Array.from(unique.values()).sort((a, b) =>
    a.name.localeCompare(b.name, "nl", {
      sensitivity: "base",
      ignorePunctuation: true,
      numeric: true,
    })
  );
}

export function resolveTrackItemArtistNames(track: TrackItem) {
  return (
    dedupeArtistText(
      (Array.isArray(track.artists) ? track.artists : [])
        .map((artist) => artist?.name)
        .filter(Boolean)
        .join(", ")
    ) || "Unknown artist"
  );
}

export function resolveTrackRowArtistNames(track: TrackRow) {
  return dedupeArtistText(track.artists || "") || "Unknown artist";
}

export function createAlbumOptionId(track: TrackItem, artistNames: string) {
  const albumId =
    typeof track.album?.id === "string" && track.album.id.trim()
      ? track.album.id.trim()
      : null;
  if (albumId) return `id:${albumId}`;
  const albumName = String(track.album?.name ?? "").trim();
  return `meta:${normalizeTrackName(albumName)}::${normalizeTrackName(artistNames)}`;
}

export function createAlbumOptionIdFromTrackRow(track: TrackRow) {
  const albumId =
    typeof track.albumId === "string" && track.albumId.trim()
      ? track.albumId.trim()
      : null;
  if (albumId) return `id:${albumId}`;
  const albumName = String(track.albumName ?? "").trim();
  if (!albumName) return null;
  return `meta:${normalizeTrackName(albumName)}::${normalizeTrackName(
    resolveTrackRowArtistNames(track)
  )}`;
}

export function createTrackItemFromTrackRow(track: TrackRow): TrackItem {
  const trackId =
    typeof track.trackId === "string" && track.trackId.trim()
      ? track.trackId.trim()
      : null;
  const fallbackId = [
    "row",
    normalizeTrackName(track.name),
    normalizeTrackName(track.albumName),
    normalizeTrackName(track.artists),
    typeof track.durationMs === "number" ? String(track.durationMs) : "",
  ]
    .filter(Boolean)
    .join(":");
  const itemId =
    trackId ||
    (typeof track.id === "string" && track.id.trim() ? track.id.trim() : fallbackId);
  const artistNames = resolveTrackRowArtistNames(track);
  const artists = artistNames
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((name, index) => ({
      id: `name:${normalizeTrackName(name) || String(index)}`,
      name,
    }));
  const coverUrl = track.coverUrl || track.albumImageUrl || null;
  return {
    id: itemId || `row:${Date.now()}`,
    trackId,
    name: String(track.name ?? "Unknown"),
    artists,
    album: {
      id: track.albumId ?? null,
      name: track.albumName ?? null,
      images: coverUrl ? [{ url: coverUrl }] : [],
      release_date: track.albumReleaseDate ?? null,
    },
    releaseYear: track.releaseYear ?? null,
    durationMs: track.durationMs ?? null,
    explicit: track.explicit ?? null,
    isLocal: track.isLocal ?? null,
    restrictionsReason: track.restrictionsReason ?? null,
    linkedFromTrackId: track.linkedFromTrackId ?? null,
    popularity: track.popularity ?? null,
    albumImageUrl: track.albumImageUrl ?? null,
    playlists: sortPlaylistLinks(track.playlists),
  };
}

export function isTrackItem(value: TrackRow | TrackItem): value is TrackItem {
  return Array.isArray((value as TrackItem).artists);
}

export function normalizeAlbumOptions(items: TrackItem[]) {
  const unique = new Map<string, AlbumOption>();
  for (const track of items) {
    const albumName = String(track.album?.name ?? "").trim() || "Unknown album";
    const artistNames = resolveTrackItemArtistNames(track);
    const key = createAlbumOptionId(track, artistNames);
    const coverUrl = track.album?.images?.[0]?.url ?? track.albumImageUrl ?? null;
    const albumId =
      typeof track.album?.id === "string" && track.album.id.trim()
        ? track.album.id.trim()
        : null;
    const candidate: AlbumOption = {
      id: key,
      name: `${albumName} — ${artistNames}`,
      albumName,
      artistNames,
      spotifyUrl: albumId
        ? `https://open.spotify.com/album/${albumId}`
        : track.id
          ? `https://open.spotify.com/track/${track.id}`
          : "https://open.spotify.com",
      coverUrl,
    };
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, candidate);
      continue;
    }
    const prefersCandidateArtistNames =
      candidate.artistNames.length > 0 &&
      (existing.artistNames.length === 0 ||
        candidate.artistNames.length < existing.artistNames.length);
    if (prefersCandidateArtistNames || (!existing.coverUrl && candidate.coverUrl)) {
      unique.set(key, {
        ...existing,
        ...candidate,
        coverUrl: existing.coverUrl ?? candidate.coverUrl,
      });
    }
  }
  return Array.from(unique.values()).sort((a, b) => {
    const byAlbum = a.albumName.localeCompare(b.albumName, "nl", {
      sensitivity: "base",
      ignorePunctuation: true,
      numeric: true,
    });
    if (byAlbum !== 0) return byAlbum;
    return a.artistNames.localeCompare(b.artistNames, "nl", {
      sensitivity: "base",
      ignorePunctuation: true,
      numeric: true,
    });
  });
}

export function normalizePlaylistOptions(options: PlaylistOption[]) {
  const liked = options.find((option) => option.id === LIKED_OPTION.id) ?? null;
  const allMusic = options.find((option) => option.id === ALL_MY_MUSIC_OPTION.id) ?? null;
  const unique = new Map<string, PlaylistOption>();
  unique.set(LIKED_OPTION.id, { ...LIKED_OPTION, ...(liked ?? {}) });
  unique.set(ALL_MY_MUSIC_OPTION.id, {
    ...ALL_MY_MUSIC_OPTION,
    ...(allMusic ?? {}),
  });
  for (const option of options) {
    if (!option?.id) continue;
    if (option.id === LIKED_OPTION.id || option.id === ALL_MY_MUSIC_OPTION.id) continue;
    unique.set(option.id, option);
  }
  const sorted = Array.from(unique.values())
    .filter(
      (option) => option.id !== LIKED_OPTION.id && option.id !== ALL_MY_MUSIC_OPTION.id
    )
    .sort((a, b) =>
      String(a.name ?? "").localeCompare(String(b.name ?? ""), "nl", {
        sensitivity: "base",
        ignorePunctuation: true,
        numeric: true,
      })
    );
  return [
    unique.get(LIKED_OPTION.id) ?? LIKED_OPTION,
    unique.get(ALL_MY_MUSIC_OPTION.id) ?? ALL_MY_MUSIC_OPTION,
    ...sorted,
  ];
}

export function toPlaylistLink(option: PlaylistOption): PlaylistLink {
  return option.type === "liked"
    ? {
        id: "liked",
        name: "Liked Songs",
        spotifyUrl: "https://open.spotify.com/collection/tracks",
      }
    : option.type === "all_music"
      ? {
          id: option.id,
          name: option.name,
          spotifyUrl: option.spotifyUrl || "https://open.spotify.com",
        }
      : {
          id: option.id,
          name: option.name,
          spotifyUrl:
            option.spotifyUrl || `https://open.spotify.com/playlist/${option.id}`,
        };
}
