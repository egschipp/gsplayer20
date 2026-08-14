import type { PlaylistLink, TrackItem, TrackOption, TrackRow } from "./types";
import { normalizeTrackName, sortPlaylistLinks } from "./normalizers";

function pickPreferredText(
  current: string | null | undefined,
  incoming: string | null | undefined
): string | null {
  if (typeof current === "string" && current.trim().length > 0) return current;
  if (typeof incoming === "string" && incoming.trim().length > 0) return incoming;
  return current ?? incoming ?? null;
}

function pickPreferredNumber(
  current: number | null | undefined,
  incoming: number | null | undefined
): number | null {
  if (typeof current === "number" && Number.isFinite(current)) return current;
  if (typeof incoming === "number" && Number.isFinite(incoming)) return incoming;
  return current ?? incoming ?? null;
}

function normalizePlaylistLink(link: PlaylistLink): PlaylistLink {
  const id = String(link.id ?? "").trim();
  const name = String(link.name ?? "").trim() || "Unknown playlist";
  const spotifyUrl =
    String(link.spotifyUrl ?? "").trim() ||
    (id === "liked"
      ? "https://open.spotify.com/collection/tracks"
      : `https://open.spotify.com/playlist/${id}`);
  return { id, name, spotifyUrl };
}

export function mergeTrackPlaylists(
  primary?: PlaylistLink[] | null,
  secondary?: PlaylistLink[] | null
) {
  const unique = new Map<string, PlaylistLink>();
  for (const source of [primary, secondary]) {
    for (const link of source ?? []) {
      if (!link?.id) continue;
      const normalized = normalizePlaylistLink(link);
      const existing = unique.get(normalized.id);
      if (!existing) {
        unique.set(normalized.id, normalized);
        continue;
      }
      unique.set(normalized.id, {
        id: existing.id,
        name: pickPreferredText(existing.name, normalized.name) ?? existing.name,
        spotifyUrl:
          pickPreferredText(existing.spotifyUrl, normalized.spotifyUrl) ??
          existing.spotifyUrl,
      });
    }
  }
  const merged = sortPlaylistLinks(Array.from(unique.values()));
  return merged.length ? merged : undefined;
}

export function mergeTrackRows(existing: TrackRow, incoming: TrackRow): TrackRow {
  return {
    ...existing,
    id: pickPreferredText(existing.id, incoming.id),
    itemId: pickPreferredText(existing.itemId, incoming.itemId),
    playlistId: pickPreferredText(existing.playlistId, incoming.playlistId),
    trackId: pickPreferredText(existing.trackId, incoming.trackId),
    name: pickPreferredText(existing.name, incoming.name),
    albumId: pickPreferredText(existing.albumId, incoming.albumId),
    albumName: pickPreferredText(existing.albumName, incoming.albumName),
    albumReleaseDate: pickPreferredText(
      existing.albumReleaseDate,
      incoming.albumReleaseDate
    ),
    releaseYear: pickPreferredNumber(existing.releaseYear, incoming.releaseYear),
    albumImageUrl: pickPreferredText(existing.albumImageUrl, incoming.albumImageUrl),
    coverUrl: pickPreferredText(existing.coverUrl, incoming.coverUrl),
    artists: pickPreferredText(existing.artists, incoming.artists),
    durationMs: pickPreferredNumber(existing.durationMs, incoming.durationMs),
    explicit: pickPreferredNumber(existing.explicit, incoming.explicit),
    isLocal: pickPreferredNumber(existing.isLocal, incoming.isLocal),
    restrictionsReason: pickPreferredText(
      existing.restrictionsReason,
      incoming.restrictionsReason
    ),
    linkedFromTrackId: pickPreferredText(
      existing.linkedFromTrackId,
      incoming.linkedFromTrackId
    ),
    popularity: pickPreferredNumber(existing.popularity, incoming.popularity),
    topRank: pickPreferredNumber(existing.topRank, incoming.topRank),
    lastPlayedAt: pickPreferredNumber(existing.lastPlayedAt, incoming.lastPlayedAt),
    addedAt: pickPreferredNumber(existing.addedAt, incoming.addedAt),
    addedBySpotifyUserId: pickPreferredText(
      existing.addedBySpotifyUserId,
      incoming.addedBySpotifyUserId
    ),
    position: pickPreferredNumber(existing.position, incoming.position),
    snapshotIdAtSync: pickPreferredText(
      existing.snapshotIdAtSync,
      incoming.snapshotIdAtSync
    ),
    syncRunId: pickPreferredText(existing.syncRunId, incoming.syncRunId),
    playlists: mergeTrackPlaylists(existing.playlists, incoming.playlists),
  };
}

function mergeTrackItemArtists(
  primary?: Array<{ id: string; name: string }> | null,
  secondary?: Array<{ id: string; name: string }> | null
) {
  const unique = new Map<string, { id: string; name: string }>();
  for (const source of [primary, secondary]) {
    for (const artist of source ?? []) {
      const name = String(artist?.name ?? "").trim();
      const id = String(artist?.id ?? "").trim();
      if (!name && !id) continue;
      const key = id || `name:${normalizeTrackName(name)}`;
      if (unique.has(key)) continue;
      unique.set(key, { id: id || key, name: name || "Unknown artist" });
    }
  }
  return Array.from(unique.values());
}

export function mergeTrackItems(existing: TrackItem, incoming: TrackItem): TrackItem {
  const mergedPlaylists = mergeTrackPlaylists(existing.playlists, incoming.playlists);
  const existingAlbumImages = Array.isArray(existing.album?.images)
    ? existing.album.images
    : [];
  const incomingAlbumImages = Array.isArray(incoming.album?.images)
    ? incoming.album.images
    : [];
  return {
    ...existing,
    id: pickPreferredText(existing.id, incoming.id) ?? existing.id,
    trackId: pickPreferredText(existing.trackId, incoming.trackId),
    name: pickPreferredText(existing.name, incoming.name) ?? existing.name,
    artists: mergeTrackItemArtists(existing.artists, incoming.artists),
    album: {
      id: pickPreferredText(existing.album?.id, incoming.album?.id),
      name: pickPreferredText(existing.album?.name, incoming.album?.name),
      images: existingAlbumImages.length ? existingAlbumImages : incomingAlbumImages,
      release_date: pickPreferredText(
        existing.album?.release_date,
        incoming.album?.release_date
      ),
    },
    releaseYear: pickPreferredNumber(existing.releaseYear, incoming.releaseYear),
    durationMs: pickPreferredNumber(existing.durationMs, incoming.durationMs),
    explicit: pickPreferredNumber(existing.explicit, incoming.explicit),
    isLocal: pickPreferredNumber(existing.isLocal, incoming.isLocal),
    restrictionsReason: pickPreferredText(
      existing.restrictionsReason,
      incoming.restrictionsReason
    ),
    linkedFromTrackId: pickPreferredText(
      existing.linkedFromTrackId,
      incoming.linkedFromTrackId
    ),
    popularity: pickPreferredNumber(existing.popularity, incoming.popularity),
    albumImageUrl: pickPreferredText(existing.albumImageUrl, incoming.albumImageUrl),
    playlists: mergedPlaylists ?? [],
  };
}

export function mergeTrackOptions(prev: TrackOption[], items: TrackItem[]) {
  const unique = new Map<string, TrackOption>();
  for (const option of prev) unique.set(option.id, option);
  for (const track of items) {
    const name = String(track.name ?? "").trim();
    const key = normalizeTrackName(name);
    if (!key) continue;
    const coverUrl = track.album?.images?.[0]?.url ?? null;
    const option: TrackOption = {
      id: key,
      name,
      spotifyUrl: track.id
        ? `https://open.spotify.com/track/${track.id}`
        : "https://open.spotify.com",
      coverUrl,
      trackId: track.id ?? null,
    };
    const existing = unique.get(key);
    if (
      !existing ||
      (!existing.coverUrl && option.coverUrl) ||
      existing.name.length > name.length
    ) {
      unique.set(key, option);
    }
  }
  return Array.from(unique.values()).sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" })
  );
}
