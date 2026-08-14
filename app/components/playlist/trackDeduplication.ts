import type { TrackItem, TrackRow } from "./types";
import {
  isTrackItem,
  normalizeTrackName,
  resolveTrackItemArtistNames,
} from "./normalizers";
import { mergeTrackItems, mergeTrackPlaylists, mergeTrackRows } from "./trackCollections";
import { normalizeSpotifyTrackId, resolveTrackId } from "./trackMatching";

function normalizeTrackIdentity(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return normalizeSpotifyTrackId(raw);
}

export function resolveTrackRowCanonicalId(row: TrackRow) {
  return (
    normalizeTrackIdentity(row.trackId) ??
    normalizeTrackIdentity(row.id) ??
    normalizeTrackIdentity(row.linkedFromTrackId) ??
    null
  );
}

export function resolveTrackItemCanonicalId(item: TrackItem) {
  return (
    normalizeTrackIdentity(item.id) ??
    normalizeTrackIdentity(item.trackId) ??
    normalizeTrackIdentity(item.linkedFromTrackId) ??
    null
  );
}

export function resolveTrackSelectionKey(track: TrackRow | TrackItem | null | undefined) {
  if (!track) return null;
  return isTrackItem(track)
    ? resolveTrackItemCanonicalId(track)
    : resolveTrackRowCanonicalId(track);
}

export function collectPlaylistIdsFromTrack(track: TrackRow | TrackItem) {
  return new Set(
    (Array.isArray(track.playlists) ? track.playlists : [])
      .map((playlist) => String(playlist?.id ?? "").trim())
      .filter(Boolean)
  );
}

export function dedupeTracksForBulkApply(tracks: Array<TrackRow | TrackItem>) {
  const byId = new Map<string, TrackRow | TrackItem>();
  for (const track of tracks) {
    const trackId = resolveTrackId(track);
    if (trackId && !byId.has(trackId)) byId.set(trackId, track);
  }
  return Array.from(byId.values());
}

function buildTrackRowDedupeKey(row: TrackRow, index: number) {
  const canonicalTrackId = resolveTrackRowCanonicalId(row);
  const playlistId = String(row.playlistId ?? "").trim();
  if (canonicalTrackId) {
    return playlistId
      ? `playlist-track:${playlistId}:${canonicalTrackId}`
      : `track:${canonicalTrackId}`;
  }
  const itemId = String(row.itemId ?? "").trim();
  if (itemId) return `item:${itemId}`;
  if (playlistId && typeof row.position === "number" && Number.isFinite(row.position)) {
    return `playlist-pos:${playlistId}:${Math.max(0, Math.floor(row.position))}`;
  }
  const id = String(row.id ?? "").trim();
  if (id) return `id:${id}`;
  const fallback = [
    normalizeTrackName(row.name),
    normalizeTrackName(row.artists),
    normalizeTrackName(row.albumName),
    typeof row.durationMs === "number" ? String(row.durationMs) : "",
  ]
    .filter(Boolean)
    .join("|");
  return fallback ? `meta:${fallback}` : `row:${index}`;
}

export function dedupeTrackRows(rows: TrackRow[]) {
  if (!rows.length) return rows;
  const byKey = new Map<string, number>();
  const deduped: TrackRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const key = buildTrackRowDedupeKey(row, index);
    const existingIndex = byKey.get(key);
    if (existingIndex === undefined) {
      deduped.push({ ...row, playlists: mergeTrackPlaylists(row.playlists) });
      byKey.set(key, deduped.length - 1);
      continue;
    }
    deduped[existingIndex] = mergeTrackRows(deduped[existingIndex], row);
  }
  return deduped;
}

function buildTrackItemDedupeKey(item: TrackItem, index: number) {
  const canonicalTrackId = resolveTrackItemCanonicalId(item);
  if (canonicalTrackId) return `track:${canonicalTrackId}`;
  const fallback = [
    normalizeTrackName(item.name),
    normalizeTrackName(resolveTrackItemArtistNames(item)),
    normalizeTrackName(item.album?.name),
    typeof item.durationMs === "number" ? String(item.durationMs) : "",
  ]
    .filter(Boolean)
    .join("|");
  return fallback ? `meta:${fallback}` : `track-item:${index}`;
}

export function dedupeTrackItems(items: TrackItem[]) {
  if (!items.length) return items;
  const byKey = new Map<string, number>();
  const deduped: TrackItem[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const key = buildTrackItemDedupeKey(item, index);
    const existingIndex = byKey.get(key);
    if (existingIndex === undefined) {
      deduped.push({
        ...item,
        playlists: mergeTrackPlaylists(item.playlists) ?? [],
      });
      byKey.set(key, deduped.length - 1);
      continue;
    }
    deduped[existingIndex] = mergeTrackItems(deduped[existingIndex], item);
  }
  return deduped;
}
