"use client";

import Image from "next/image";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FixedSizeList as List, type ListChildComponentProps } from "react-window";
import { usePlayer } from "./player/PlayerProvider";
import ChatGptButton from "./playlist/ChatGptButton";
import PlaylistChips from "./playlist/PlaylistChips";
import {
  ALL_MY_MUSIC_OPTION,
  type AlbumOption,
  type ArtistDetail,
  type ArtistOption,
  type Mode,
  type PlaylistLink,
  type PlaylistOption,
  type TrackDetail,
  type TrackItem,
  type TrackOption,
  type TrackRow,
  LIKED_OPTION,
} from "./playlist/types";
import {
  dedupeArtistText,
  dedupeArtists,
  formatDuration,
  formatExplicit,
  formatTimestamp,
} from "./playlist/utils";
import { mapSpotifyApiError } from "./playlist/errors";
import { formatTrackMeta } from "@/lib/chatgpt/trackMeta";
import { useStableMenu } from "@/lib/hooks/useStableMenu";
import { useQueueStore } from "@/lib/queue/QueueProvider";
import {
  TRACK_GRID_COLUMNS_COMPACT,
  TRACK_GRID_COLUMNS_FULL,
  TRACK_ROW_HEIGHT,
} from "@/lib/ui/trackLayout";

function resolveTrackId(track: TrackRow | TrackItem | null | undefined) {
  if (!track) return null;
  if ("trackId" in track && typeof track.trackId === "string" && track.trackId) {
    return track.trackId;
  }
  if ("id" in track && typeof track.id === "string" && track.id) {
    return track.id;
  }
  return null;
}

function buildQueueTrackInput(track: TrackRow | TrackItem) {
  const trackId = resolveTrackId(track);
  if (!trackId) return null;
  const artists =
    "artists" in track
      ? Array.isArray(track.artists)
        ? dedupeArtistText(
            track.artists.map((artist) => artist?.name).filter(Boolean).join(", ")
          ) || "Onbekende artiest"
        : dedupeArtistText(track.artists || "") || "Onbekende artiest"
      : "Onbekende artiest";
  const artworkUrl =
    "album" in track
      ? track.album?.images?.[0]?.url ?? track.albumImageUrl ?? null
      : track.coverUrl ?? track.albumImageUrl ?? null;
  const explicitValueRaw =
    typeof track.explicit === "boolean"
      ? track.explicit
        ? 1
        : 0
      : typeof track.explicit === "number"
      ? track.explicit
      : null;
  const playlists =
    "playlists" in track && Array.isArray(track.playlists)
      ? sortPlaylistLinks(
          track.playlists
            .filter((playlist) => Boolean(playlist?.id))
            .map((playlist) => ({
              id: playlist.id,
              name: playlist.name || "Onbekende playlist",
              spotifyUrl:
                playlist.spotifyUrl ??
                (playlist.id === "liked"
                  ? "https://open.spotify.com/collection/tracks"
                  : `https://open.spotify.com/playlist/${playlist.id}`),
            }))
        )
      : [];
  return {
    uri: `spotify:track:${trackId}`,
    trackId,
    name: track.name || "Onbekend",
    artists,
    durationMs: track.durationMs ?? null,
    explicit:
      explicitValueRaw === null || explicitValueRaw === undefined
        ? null
        : explicitValueRaw
        ? 1
        : 0,
    artworkUrl,
    playlists,
  };
}

function normalizeTrackName(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("nl");
}

const LEADING_EMOJI_PATTERN =
  /^[\s\u200B-\u200D\u200E\u200F\u2060\uFEFF]*(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]{2}|[#*0-9]\uFE0F?\u20E3)/u;

function startsWithEmoji(value: string | null | undefined) {
  return LEADING_EMOJI_PATTERN.test(String(value ?? ""));
}

function sortPlaylistLinks(playlists: PlaylistLink[] | null | undefined): PlaylistLink[] {
  if (!Array.isArray(playlists) || playlists.length === 0) return [];
  return [...playlists].sort((a, b) =>
    String(a?.name ?? "").localeCompare(String(b?.name ?? ""), "nl", {
      sensitivity: "base",
      ignorePunctuation: true,
      numeric: true,
    })
  );
}

function normalizeArtistOptions(options: ArtistOption[]) {
  const unique = new Map<string, ArtistOption>();
  for (const option of options) {
    if (!option?.id) continue;
    const name = String(option.name ?? "").trim();
    if (!name) continue;
    unique.set(option.id, {
      id: option.id,
      name,
      spotifyUrl:
        option.spotifyUrl || `https://open.spotify.com/artist/${option.id}`,
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

function resolveTrackItemArtistNames(track: TrackItem) {
  return (
    dedupeArtistText(
      (Array.isArray(track.artists) ? track.artists : [])
        .map((artist) => artist?.name)
        .filter(Boolean)
        .join(", ")
    ) || "Onbekende artiest"
  );
}

function createAlbumOptionId(track: TrackItem, artistNames: string) {
  const albumId =
    typeof track.album?.id === "string" && track.album.id.trim()
      ? track.album.id.trim()
      : null;
  if (albumId) return `id:${albumId}`;
  const albumName = String(track.album?.name ?? "").trim();
  return `meta:${normalizeTrackName(albumName)}::${normalizeTrackName(artistNames)}`;
}

function normalizeAlbumOptions(items: TrackItem[]) {
  const unique = new Map<string, AlbumOption>();
  for (const track of items) {
    const albumName = String(track.album?.name ?? "").trim() || "Onbekend album";
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

function normalizePlaylistOptions(options: PlaylistOption[]) {
  const likedFromOptions =
    options.find((option) => option.id === LIKED_OPTION.id) ?? null;
  const allMyMusicFromOptions =
    options.find((option) => option.id === ALL_MY_MUSIC_OPTION.id) ?? null;
  const unique = new Map<string, PlaylistOption>();
  unique.set(LIKED_OPTION.id, {
    ...LIKED_OPTION,
    ...(likedFromOptions ?? {}),
  });
  unique.set(ALL_MY_MUSIC_OPTION.id, {
    ...ALL_MY_MUSIC_OPTION,
    ...(allMyMusicFromOptions ?? {}),
  });
  for (const option of options) {
    if (!option?.id) continue;
    if (option.id === LIKED_OPTION.id) continue;
    if (option.id === ALL_MY_MUSIC_OPTION.id) continue;
    unique.set(option.id, option);
  }
  const sorted = Array.from(unique.values())
    .filter(
      (option) =>
        option.id !== LIKED_OPTION.id && option.id !== ALL_MY_MUSIC_OPTION.id
    )
    .sort((a, b) =>
      String(a.name ?? "").localeCompare(String(b.name ?? ""), "nl", {
        sensitivity: "base",
        ignorePunctuation: true,
        numeric: true,
      })
    );
  return [LIKED_OPTION, ALL_MY_MUSIC_OPTION, ...sorted];
}

function toPlaylistLink(option: PlaylistOption): PlaylistLink {
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
        spotifyUrl: option.spotifyUrl || `https://open.spotify.com/playlist/${option.id}`,
      };
}

function safeReadStorage(storage: Storage, key: string) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeWriteStorage(storage: Storage, key: string, value: string) {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemoveStorageKey(storage: Storage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // ignore storage issues
  }
}

function buildApiUrl(
  path: string,
  params?: Record<string, string | null | undefined>
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value == null || value === "") continue;
    query.set(key, value);
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableElements(root: HTMLElement | null) {
  if (!root) return [] as HTMLElement[];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement
  );
}

function trapTabWithin(event: KeyboardEvent, root: HTMLElement | null) {
  if (event.key !== "Tab" || !root) return;
  const focusable = getFocusableElements(root);
  if (focusable.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey) {
    if (active === first || !active || !root.contains(active)) {
      event.preventDefault();
      last.focus();
    }
    return;
  }
  if (active === last) {
    event.preventDefault();
    first.focus();
  }
}

function mapTrackApiItems(items: TrackApiItem[]): TrackItem[] {
  return items.map((track): TrackItem => ({
    id: String(track.id ?? track.trackId ?? ""),
    trackId: track.trackId ?? null,
    name: String(track.name ?? ""),
    artists: Array.isArray(track.artists)
      ? track.artists
          .filter((artist): artist is { id: string; name: string } => {
            return Boolean(artist?.id && artist?.name);
          })
          .map((artist) => ({ id: artist.id, name: artist.name }))
      : [],
    album: {
      id: track.album?.id ?? null,
      name: track.album?.name ?? null,
      images: Array.isArray(track.album?.images) ? track.album?.images : [],
      release_date: track.album?.release_date ?? null,
    },
    releaseYear: typeof track.releaseYear === "number" ? track.releaseYear : null,
    durationMs: track.durationMs ?? null,
    explicit:
      typeof track.explicit === "boolean"
        ? track.explicit
          ? 1
          : 0
        : track.explicit ?? null,
    isLocal:
      typeof track.isLocal === "number"
        ? track.isLocal
        : typeof track.isLocal === "boolean"
        ? track.isLocal
          ? 1
          : 0
        : null,
    restrictionsReason:
      typeof track.restrictionsReason === "string"
        ? track.restrictionsReason
        : null,
    linkedFromTrackId:
      typeof track.linkedFromTrackId === "string"
        ? track.linkedFromTrackId
        : null,
    popularity: track.popularity ?? null,
    albumImageUrl: track.albumImageUrl ?? null,
    playlists: Array.isArray(track.playlists)
      ? sortPlaylistLinks(
          track.playlists
            .filter((pl): pl is { id: string; name: string; spotifyUrl?: string } =>
              Boolean(pl?.id && pl?.name)
            )
            .map((pl) => ({
              id: pl.id,
              name: pl.name,
              spotifyUrl: pl.spotifyUrl ?? `https://open.spotify.com/playlist/${pl.id}`,
            }))
        )
      : [],
  }));
}

function mapTrackItemToRow(track: TrackItem): TrackRow {
  const trackId =
    typeof track.trackId === "string" && track.trackId
      ? track.trackId
      : track.id;
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
              playlist.spotifyUrl ??
              (playlist.id === "liked"
                ? "https://open.spotify.com/collection/tracks"
                : `https://open.spotify.com/playlist/${playlist.id}`),
          }))
        )
      : [],
  };
}

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
  const name = String(link.name ?? "").trim() || "Onbekende playlist";
  const spotifyUrl =
    String(link.spotifyUrl ?? "").trim() ||
    (id === "liked"
      ? "https://open.spotify.com/collection/tracks"
      : `https://open.spotify.com/playlist/${id}`);
  return { id, name, spotifyUrl };
}

function mergeTrackPlaylists(
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

function mergeTrackRows(existing: TrackRow, incoming: TrackRow): TrackRow {
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

function buildTrackRowDedupeKey(row: TrackRow, index: number) {
  const trackId = String(row.trackId ?? "").trim();
  if (trackId) return `track:${trackId}`;
  const itemId = String(row.itemId ?? "").trim();
  if (itemId) return `item:${itemId}`;
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

function dedupeTrackRows(rows: TrackRow[]) {
  if (!rows.length) return rows;
  const byKey = new Map<string, number>();
  const deduped: TrackRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const key = buildTrackRowDedupeKey(row, index);
    const existingIndex = byKey.get(key);
    if (existingIndex === undefined) {
      deduped.push({
        ...row,
        playlists: mergeTrackPlaylists(row.playlists),
      });
      byKey.set(key, deduped.length - 1);
      continue;
    }
    deduped[existingIndex] = mergeTrackRows(deduped[existingIndex], row);
  }
  return deduped;
}

function mergeTrackOptions(prev: TrackOption[], items: TrackItem[]) {
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
    if (!existing) {
      unique.set(key, option);
    } else if (
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

export default function PlaylistBrowser() {
  const [mode, setMode] = useState<Mode>("playlists");
  const [playlistOptions, setPlaylistOptions] = useState<PlaylistOption[]>([]);
  const [artistOptions, setArtistOptions] = useState<ArtistOption[]>([]);
  const [trackOptions, setTrackOptions] = useState<TrackOption[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string>("");
  const [selectedArtistId, setSelectedArtistId] = useState<string>("");
  const [selectedTrackId, setSelectedTrackId] = useState<string>("");
  const [selectedAlbumId, setSelectedAlbumId] = useState<string>("");
  const [query, setQuery] = useState<string>("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [selectorDockPinned, setSelectorDockPinned] = useState(false);
  const [selectorDockHovered, setSelectorDockHovered] = useState(false);
  const [selectorDockManualOpen, setSelectorDockManualOpen] = useState(false);
  const [selectorDockHost, setSelectorDockHost] = useState<HTMLElement | null>(null);
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [trackItems, setTrackItems] = useState<TrackItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [playlistCursor, setPlaylistCursor] = useState<string | null>(null);
  const [artistCursor, setArtistCursor] = useState<string | null>(null);
  const [trackCursor, setTrackCursor] = useState<string | null>(null);
  const [loadingMorePlaylists, setLoadingMorePlaylists] = useState(false);
  const [loadingMoreArtists, setLoadingMoreArtists] = useState(false);
  const [loadingMoreTracks, setLoadingMoreTracks] = useState(false);
  const [loadingMoreTrackOptions, setLoadingMoreTrackOptions] = useState(false);
  const [loadingPlaylists, setLoadingPlaylists] = useState(true);
  const [loadingArtists, setLoadingArtists] = useState(false);
  const [loadingTracksList, setLoadingTracksList] = useState(false);
  const [loadingTracks, setLoadingTracks] = useState(false);
  const [selectedTrackDetail, setSelectedTrackDetail] = useState<TrackDetail | null>(
    null
  );
  const [selectedArtistDetail, setSelectedArtistDetail] =
    useState<ArtistDetail | null>(null);
  const [artistDetailLoading, setArtistDetailLoading] = useState(false);
  const [trackArtistsLoading, setTrackArtistsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [likedTracksTotal, setLikedTracksTotal] = useState<number | null>(null);
  const [allMyMusicTotal, setAllMyMusicTotal] = useState<number | null>(null);
  const [tracksRefreshToken, setTracksRefreshToken] = useState(0);
  const [addingTargetKey, setAddingTargetKey] = useState<string | null>(null);
  const [removingTargetKey, setRemovingTargetKey] = useState<string | null>(null);
  const { api: playerApi, currentTrackId } = usePlayer();
  const queue = useQueueStore();
  const comboListRef = useRef<HTMLDivElement | null>(null);
  const loadingMoreTracksRef = useRef(false);
  const MAX_PLAYLIST_CHIPS = 2;
  const [listHeight, setListHeight] = useState(560);
  const hydratedSelectionRef = useRef(false);
  const skipModeResetRef = useRef(true);
  const [tracksContextKey, setTracksContextKey] = useState<string | null>(null);
  const [pendingTracksContextKey, setPendingTracksContextKey] = useState<string | null>(
    null
  );
  const [likedRefreshNonce, setLikedRefreshNonce] = useState(0);
  const [cacheHydrated, setCacheHydrated] = useState(false);
  const hasCachedPlaylistsRef = useRef(false);
  const hasCachedArtistsRef = useRef(false);
  const hasCachedTrackOptionsRef = useRef(false);
  const artistsBootstrapDoneRef = useRef(false);
  const trackOptionsBootstrapDoneRef = useRef(false);
  const lastHandledRefreshTokenRef = useRef(0);
  const tracksLoadVersionRef = useRef(0);
  const forceLivePlaylistRefreshRef = useRef(false);
  const playlistTracksSourceLiveRef = useRef(false);
  const playlistAutoSyncAttemptRef = useRef<Record<string, number>>({});
  const cacheWriteBlockedRef = useRef(false);
  const cacheWriteTimerRef = useRef<number | null>(null);
  const trackDetailTriggerRef = useRef<HTMLElement | null>(null);
  const trackDetailDialogRef = useRef<HTMLDivElement | null>(null);
  const artistDetailDialogRef = useRef<HTMLDivElement | null>(null);
  const artistDetailRestoreFocusRef = useRef<HTMLElement | null>(null);
  const hydratingPlaylistTargetsRef = useRef(false);
  const comboMenu = useStableMenu<HTMLDivElement>({
    onClose: () => setOpen(false),
  });
  const CACHE_KEY = "gs_library_cache_v1";
  const LEGACY_SELECTOR_DOCK_KEY = "gs_selector_dock_open_v1";
  const SELECTOR_DOCK_PIN_KEY = "gs_selector_dock_pinned_v1";
  const selectorDockOpen =
    selectorDockPinned || selectorDockHovered || selectorDockManualOpen || open;
  const allPlaylistNames = useMemo(() => {
    return playlistOptions
      .map((pl) => pl.name || "Untitled playlist")
      .filter((name) => startsWithEmoji(name));
  }, [playlistOptions]);

  const applyAllMyMusicTotal = useCallback((nextTotal: number | null) => {
    setAllMyMusicTotal(nextTotal);
    setPlaylistOptions((prev) =>
      prev.map((option) =>
        option.id === ALL_MY_MUSIC_OPTION.id
          ? { ...option, tracksTotal: nextTotal }
          : option
      )
    );
  }, []);

  const closeTrackDetail = useCallback(() => {
    setSelectedTrackDetail(null);
    const trigger = trackDetailTriggerRef.current;
    trackDetailTriggerRef.current = null;
    if (!trigger) return;
    if (!document.contains(trigger)) return;
    window.requestAnimationFrame(() => {
      trigger.focus();
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    safeRemoveStorageKey(window.localStorage, LEGACY_SELECTOR_DOCK_KEY);
    const stored = safeReadStorage(window.localStorage, SELECTOR_DOCK_PIN_KEY);
    if (stored === "0") {
      setSelectorDockPinned(false);
    } else if (stored === "1") {
      setSelectorDockPinned(true);
    }
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const resolveDockHost = () => {
      const host = document.getElementById("player-library-dock-slot");
      if (host) {
        setSelectorDockHost(host);
        return true;
      }
      return false;
    };
    if (resolveDockHost()) return;
    const observer = new MutationObserver(() => {
      if (resolveDockHost()) {
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    safeWriteStorage(
      window.localStorage,
      SELECTOR_DOCK_PIN_KEY,
      selectorDockPinned ? "1" : "0"
    );
  }, [selectorDockPinned]);

  useEffect(() => {
    if (!selectorDockOpen) {
      setOpen(false);
    }
  }, [selectorDockOpen]);

  const emitLikedTracksUpdated = useCallback(
    (trackId: string, action: "added" | "removed") => {
      if (typeof window === "undefined") return;
      const at = Date.now();
      window.dispatchEvent(
        new CustomEvent("gs-liked-tracks-updated", {
          detail: { trackId, action, at },
        })
      );
      try {
        window.localStorage.setItem("gs_liked_tracks_updated_at", String(at));
      } catch {
        // ignore storage issues
      }
    },
    []
  );


  useEffect(() => {
    function handleResize() {
      if (typeof window === "undefined") return;
      const next = Math.min(720, Math.max(360, Math.round(window.innerHeight * 0.6)));
      setListHeight(next);
    }
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || hydratedSelectionRef.current) return;
    const stored = safeReadStorage(window.localStorage, "gs_playlist_selection");
    if (!stored) {
      hydratedSelectionRef.current = true;
      skipModeResetRef.current = false;
      return;
    }
    try {
      const parsed = JSON.parse(stored) as {
        mode?: Mode;
        playlistId?: string;
        artistId?: string;
        trackId?: string;
        albumId?: string;
      };
      if (parsed.mode) setMode(parsed.mode);
      if (parsed.playlistId) setSelectedPlaylistId(parsed.playlistId);
      if (parsed.artistId) setSelectedArtistId(parsed.artistId);
      if (parsed.trackId) setSelectedTrackId(parsed.trackId);
      if (parsed.albumId) setSelectedAlbumId(parsed.albumId);
    } catch {
      // ignore
    } finally {
      hydratedSelectionRef.current = true;
      skipModeResetRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onLikedUpdate = () => {
      setLikedRefreshNonce((prev) => prev + 1);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === "gs_liked_tracks_updated_at") {
        onLikedUpdate();
      }
    };
    window.addEventListener("gs-liked-tracks-updated", onLikedUpdate as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(
        "gs-liked-tracks-updated",
        onLikedUpdate as EventListener
      );
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = safeReadStorage(window.sessionStorage, CACHE_KEY);
    try {
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        playlistOptions?: PlaylistOption[];
        artistOptions?: ArtistOption[];
        trackOptions?: TrackOption[];
        trackItems?: TrackItem[];
        tracks?: TrackRow[];
        nextCursor?: string | null;
        playlistCursor?: string | null;
        artistCursor?: string | null;
        trackCursor?: string | null;
        tracksContextKey?: string | null;
      };
      if (Array.isArray(parsed.playlistOptions)) {
        hasCachedPlaylistsRef.current = parsed.playlistOptions.length > 0;
        setPlaylistOptions(normalizePlaylistOptions(parsed.playlistOptions));
        setLoadingPlaylists(false);
      }
      if (Array.isArray(parsed.artistOptions)) {
        const cachedArtists = normalizeArtistOptions(parsed.artistOptions);
        hasCachedArtistsRef.current = cachedArtists.length > 0;
        setArtistOptions(cachedArtists);
        setLoadingArtists(false);
      }
      if (Array.isArray(parsed.trackOptions)) {
        const unique = new Map<string, TrackOption>();
        for (const option of parsed.trackOptions) {
          const name = String(option?.name ?? "").trim();
          const key = normalizeTrackName(name);
          if (!key) continue;
          const normalized: TrackOption = {
            id: key,
            name,
            spotifyUrl:
              typeof option?.spotifyUrl === "string" && option.spotifyUrl
                ? option.spotifyUrl
                : "https://open.spotify.com",
            coverUrl: option?.coverUrl ?? null,
            trackId:
              typeof option?.trackId === "string" && option.trackId
                ? option.trackId
                : null,
          };
          const existing = unique.get(key);
          if (!existing) {
            unique.set(key, normalized);
          } else if (
            (!existing.coverUrl && normalized.coverUrl) ||
            existing.name.length > name.length
          ) {
            unique.set(key, normalized);
          }
        }
        const list = Array.from(unique.values()).sort((a, b) =>
          a.name.localeCompare(b.name, "en", { sensitivity: "base" })
        );
        hasCachedTrackOptionsRef.current = list.length > 0;
        setTrackOptions(list);
        setLoadingTracksList(false);
      }
      if (Array.isArray(parsed.trackItems)) setTrackItems(parsed.trackItems);
      if (Array.isArray(parsed.tracks)) setTracks(dedupeTrackRows(parsed.tracks));
      if (typeof parsed.nextCursor === "string" || parsed.nextCursor === null) {
        setNextCursor(parsed.nextCursor ?? null);
      }
      if (
        typeof parsed.playlistCursor === "string" ||
        parsed.playlistCursor === null
      ) {
        setPlaylistCursor(parsed.playlistCursor ?? null);
      }
      if (typeof parsed.artistCursor === "string" || parsed.artistCursor === null) {
        setArtistCursor(parsed.artistCursor ?? null);
      }
      if (typeof parsed.trackCursor === "string" || parsed.trackCursor === null) {
        setTrackCursor(parsed.trackCursor ?? null);
      }
      if (
        typeof parsed.tracksContextKey === "string" ||
        parsed.tracksContextKey === null
      ) {
        setTracksContextKey(parsed.tracksContextKey ?? null);
      }
    } catch {
      // ignore invalid cache
    } finally {
      setCacheHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!cacheHydrated) return;
    if (cacheWriteBlockedRef.current) return;
    if (cacheWriteTimerRef.current) {
      window.clearTimeout(cacheWriteTimerRef.current);
      cacheWriteTimerRef.current = null;
    }

    cacheWriteTimerRef.current = window.setTimeout(() => {
      const payload = {
        playlistOptions,
        artistOptions,
        trackOptions,
        trackItems,
        tracks,
        nextCursor,
        playlistCursor,
        artistCursor,
        trackCursor,
        tracksContextKey,
      };
      const full = JSON.stringify(payload);
      if (safeWriteStorage(window.sessionStorage, CACHE_KEY, full)) return;

      // Fallback cache for browsers with low storage quota (e.g. mobile Safari).
      const compactPayload = {
        playlistOptions: playlistOptions.slice(0, 500),
        artistOptions: artistOptions.slice(0, 500),
        trackOptions: trackOptions.slice(0, 900),
        trackItems: [] as TrackItem[],
        tracks: [] as TrackRow[],
        nextCursor: null as string | null,
        playlistCursor,
        artistCursor,
        trackCursor,
        tracksContextKey: null as string | null,
      };
      const compact = JSON.stringify(compactPayload);
      if (safeWriteStorage(window.sessionStorage, CACHE_KEY, compact)) return;

      safeRemoveStorageKey(window.sessionStorage, CACHE_KEY);
      cacheWriteBlockedRef.current = true;
    }, 350);

    return () => {
      if (cacheWriteTimerRef.current) {
        window.clearTimeout(cacheWriteTimerRef.current);
        cacheWriteTimerRef.current = null;
      }
    };
  }, [
    artistCursor,
    artistOptions,
    cacheHydrated,
    nextCursor,
    playlistCursor,
    playlistOptions,
    trackCursor,
    trackItems,
    trackOptions,
    tracks,
    tracksContextKey,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload = JSON.stringify({
      mode,
      playlistId: selectedPlaylistId,
      artistId: selectedArtistId,
      trackId: selectedTrackId,
      albumId: selectedAlbumId,
    });
    safeWriteStorage(window.localStorage, "gs_playlist_selection", payload);
  }, [mode, selectedPlaylistId, selectedArtistId, selectedTrackId, selectedAlbumId]);

  useEffect(() => {
    let cancelled = false;
    async function loadPlaylists() {
      const hasCachedPlaylists = hasCachedPlaylistsRef.current;
      if (!hasCachedPlaylists) {
        setLoadingPlaylists(true);
      } else {
        setLoadingPlaylists(false);
      }
      setError(null);
      setAuthRequired(false);
      try {
        const res = await fetch(
          buildApiUrl("/api/spotify/me/playlists", { limit: "100", live: "1" }),
          { cache: "no-store" }
        );
        if (!res.ok) {
          const mapped = mapSpotifyApiError(res.status, "Playlists laden lukt nu niet.");
          if (!cancelled && !hasCachedPlaylists) {
            setAuthRequired(Boolean(mapped.authRequired));
            setError(mapped.message);
          }
          return;
        }
        const data = (await res.json()) as CursorResponse<PlaylistApiItem>;
        const items = Array.isArray(data.items) ? data.items : [];
        const mappedItems = items.map(
          (p): PlaylistOption => ({
            id: p.playlistId,
            name: p.name,
            type: "playlist",
            spotifyUrl: `https://open.spotify.com/playlist/${p.playlistId}`,
            tracksTotal: typeof p.tracksTotal === "number" ? p.tracksTotal : null,
            ownerDisplayName: p.ownerDisplayName ?? null,
            description: p.description ?? null,
            imageUrl: p.imageUrl ?? null,
          })
        );
        if (!cancelled) {
          hasCachedPlaylistsRef.current = hasCachedPlaylists || mappedItems.length > 0;
          setPlaylistOptions((prev) =>
            normalizePlaylistOptions((hasCachedPlaylists ? prev : []).concat(mappedItems))
          );
          setPlaylistCursor(data.nextCursor ?? null);
        }
      } catch {
        if (!cancelled && !hasCachedPlaylists) {
          setError("Playlists laden lukt nu niet.");
        }
      } finally {
        if (!cancelled) setLoadingPlaylists(false);
      }
    }
    loadPlaylists();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedPlaylistId || loadingPlaylists) return;
    const exists = playlistOptions.some((option) => option.id === selectedPlaylistId);
    if (!exists) setSelectedPlaylistId("");
  }, [loadingPlaylists, playlistOptions, selectedPlaylistId]);

  useEffect(() => {
    const shouldLoadArtists = mode === "artists" || Boolean(selectedArtistId);
    if (!shouldLoadArtists) return;
    if (artistsBootstrapDoneRef.current) return;
    let cancelled = false;
    async function loadArtists() {
      const hasCachedArtists = hasCachedArtistsRef.current;
      if (!hasCachedArtists) {
        setLoadingArtists(true);
      } else {
        setLoadingArtists(false);
      }
      try {
        const res = await fetch(
          buildApiUrl("/api/spotify/artists", {
            limit: "100",
          }),
          { cache: "no-store" }
        );
        if (!res.ok) {
          const mapped = mapSpotifyApiError(res.status, "Artiesten laden lukt nu niet.");
          if (!cancelled && !hasCachedArtists) {
            setAuthRequired(Boolean(mapped.authRequired));
            setError(mapped.message);
          }
          return;
        }
        const data = (await res.json()) as CursorResponse<ArtistApiItem>;
        const items = Array.isArray(data.items) ? data.items : [];
        const mappedItems = items.map(
          (artist): ArtistOption => ({
            id: artist.artistId,
            name: artist.name,
            spotifyUrl: `https://open.spotify.com/artist/${artist.artistId}`,
          })
        );
        if (!cancelled) {
          artistsBootstrapDoneRef.current = true;
          setArtistOptions((prev) =>
            normalizeArtistOptions((hasCachedArtists ? prev : []).concat(mappedItems))
          );
          setArtistCursor(data.nextCursor ?? null);
          hasCachedArtistsRef.current = hasCachedArtists || mappedItems.length > 0;
        }
      } catch {
        if (!cancelled && !hasCachedArtists) {
          setError("Artiesten laden lukt nu niet.");
        }
      } finally {
        if (!cancelled) setLoadingArtists(false);
      }
    }
    loadArtists();
    return () => {
      cancelled = true;
    };
  }, [mode, selectedArtistId]);

  useEffect(() => {
    if (!selectedArtistId || loadingArtists) return;
    const exists = artistOptions.some((option) => option.id === selectedArtistId);
    if (!exists) setSelectedArtistId("");
  }, [artistOptions, loadingArtists, selectedArtistId]);

  useEffect(() => {
    const shouldLoadTrackSelectors =
      mode === "tracks" ||
      mode === "albums" ||
      Boolean(selectedTrackId) ||
      Boolean(selectedAlbumId);
    if (!shouldLoadTrackSelectors) return;
    if (trackOptionsBootstrapDoneRef.current) return;
    let cancelled = false;
    async function loadTracksList() {
      const hasCachedTrackOptions = hasCachedTrackOptionsRef.current;
      setLoadingTracksList(!hasCachedTrackOptions);
      try {
        const res = await fetch(buildApiUrl("/api/spotify/tracks", { limit: "100" }), {
          cache: "no-store",
        });
        if (!res.ok) {
          const mapped = mapSpotifyApiError(res.status, "Tracks laden lukt nu niet.");
          if (!cancelled && !hasCachedTrackOptions) {
            setAuthRequired(Boolean(mapped.authRequired));
            setError(mapped.message);
          }
          return;
        }
        const data = (await res.json()) as CursorResponse<TrackApiItem>;
        const items = Array.isArray(data.items) ? data.items : [];
        const mappedItems = mapTrackApiItems(items);

        if (!cancelled) {
          trackOptionsBootstrapDoneRef.current = true;
          setTrackOptions((prev) =>
            mergeTrackOptions(hasCachedTrackOptions ? prev : [], mappedItems)
          );
          setTrackItems((prev) =>
            hasCachedTrackOptions ? prev.concat(mappedItems) : mappedItems
          );
          setTrackCursor(data.nextCursor ?? null);
          hasCachedTrackOptionsRef.current =
            hasCachedTrackOptions || mappedItems.length > 0;
        }
      } catch {
        if (!cancelled && !hasCachedTrackOptions) {
          setError("Tracks laden lukt nu niet.");
        }
      } finally {
        if (!cancelled) setLoadingTracksList(false);
      }
    }
    loadTracksList();
    return () => {
      cancelled = true;
    };
  }, [mode, selectedAlbumId, selectedTrackId]);

  const selectedPlaylist = useMemo(() => {
    if (!selectedPlaylistId) return null;
    return playlistOptions.find((opt) => opt.id === selectedPlaylistId) || null;
  }, [playlistOptions, selectedPlaylistId]);

  useEffect(() => {
    if (mode === "playlists" && selectedPlaylist?.type === "liked") return;
    setLikedTracksTotal(null);
  }, [mode, selectedPlaylist?.id, selectedPlaylist?.type]);

  useEffect(() => {
    if (!playlistOptions.length) return;
    if (allMyMusicTotal !== null) return;
    let cancelled = false;
    fetch("/api/spotify/me/all-music/count", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return null;
        const data = await res.json().catch(() => null);
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        if (typeof data?.totalCount !== "number" || !Number.isFinite(data.totalCount)) {
          return;
        }
        applyAllMyMusicTotal(Math.max(0, Math.floor(data.totalCount)));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [allMyMusicTotal, applyAllMyMusicTotal, playlistOptions.length]);

  const albumOptions = useMemo(() => {
    if (!trackItems.length) return [] as AlbumOption[];
    return normalizeAlbumOptions(trackItems);
  }, [trackItems]);

  const selectedArtist = useMemo(
    () => artistOptions.find((opt) => opt.id === selectedArtistId) || null,
    [artistOptions, selectedArtistId]
  );

  const selectedTrack = useMemo(() => {
    if (!selectedTrackId) return null;
    return trackOptions.find((opt) => opt.id === selectedTrackId) || null;
  }, [trackOptions, selectedTrackId]);

  const selectedAlbum = useMemo(() => {
    if (!selectedAlbumId) return null;
    return albumOptions.find((opt) => opt.id === selectedAlbumId) || null;
  }, [albumOptions, selectedAlbumId]);

  useEffect(() => {
    if (!selectedAlbumId || loadingTracksList) return;
    const exists = albumOptions.some((option) => option.id === selectedAlbumId);
    if (!exists) setSelectedAlbumId("");
  }, [albumOptions, loadingTracksList, selectedAlbumId]);

  const selectedOption =
    mode === "playlists"
      ? selectedPlaylist
      : mode === "artists"
      ? selectedArtist
      : mode === "tracks"
      ? selectedTrack
      : selectedAlbum;

  const selectorModeLabel =
    mode === "playlists"
      ? "Playlists"
      : mode === "artists"
      ? "Artiesten"
      : mode === "tracks"
      ? "Tracks"
      : "Albums";
  const selectorCurrentLabel = selectedOption?.name
    ? selectedOption.name
    : mode === "playlists"
    ? "Kies playlist"
    : mode === "artists"
    ? "Kies artiest"
    : mode === "tracks"
    ? "Kies track"
    : "Kies album";

  const selectPlaylistInMyMusic = useCallback((playlistId: string) => {
    if (!playlistId) return;
    setMode("playlists");
    setSelectedPlaylistId(playlistId);
    setSelectedArtistId("");
    setSelectedTrackId("");
    setSelectedAlbumId("");
    setQuery("");
    setDebouncedQuery("");
    setOpen(false);
  }, []);

  const triggerSelectedPlaylistLiveRefresh = useCallback(
    (playlistId: string) => {
      if (
        mode !== "playlists" ||
        selectedPlaylist?.type !== "playlist" ||
        !selectedPlaylist.id
      ) {
        return;
      }
      if (selectedPlaylist.id !== playlistId) return;
      forceLivePlaylistRefreshRef.current = true;
      setTracksRefreshToken((prev) => prev + 1);
    },
    [mode, selectedPlaylist?.id, selectedPlaylist?.type]
  );

  const addTargetOptions = useMemo(() => {
    const unique = new Map<string, PlaylistOption>();
    unique.set(LIKED_OPTION.id, LIKED_OPTION);
    for (const option of playlistOptions) {
      if (option.id === LIKED_OPTION.id) continue;
      if (!startsWithEmoji(option.name || "")) continue;
      unique.set(option.id, option);
    }
    return Array.from(unique.values()).sort((a, b) => {
      if (a.id === LIKED_OPTION.id) return -1;
      if (b.id === LIKED_OPTION.id) return 1;
      return a.name.localeCompare(b.name, "nl", {
        sensitivity: "base",
        ignorePunctuation: true,
        numeric: true,
      });
    });
  }, [playlistOptions]);

  const sortedPlaylists = useMemo(() => {
    if (!playlistOptions.length) return normalizePlaylistOptions([]);
    return normalizePlaylistOptions(playlistOptions);
  }, [playlistOptions]);

  const filteredOptions = useMemo(() => {
    const term = debouncedQuery.trim().toLowerCase();
    if (mode === "playlists") {
      if (!term) return sortedPlaylists;
      return sortedPlaylists.filter((opt) =>
        `${opt.name} ${opt.ownerDisplayName ?? ""} ${opt.description ?? ""}`
          .toLowerCase()
          .includes(term)
      );
    }
    const list =
      mode === "artists" ? artistOptions : mode === "tracks" ? trackOptions : albumOptions;
    if (!term) return list;
    return list.filter((opt) => opt.name.toLowerCase().includes(term));
  }, [sortedPlaylists, artistOptions, trackOptions, albumOptions, debouncedQuery, mode]);

  useEffect(() => {
    if (skipModeResetRef.current) return;
    setOpen(false);
    setQuery("");
    setDebouncedQuery("");
  }, [mode]);

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedQuery(query);
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  const filteredTrackItems = useMemo(() => {
    if (!selectedTrackId) return [];
    return trackItems.filter(
      (track) => normalizeTrackName(track.name) === selectedTrackId
    );
  }, [trackItems, selectedTrackId]);

  const selectedTrackDetailHasArtists = Boolean(selectedTrackDetail?.artists?.length);
  const selectedTrackDetailDialogKey = selectedTrackDetail
    ? selectedTrackDetail.trackId ??
      selectedTrackDetail.id ??
      selectedTrackDetail.itemId ??
      `__track-detail__:${selectedTrackDetail.name ?? ""}`
    : null;
  const selectedArtistDetailDialogKey = selectedArtistDetail
    ? selectedArtistDetail.artistId || "__artist-detail__"
    : null;

  const filteredAlbumTrackItems = useMemo(() => {
    if (!selectedAlbumId) return [];
    return trackItems.filter((track) => {
      const artistNames = resolveTrackItemArtistNames(track);
      return createAlbumOptionId(track, artistNames) === selectedAlbumId;
    });
  }, [trackItems, selectedAlbumId]);

  const localFilteredTrackItems =
    mode === "tracks" ? filteredTrackItems : filteredAlbumTrackItems;

  const isContextSwitchLoading = Boolean(
    loadingTracks &&
      pendingTracksContextKey &&
      pendingTracksContextKey !== tracksContextKey
  );

  const loadMorePlaylists = useCallback(async () => {
    if (!playlistCursor || loadingMorePlaylists) return;
    setLoadingMorePlaylists(true);
    try {
      const res = await fetch(
        buildApiUrl("/api/spotify/me/playlists", {
          limit: "50",
          cursor: playlistCursor,
          live: "1",
        }),
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const data = (await res.json()) as CursorResponse<PlaylistApiItem>;
      const items = Array.isArray(data.items) ? data.items : [];
      const mappedItems = items.map(
        (p): PlaylistOption => ({
          id: p.playlistId,
          name: p.name,
          type: "playlist",
          spotifyUrl: `https://open.spotify.com/playlist/${p.playlistId}`,
          tracksTotal:
            typeof p.tracksTotal === "number" ? p.tracksTotal : null,
          ownerDisplayName: p.ownerDisplayName ?? null,
          description: p.description ?? null,
          imageUrl: p.imageUrl ?? null,
        })
      );
      setPlaylistOptions((prev) => {
        return normalizePlaylistOptions(prev.concat(mappedItems));
      });
      setPlaylistCursor(data.nextCursor ?? null);
    } finally {
      setLoadingMorePlaylists(false);
    }
  }, [playlistCursor, loadingMorePlaylists]);

  const ensureAllPlaylistOptionsLoaded = useCallback(async () => {
    if (!playlistCursor) return;
    if (hydratingPlaylistTargetsRef.current) return;
    hydratingPlaylistTargetsRef.current = true;
    let cursor: string | null = playlistCursor;
    try {
      while (cursor) {
        const res = await fetch(
          buildApiUrl("/api/spotify/me/playlists", {
            limit: "100",
            cursor,
            live: "1",
          }),
          { cache: "no-store" }
        );
        if (!res.ok) break;
        const data = (await res.json()) as CursorResponse<PlaylistApiItem>;
        const items = Array.isArray(data.items) ? data.items : [];
        const mappedItems = items.map(
          (p): PlaylistOption => ({
            id: p.playlistId,
            name: p.name,
            type: "playlist",
            spotifyUrl: `https://open.spotify.com/playlist/${p.playlistId}`,
            tracksTotal: typeof p.tracksTotal === "number" ? p.tracksTotal : null,
            ownerDisplayName: p.ownerDisplayName ?? null,
            description: p.description ?? null,
            imageUrl: p.imageUrl ?? null,
          })
        );
        setPlaylistOptions((prev) => normalizePlaylistOptions(prev.concat(mappedItems)));
        cursor = data.nextCursor ?? null;
        setPlaylistCursor(cursor);
      }
    } finally {
      hydratingPlaylistTargetsRef.current = false;
    }
  }, [playlistCursor]);

  const loadMoreArtists = useCallback(async () => {
    if (!artistCursor || loadingMoreArtists) return;
    setLoadingMoreArtists(true);
    try {
      const res = await fetch(
        buildApiUrl("/api/spotify/artists", {
          limit: "50",
          cursor: artistCursor,
        }),
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const data = (await res.json()) as CursorResponse<ArtistApiItem>;
      const items = Array.isArray(data.items) ? data.items : [];
      const mappedItems = items.map(
          (artist): ArtistOption => ({
            id: artist.artistId,
            name: artist.name,
            spotifyUrl: `https://open.spotify.com/artist/${artist.artistId}`,
          })
        );
      setArtistOptions((prev) => normalizeArtistOptions(prev.concat(mappedItems)));
      setArtistCursor(data.nextCursor ?? null);
    } finally {
      setLoadingMoreArtists(false);
    }
  }, [artistCursor, loadingMoreArtists]);

  const loadMoreTrackOptions = useCallback(async () => {
    if (!trackCursor || loadingMoreTrackOptions) return;
    setLoadingMoreTrackOptions(true);
    try {
      const res = await fetch(
        buildApiUrl("/api/spotify/tracks", {
          limit: "100",
          cursor: trackCursor,
        }),
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const data = (await res.json()) as CursorResponse<TrackApiItem>;
      const items = Array.isArray(data.items) ? data.items : [];
      const mappedItems = mapTrackApiItems(items);
      setTrackItems((prev) => {
        const seen = new Set<string>();
        const combined: TrackItem[] = [];
        const pushUnique = (item: TrackItem) => {
          const key = item.id || item.trackId || "";
          if (!key || seen.has(key)) return;
          seen.add(key);
          combined.push(item);
        };
        for (const item of prev) pushUnique(item);
        for (const item of mappedItems) pushUnique(item);
        return combined;
      });
      setTrackOptions((prev) => mergeTrackOptions(prev, mappedItems));
      setTrackCursor(data.nextCursor ?? null);
    } finally {
      setLoadingMoreTrackOptions(false);
    }
  }, [loadingMoreTrackOptions, trackCursor]);

  useEffect(() => {
    const term = debouncedQuery.trim();
    const shouldPrefetchBySearch = open && term.length >= 2;
    if (!shouldPrefetchBySearch) return;
    if (
      shouldPrefetchBySearch &&
      mode === "playlists" &&
      playlistCursor &&
      !loadingMorePlaylists
    ) {
      loadMorePlaylists();
    }
    if (
      shouldPrefetchBySearch &&
      mode === "artists" &&
      artistCursor &&
      !loadingMoreArtists
    ) {
      loadMoreArtists();
    }
    if (
      shouldPrefetchBySearch &&
      (mode === "tracks" || mode === "albums") &&
      trackCursor &&
      !loadingMoreTrackOptions
    ) {
      loadMoreTrackOptions();
    }
  }, [
    debouncedQuery,
    open,
    mode,
    playlistCursor,
    artistCursor,
    trackCursor,
    loadingMorePlaylists,
    loadingMoreArtists,
    loadingMoreTrackOptions,
    loadMorePlaylists,
    loadMoreArtists,
    loadMoreTrackOptions,
  ]);


  function openDetailFromRow(track: TrackRow, trigger?: HTMLElement | null) {
    if (trigger) {
      trackDetailTriggerRef.current = trigger;
    }
    const spotifyUrl = track.trackId
      ? `https://open.spotify.com/track/${track.trackId}`
      : null;
    setSelectedTrackDetail({
      id: track.trackId ?? null,
      itemId: track.itemId ?? null,
      playlistId: track.playlistId ?? null,
      trackId: track.trackId ?? null,
      name: track.name ?? null,
      artistsText: dedupeArtistText(track.artists ?? null) || null,
      artists: [],
      albumId: track.albumId ?? null,
      albumName: track.albumName ?? null,
      albumImageUrl: track.albumImageUrl ?? null,
      coverUrl: track.coverUrl ?? null,
      durationMs: track.durationMs ?? null,
      explicit: track.explicit ?? null,
      isLocal: track.isLocal ?? null,
      restrictionsReason: track.restrictionsReason ?? null,
      linkedFromTrackId: track.linkedFromTrackId ?? null,
      popularity: track.popularity ?? null,
      topRank: null,
      lastPlayedAt: null,
      addedAt: track.addedAt ?? null,
      addedBySpotifyUserId: track.addedBySpotifyUserId ?? null,
      position: track.position ?? null,
      snapshotIdAtSync: track.snapshotIdAtSync ?? null,
      syncRunId: track.syncRunId ?? null,
      playlists: sortPlaylistLinks(track.playlists ?? []),
      spotifyUrl,
    });
  }

  function openDetailFromItem(track: TrackItem, trigger?: HTMLElement | null) {
    if (trigger) {
      trackDetailTriggerRef.current = trigger;
    }
    const coverUrl = track.album?.images?.[0]?.url ?? null;
    const spotifyUrl = track.id ? `https://open.spotify.com/track/${track.id}` : null;
    setSelectedTrackDetail({
      id: track.id ?? null,
      trackId: track.trackId ?? track.id ?? null,
      name: track.name ?? null,
      artists: dedupeArtists(track.artists ?? []),
      albumId: track.album?.id ?? null,
      albumName: track.album?.name ?? null,
      albumImageUrl: track.albumImageUrl ?? null,
      coverUrl,
      durationMs: track.durationMs ?? null,
      explicit: track.explicit ?? null,
      isLocal: track.isLocal ?? null,
      restrictionsReason: track.restrictionsReason ?? null,
      linkedFromTrackId: track.linkedFromTrackId ?? null,
      popularity: track.popularity ?? null,
      topRank: null,
      lastPlayedAt: null,
      playlists: sortPlaylistLinks(track.playlists ?? []),
      spotifyUrl,
    });
  }

  async function openArtistDetail(artistId?: string | null, name?: string | null) {
    if (!artistId) return;
    setArtistDetailLoading(true);
    setSelectedArtistDetail({
      artistId,
      name: name || "Unknown artist",
      genres: [],
      popularity: null,
      followersTotal: null,
      imageUrl: null,
      topRank: null,
      tracksCount: 0,
      spotifyUrl: `https://open.spotify.com/artist/${artistId}`,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`/api/spotify/artists/${artistId}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      let topRank: number | null = null;
      try {
        const topRes = await fetch(
          "/api/spotify/me/top?type=artists&time_range=medium_term&limit=50",
          {
            cache: "no-store",
            signal: controller.signal,
          }
        );
        if (topRes.ok) {
          const topData = await topRes.json();
          const topItems = Array.isArray(topData?.items) ? topData.items : [];
          const rankIndex = topItems.findIndex(
            (item: any) =>
              String(item?.id ?? "").trim() === String(data.artistId ?? artistId).trim()
          );
          topRank = rankIndex >= 0 ? rankIndex + 1 : null;
        }
      } catch {
        // ignore top-rank lookup failures
      }
      setSelectedArtistDetail({
        artistId: data.artistId ?? artistId,
        name: data.name ?? name ?? "Unknown artist",
        genres: Array.isArray(data.genres) ? data.genres : [],
        popularity:
          data.popularity === null || data.popularity === undefined
            ? null
            : Number(data.popularity),
        followersTotal:
          data.followersTotal === null || data.followersTotal === undefined
            ? null
            : Number(data.followersTotal),
        imageUrl: typeof data.imageUrl === "string" ? data.imageUrl : null,
        topRank,
        tracksCount: Number(data.tracksCount ?? 0),
        updatedAt: data.updatedAt ?? null,
        spotifyUrl: data.spotifyUrl ?? `https://open.spotify.com/artist/${artistId}`,
      });
    } catch {
      // keep placeholder detail state when upstream request fails
    } finally {
      clearTimeout(timeout);
      setArtistDetailLoading(false);
    }
  }

  useEffect(() => {
    if (!selectedTrackDetailDialogKey || selectedArtistDetailDialogKey) return;
    const dialog = trackDetailDialogRef.current;
    if (!dialog) return;
    const focusable = getFocusableElements(dialog);
    (focusable[0] ?? dialog).focus();
    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeTrackDetail();
        return;
      }
      trapTabWithin(event, dialog);
    };
    dialog.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      dialog.removeEventListener("keydown", handleDialogKeyDown);
    };
  }, [closeTrackDetail, selectedArtistDetailDialogKey, selectedTrackDetailDialogKey]);

  useEffect(() => {
    const trackId = selectedTrackDetail?.trackId ?? null;
    if (!trackId) {
      setTrackArtistsLoading(false);
      return;
    }
    if (selectedTrackDetailHasArtists) {
      setTrackArtistsLoading(false);
      return;
    }
    let cancelled = false;
    async function loadTrackArtists() {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const controller = new AbortController();
      try {
        setTrackArtistsLoading(true);
        timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(`/api/spotify/tracks/${trackId}/artists`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = await res.json();
        const artists = Array.isArray(data?.items)
          ? data.items
              .map((artist: any) => ({
                id: artist.artistId ?? artist.id ?? "",
                name: artist.name ?? "",
              }))
              .filter((artist: { id: string; name: string }) => artist.id || artist.name)
          : [];
        if (!cancelled) {
          setSelectedTrackDetail((prev) =>
            prev
              ? {
                  ...prev,
                  artists: dedupeArtists(artists),
                }
              : prev
          );
        }
      } catch {
        // ignore
      } finally {
        if (timeout) clearTimeout(timeout);
        if (!cancelled) setTrackArtistsLoading(false);
      }
    }
    loadTrackArtists();
    return () => {
      cancelled = true;
    };
  }, [selectedTrackDetail?.trackId, selectedTrackDetailHasArtists]);

  useEffect(() => {
    const trackId = selectedTrackDetail?.trackId ?? null;
    if (!trackId) return;
    let cancelled = false;
    const controller = new AbortController();

    async function loadTrackInsights() {
      let lastPlayedAt: number | null = null;
      let topRank: number | null = null;

      try {
        const [recentRes, topRes] = await Promise.all([
          fetch(
            `/api/spotify/me/recently-played?limit=50&trackId=${encodeURIComponent(
              String(trackId)
            )}`,
            {
              cache: "no-store",
              signal: controller.signal,
            }
          ),
          fetch("/api/spotify/me/top?type=tracks&time_range=medium_term&limit=50", {
            cache: "no-store",
            signal: controller.signal,
          }),
        ]);

        if (recentRes.ok) {
          const recentData = await recentRes.json();
          const recentItems = Array.isArray(recentData?.items) ? recentData.items : [];
          const recentTrack = recentItems.find(
            (item: any) =>
              String(item?.trackId ?? "").trim() === String(trackId).trim()
          );
          if (recentTrack?.playedAt) {
            const parsed = Number(recentTrack.playedAt);
            if (Number.isFinite(parsed)) {
              lastPlayedAt = parsed;
            }
          }
        }

        if (topRes.ok) {
          const topData = await topRes.json();
          const topItems = Array.isArray(topData?.items) ? topData.items : [];
          const rankIndex = topItems.findIndex(
            (item: any) => String(item?.id ?? "").trim() === String(trackId).trim()
          );
          topRank = rankIndex >= 0 ? rankIndex + 1 : null;
        }
      } catch {
        // ignore track insight lookup failures
      }

      if (!cancelled) {
        setSelectedTrackDetail((prev) =>
          prev && prev.trackId === trackId
            ? {
                ...prev,
                topRank,
                lastPlayedAt,
              }
            : prev
        );
      }
    }

    void loadTrackInsights();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedTrackDetail?.trackId]);

  useEffect(() => {
    if (!selectedArtistDetailDialogKey) return;
    artistDetailRestoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = artistDetailDialogRef.current;
    if (!dialog) return;
    const focusable = getFocusableElements(dialog);
    (focusable[0] ?? dialog).focus();
    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSelectedArtistDetail(null);
        return;
      }
      trapTabWithin(event, dialog);
    };
    dialog.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      dialog.removeEventListener("keydown", handleDialogKeyDown);
      const restore = artistDetailRestoreFocusRef.current;
      artistDetailRestoreFocusRef.current = null;
      if (restore && document.contains(restore)) {
        window.requestAnimationFrame(() => {
          restore.focus();
        });
      }
    };
  }, [selectedArtistDetailDialogKey]);

  useEffect(() => {
    let cancelled = false;
    const nextContextKey =
      mode === "playlists"
        ? selectedPlaylist?.id
          ? `playlist:${selectedPlaylist.type}:${selectedPlaylist.id}`
          : null
        : mode === "artists"
        ? selectedArtist?.id
          ? `artist:${selectedArtist.id}`
          : null
        : null;
    async function loadTracks() {
      const requestVersion = ++tracksLoadVersionRef.current;
      const forceLivePlaylistSource =
        mode === "playlists" &&
        selectedPlaylist?.type === "playlist" &&
        forceLivePlaylistRefreshRef.current;
      if (mode === "playlists" && selectedPlaylist?.type === "playlist") {
        playlistTracksSourceLiveRef.current = forceLivePlaylistSource;
      } else {
        playlistTracksSourceLiveRef.current = false;
      }
      setLoadingTracks(true);
      setError(null);
      try {
        if (mode === "playlists" && selectedPlaylist?.type === "all_music") {
          const MAX_PAGES = 120;
          let cursor: string | null = null;
          let page = 0;
          const seenTrackIds = new Set<string>();
          const collected: TrackItem[] = [];
          do {
            const cursorQuery = cursor
              ? `&cursor=${encodeURIComponent(cursor)}`
              : "";
            const res = await fetch(`/api/spotify/tracks?limit=100${cursorQuery}`, {
              cache: "no-store",
            });
            if (!res.ok) {
              const mapped = mapSpotifyApiError(
                res.status,
                "Tracks laden lukt nu niet."
              );
              if (!cancelled) {
                setAuthRequired(Boolean(mapped.authRequired));
                setError(mapped.message);
              }
              return;
            }
            const data = (await res.json()) as CursorResponse<TrackApiItem>;
            const pageItems = mapTrackApiItems(Array.isArray(data.items) ? data.items : []);
            for (const track of pageItems) {
              const trackId = track.trackId || track.id;
              if (!trackId || seenTrackIds.has(trackId)) continue;
              const hasEmojiPlaylist = Array.isArray(track.playlists)
                ? track.playlists.some((playlist) => startsWithEmoji(playlist?.name))
                : false;
              if (!hasEmojiPlaylist) continue;
              seenTrackIds.add(trackId);
              collected.push(track);
            }
            cursor = data.nextCursor ?? null;
            page += 1;
          } while (cursor && page < MAX_PAGES);
          const rows = collected.map((track) => mapTrackItemToRow(track));
          rows.sort((a, b) =>
            String(a.name ?? "").localeCompare(String(b.name ?? ""), "nl", {
              sensitivity: "base",
              ignorePunctuation: true,
              numeric: true,
            })
          );
          if (!cancelled && requestVersion === tracksLoadVersionRef.current) {
            setTracks(dedupeTrackRows(rows));
            setNextCursor(null);
            applyAllMyMusicTotal(rows.length);
            if (nextContextKey) setTracksContextKey(nextContextKey);
            setPendingTracksContextKey(null);
          }
          return;
        }

        const baseUrl =
          mode === "playlists"
            ? selectedPlaylist?.type === "liked"
              ? "/api/spotify/me/tracks?live=1"
              : forceLivePlaylistSource
              ? `/api/spotify/playlists/${selectedPlaylist?.id}/items?live=1`
              : `/api/spotify/playlists/${selectedPlaylist?.id}/items`
            : `/api/spotify/artists/${selectedArtist?.id}/tracks`;
        const connector = baseUrl.includes("?") ? "&" : "?";
        const res = await fetch(`${baseUrl}${connector}limit=50`, {
          cache: "no-store",
        });
        if (!res.ok) {
          const mapped = mapSpotifyApiError(res.status, "Tracks laden lukt nu niet.");
          if (!cancelled) {
            setAuthRequired(Boolean(mapped.authRequired));
            setError(mapped.message);
          }
          return;
        }
        const data = (await res.json()) as CursorResponse<TrackRow>;
        const items = Array.isArray(data.items) ? data.items : [];
        if (
          mode === "playlists" &&
          selectedPlaylist?.type === "playlist" &&
          selectedPlaylist.id &&
          items.length === 0
        ) {
          const now = Date.now();
          const lastAttempt = playlistAutoSyncAttemptRef.current[selectedPlaylist.id] ?? 0;
          if (now - lastAttempt > 30_000) {
            playlistAutoSyncAttemptRef.current[selectedPlaylist.id] = now;
            void fetch("/api/spotify/sync", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "playlist_items",
                payload: {
                  playlistId: selectedPlaylist.id,
                  offset: 0,
                  limit: 50,
                  maxPagesPerRun: 20,
                  runId: `auto-empty-${Date.now()}`,
                },
              }),
            }).catch(() => undefined);
            window.setTimeout(() => {
              setTracksRefreshToken((prev) => prev + 1);
            }, 1200);
          }
        }
        if (!cancelled && requestVersion === tracksLoadVersionRef.current) {
          setTracks(dedupeTrackRows(items));
          setNextCursor(data.nextCursor ?? null);
          if (mode === "playlists" && selectedPlaylist?.type === "liked") {
            const nextTotal =
              typeof data.totalCount === "number" && Number.isFinite(data.totalCount)
                ? Math.max(0, Math.floor(data.totalCount))
                : null;
            setLikedTracksTotal(nextTotal);
          } else {
            setLikedTracksTotal(null);
          }
          if (nextContextKey) setTracksContextKey(nextContextKey);
          setPendingTracksContextKey(null);
        }
      } catch {
        if (!cancelled && requestVersion === tracksLoadVersionRef.current) {
          setError("Tracks laden lukt nu niet.");
          setPendingTracksContextKey(null);
        }
      } finally {
        if (forceLivePlaylistSource && requestVersion === tracksLoadVersionRef.current) {
          forceLivePlaylistRefreshRef.current = false;
        }
        if (!cancelled && requestVersion === tracksLoadVersionRef.current) {
          setLoadingTracks(false);
        }
      }
    }

    if (mode === "tracks" || mode === "albums") return;

    if (mode === "artists" && !selectedArtist?.id) return;

    if (mode === "playlists" && !selectedPlaylist?.id) return;

    const shouldRefreshLiked =
      mode === "playlists" &&
      selectedPlaylist?.type === "liked" &&
      likedRefreshNonce > 0;
    const shouldRefreshRequested =
      tracksRefreshToken !== lastHandledRefreshTokenRef.current;
    if (shouldRefreshRequested) {
      lastHandledRefreshTokenRef.current = tracksRefreshToken;
    }
    const contextChanged = nextContextKey !== tracksContextKey;
    const hasCachedTracksForContext = Boolean(
      nextContextKey &&
        nextContextKey === tracksContextKey &&
        tracks.length > 0
    );
    if (
      !contextChanged &&
      hasCachedTracksForContext &&
      !shouldRefreshLiked &&
      !shouldRefreshRequested
    ) {
      setLoadingTracks(false);
      setPendingTracksContextKey(null);
      return;
    }
    if (contextChanged) {
      setPendingTracksContextKey(nextContextKey);
      setNextCursor(null);
    }
    loadTracks();

    return () => {
      cancelled = true;
    };
  }, [
    applyAllMyMusicTotal,
    mode,
    selectedPlaylist?.id,
    selectedPlaylist?.type,
    selectedArtist?.id,
    likedRefreshNonce,
    tracksRefreshToken,
    tracks.length,
    tracksContextKey,
  ]);

  async function loadMore() {
    if (!nextCursor || loadingMoreTracksRef.current) return;
    if (mode === "playlists" && !selectedPlaylist?.id) return;
    if (mode === "playlists" && selectedPlaylist?.type === "all_music") return;
    if (mode === "artists" && !selectedArtist?.id) return;
    if (mode === "tracks" || mode === "albums") return;
    const requestVersion = tracksLoadVersionRef.current;
    const cursor = nextCursor;
    const baseUrl =
      mode === "playlists"
        ? selectedPlaylist?.type === "liked"
          ? "/api/spotify/me/tracks?live=1"
          : playlistTracksSourceLiveRef.current
          ? `/api/spotify/playlists/${selectedPlaylist?.id}/items?live=1`
          : `/api/spotify/playlists/${selectedPlaylist?.id}/items`
        : `/api/spotify/artists/${selectedArtist?.id}/tracks`;
    const connector = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${connector}limit=50&cursor=${encodeURIComponent(cursor)}`;

    loadingMoreTracksRef.current = true;
    setLoadingMoreTracks(true);
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as CursorResponse<TrackRow>;
      const items = Array.isArray(data.items) ? data.items : [];
      if (requestVersion !== tracksLoadVersionRef.current) return;
      setTracks((prev) => dedupeTrackRows(prev.concat(items)));
      setNextCursor(data.nextCursor ?? null);
    } finally {
      loadingMoreTracksRef.current = false;
      setLoadingMoreTracks(false);
    }
  }

  const requestPlaylistItemsSync = useCallback(async (playlistId: string) => {
    try {
      await fetch("/api/spotify/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "playlist_items",
          payload: {
            playlistId,
            offset: 0,
            limit: 50,
            maxPagesPerRun: 20,
            runId: `manual-add-${Date.now()}`,
          },
        }),
      });
    } catch {
      // ignore sync trigger failures; UI will still update optimistically
    }
  }, []);

  const upsertPlaylistOnTrack = useCallback(
    (trackId: string, link: PlaylistLink) => {
      setTracks((prev) =>
        prev.map((row) => {
          if (!row.trackId || row.trackId !== trackId) return row;
          const current = Array.isArray(row.playlists) ? row.playlists : [];
          if (current.some((item) => item.id === link.id)) return row;
          return { ...row, playlists: sortPlaylistLinks([link, ...current]) };
        })
      );
      setTrackItems((prev) =>
        prev.map((item) => {
          const itemTrackId = item.trackId || item.id;
          if (!itemTrackId || itemTrackId !== trackId) return item;
          const current = Array.isArray(item.playlists) ? item.playlists : [];
          if (current.some((pl) => pl.id === link.id)) return item;
          return { ...item, playlists: sortPlaylistLinks([link, ...current]) };
        })
      );
      setSelectedTrackDetail((prev) => {
        if (!prev?.trackId || prev.trackId !== trackId) return prev;
        const current = Array.isArray(prev.playlists) ? prev.playlists : [];
        if (current.some((pl) => pl.id === link.id)) return prev;
        return { ...prev, playlists: sortPlaylistLinks([link, ...current]) };
      });
      queue.upsertTrackPlaylist(trackId, { id: link.id, name: link.name });
    },
    [queue]
  );

  const removePlaylistOnTrack = useCallback(
    (trackId: string, targetPlaylistId: string) => {
      setTracks((prev) => {
        const selectedTargetPlaylist =
          mode === "playlists" &&
          selectedPlaylist?.type === "playlist" &&
          selectedPlaylist.id === targetPlaylistId;
        const selectedLiked =
          mode === "playlists" &&
          selectedPlaylist?.type === "liked" &&
          targetPlaylistId === "liked";
        if (selectedTargetPlaylist || selectedLiked) {
          return prev.filter((row) => row.trackId !== trackId);
        }
        return prev.map((row) => {
          if (!row.trackId || row.trackId !== trackId) return row;
          const current = Array.isArray(row.playlists) ? row.playlists : [];
          const next = current.filter((pl) => pl.id !== targetPlaylistId);
          if (next.length === current.length) return row;
          return { ...row, playlists: next };
        });
      });

      setTrackItems((prev) =>
        prev.map((item) => {
          const itemTrackId = item.trackId || item.id;
          if (!itemTrackId || itemTrackId !== trackId) return item;
          const current = Array.isArray(item.playlists) ? item.playlists : [];
          const next = current.filter((pl) => pl.id !== targetPlaylistId);
          if (next.length === current.length) return item;
          return { ...item, playlists: next };
        })
      );

      setSelectedTrackDetail((prev) => {
        if (!prev?.trackId || prev.trackId !== trackId) return prev;
        const current = Array.isArray(prev.playlists) ? prev.playlists : [];
        const next = current.filter((pl) => pl.id !== targetPlaylistId);
        if (next.length === current.length) return prev;
        return { ...prev, playlists: next };
      });
      queue.removeTrackPlaylist(trackId, targetPlaylistId);
    },
    [mode, queue, selectedPlaylist?.id, selectedPlaylist?.type]
  );

  const appendTrackToSelectedPlaylist = useCallback(
    (track: TrackRow | TrackItem, target: PlaylistOption) => {
      if (mode !== "playlists" || selectedPlaylist?.type !== "playlist") return;
      if (selectedPlaylist.id !== target.id) return;
      const trackId = resolveTrackId(track);
      if (!trackId) return;
      setTracks((prev) => {
        if (prev.some((row) => row.trackId === trackId)) return prev;
        const artistsText =
          "artists" in track
            ? Array.isArray(track.artists)
              ? dedupeArtistText(
                  track.artists.map((artist) => artist?.name).filter(Boolean).join(", ")
                ) || null
              : dedupeArtistText(track.artists || "") || null
            : null;
        const albumName =
          "album" in track ? track.album?.name ?? null : track.albumName ?? null;
        const albumReleaseDate =
          "album" in track
            ? track.album?.release_date ?? null
            : track.albumReleaseDate ?? null;
        const releaseYear =
          "album" in track
            ? typeof track.releaseYear === "number"
              ? track.releaseYear
              : albumReleaseDate && /^\d{4}/.test(albumReleaseDate)
              ? Number(albumReleaseDate.slice(0, 4))
              : null
            : track.releaseYear ?? null;
        const coverUrl =
          "album" in track
            ? track.album?.images?.[0]?.url ?? track.albumImageUrl ?? null
            : track.coverUrl ?? track.albumImageUrl ?? null;
        const link = toPlaylistLink(target);
        const row: TrackRow = {
          trackId,
          playlistId: target.id,
          name: track.name ?? null,
          artists: artistsText,
          albumId: "album" in track ? track.album?.id ?? null : track.albumId ?? null,
          albumName,
          albumReleaseDate,
          releaseYear,
          albumImageUrl: "album" in track ? track.albumImageUrl ?? null : track.albumImageUrl ?? null,
          coverUrl,
          durationMs: track.durationMs ?? null,
          explicit: track.explicit ?? null,
          popularity: track.popularity ?? null,
          addedAt: Date.now(),
          position: null,
          playlists: [link],
        };
        return [row, ...prev];
      });
    },
    [mode, selectedPlaylist?.id, selectedPlaylist?.type]
  );

  const handleAddTrackToPlaylist = useCallback(
    async (track: TrackRow | TrackItem, target: PlaylistOption) => {
      const trackId = resolveTrackId(track);
      if (!trackId) return;
      const opKey = `${trackId}:${target.id}`;
      setAddingTargetKey(opKey);
      setError(null);
      try {
        if (target.type === "liked") {
          const likedRes = await fetch("/api/spotify/me/tracks/liked", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trackId }),
          });
          if (!likedRes.ok) {
            const data = await likedRes.json().catch(() => null);
            const code = typeof data?.error === "string" ? data.error : "UNKNOWN";
            throw new Error(`ADD_LIKED_FAILED_${likedRes.status}_${code}`);
          }
          emitLikedTracksUpdated(trackId, "added");
          setLikedRefreshNonce((prev) => prev + 1);
        } else {
          const playlistRes = await fetch(`/api/spotify/playlists/${target.id}/items`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trackId }),
          });
          if (!playlistRes.ok) {
            const data = await playlistRes.json().catch(() => null);
            const code = typeof data?.error === "string" ? data.error : "UNKNOWN";
            throw new Error(`ADD_PLAYLIST_FAILED_${playlistRes.status}_${code}`);
          }
          void requestPlaylistItemsSync(target.id);
        }

        const playlistLink = toPlaylistLink(target);
        upsertPlaylistOnTrack(trackId, playlistLink);
        appendTrackToSelectedPlaylist(track, target);
        if (target.type === "playlist") {
          triggerSelectedPlaylistLiveRefresh(target.id);
        }

        if (
          mode === "playlists" &&
          selectedPlaylist?.type === "playlist" &&
          selectedPlaylist.id &&
          selectedPlaylist.id !== target.id
        ) {
          void requestPlaylistItemsSync(selectedPlaylist.id);
        }
      } catch (error) {
        const message = String(error);
        if (
          message.includes("_403_") ||
          message.includes("FORBIDDEN") ||
          message.includes("SPOTIFY_SCOPE_OR_PREMIUM")
        ) {
          setError("Ontbrekende Spotify-rechten. Koppel Spotify opnieuw.");
        } else if (message.includes("_401_") || message.includes("UNAUTHENTICATED")) {
          setError("Spotify-sessie verlopen. Koppel Spotify opnieuw.");
        } else if (message.includes("_429_") || message.includes("RATE_LIMIT")) {
          setError("Spotify rate limit bereikt. Probeer zo opnieuw.");
        } else {
          setError(
            target.type === "liked"
              ? "Track toevoegen aan Liked Songs lukt nu niet."
              : "Track toevoegen aan playlist lukt nu niet."
          );
        }
      } finally {
        setAddingTargetKey(null);
      }
    },
    [
      appendTrackToSelectedPlaylist,
      emitLikedTracksUpdated,
      mode,
      requestPlaylistItemsSync,
      selectedPlaylist?.id,
      selectedPlaylist?.type,
      triggerSelectedPlaylistLiveRefresh,
      upsertPlaylistOnTrack,
    ]
  );

  const handleRemoveTrackFromPlaylist = useCallback(
    async (playlist: PlaylistLink) => {
      const trackId = selectedTrackDetail?.trackId ?? null;
      if (!trackId) return;
      const opKey = `${trackId}:${playlist.id}`;
      setRemovingTargetKey(opKey);
      setError(null);
      try {
        if (playlist.id === "liked") {
          const likedRes = await fetch("/api/spotify/me/tracks/liked", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trackId }),
          });
          if (!likedRes.ok) {
            const data = await likedRes.json().catch(() => null);
            const code = typeof data?.error === "string" ? data.error : "UNKNOWN";
            throw new Error(`REMOVE_LIKED_FAILED_${likedRes.status}_${code}`);
          }
          emitLikedTracksUpdated(trackId, "removed");
          setLikedRefreshNonce((prev) => prev + 1);
        } else {
          const playlistRes = await fetch(`/api/spotify/playlists/${playlist.id}/items`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trackId }),
          });
          if (!playlistRes.ok) {
            const data = await playlistRes.json().catch(() => null);
            const code = typeof data?.error === "string" ? data.error : "UNKNOWN";
            throw new Error(`REMOVE_PLAYLIST_FAILED_${playlistRes.status}_${code}`);
          }
          void requestPlaylistItemsSync(playlist.id);
        }

        removePlaylistOnTrack(trackId, playlist.id);
        if (playlist.id !== "liked") {
          triggerSelectedPlaylistLiveRefresh(playlist.id);
        }

        if (
          mode === "playlists" &&
          selectedPlaylist?.type === "playlist" &&
          selectedPlaylist.id &&
          selectedPlaylist.id !== playlist.id
        ) {
          void requestPlaylistItemsSync(selectedPlaylist.id);
        }
      } catch (error) {
        const message = String(error);
        if (
          message.includes("_403_") ||
          message.includes("FORBIDDEN") ||
          message.includes("SPOTIFY_SCOPE_OR_PREMIUM")
        ) {
          setError("Ontbrekende Spotify-rechten. Koppel Spotify opnieuw.");
        } else if (message.includes("_401_") || message.includes("UNAUTHENTICATED")) {
          setError("Spotify-sessie verlopen. Koppel Spotify opnieuw.");
        } else if (message.includes("_429_") || message.includes("RATE_LIMIT")) {
          setError("Spotify rate limit bereikt. Probeer zo opnieuw.");
        } else {
          setError(
            playlist.id === "liked"
              ? "Track verwijderen uit Liked Songs lukt nu niet."
              : "Track verwijderen uit playlist lukt nu niet."
          );
        }
      } finally {
        setRemovingTargetKey(null);
      }
    },
    [
      emitLikedTracksUpdated,
      mode,
      removePlaylistOnTrack,
      requestPlaylistItemsSync,
      selectedPlaylist?.id,
      selectedPlaylist?.type,
      selectedTrackDetail?.trackId,
      triggerSelectedPlaylistLiveRefresh,
    ]
  );

  const handleAddTrackToQueue = useCallback(
    (track: TrackRow | TrackItem) => {
      const queueTrack = buildQueueTrackInput(track);
      if (!queueTrack) return;
      queue.addTracks([queueTrack]);
      setError(null);
    },
    [queue]
  );

  function buildQueue(): { uris: string[]; byId: Set<string> } {
    if (mode === "tracks" || mode === "albums") {
      const uris = localFilteredTrackItems
        .map((track) => track.id)
        .filter(Boolean)
        .map((id) => `spotify:track:${id}`);
      return { uris, byId: new Set(localFilteredTrackItems.map((t) => t.id)) };
    }
    const uris = tracks
      .map((track) => track.trackId)
      .filter(Boolean)
      .map((id) => `spotify:track:${id}`);
    return { uris, byId: new Set(tracks.map((t) => t.trackId || "")) };
  }

  async function handlePlayTrack(track: TrackRow | TrackItem | null | undefined) {
    if (!track) return;
    if (!playerApi) {
      setError("Spotify player is nog niet klaar. Probeer het over een paar seconden opnieuw.");
      return;
    }
    playerApi.primePlaybackGesture?.();
    try {
      if (queue.mode === "queue") {
        queue.setMode("idle");
      }
      let trackId: string | null = null;
      if ("trackId" in track && track.trackId) {
        trackId = track.trackId;
      } else if ("id" in track && track.id) {
        trackId = track.id;
      }
      if (!trackId) return;

      if (mode === "playlists" && selectedPlaylist?.id) {
        if (
          selectedPlaylist.type === "liked" ||
          selectedPlaylist.type === "all_music"
        ) {
          const playbackQueue = buildQueue();
          const targetUri = `spotify:track:${trackId}`;
          if (playbackQueue.uris.length && playbackQueue.byId.has(trackId)) {
            await playerApi.playQueue(playbackQueue.uris, targetUri);
          } else {
            await playerApi.playQueue([targetUri], targetUri, 0);
          }
          return;
        }
        const playbackQueue = buildQueue();
        const targetUri = `spotify:track:${trackId}`;
        const offsetPosition =
          "position" in track && typeof track.position === "number"
            ? track.position
            : null;
        if (playbackQueue.uris.length && playbackQueue.byId.has(trackId)) {
          await playerApi.playQueue(playbackQueue.uris, targetUri, offsetPosition);
          return;
        }
        const contextUri = `spotify:playlist:${selectedPlaylist.id}`;
        await playerApi.playContext(
          contextUri,
          offsetPosition,
          targetUri
        );
        return;
      }

      const playbackQueue = buildQueue();
      const targetUri = `spotify:track:${trackId}`;
      if (!playbackQueue.uris.length) {
        await playerApi.playQueue([targetUri], targetUri, 0);
        return;
      }
      const offsetPosition =
        "position" in track && typeof track.position === "number"
          ? track.position
          : null;
      await playerApi.playQueue(playbackQueue.uris, targetUri, offsetPosition);
    } catch (error) {
      const message = String(error).toLowerCase();
      if (
        message.includes("_403_") ||
        message.includes("forbidden") ||
        message.includes("insufficient_scope")
      ) {
        setError("Ontbrekende Spotify-rechten. Koppel Spotify opnieuw.");
      } else if (message.includes("_401_") || message.includes("unauthenticated")) {
        setError("Spotify-sessie verlopen. Koppel Spotify opnieuw.");
      } else if (message.includes("quotaexceeded")) {
        setError("Browser-opslag is vol. Ververs de pagina en probeer opnieuw.");
      } else {
        setError("Track afspelen lukt nu niet.");
      }
    }
  }

  const hasTrackContext =
    mode === "tracks"
      ? Boolean(selectedTrackId)
      : mode === "albums"
      ? Boolean(selectedAlbumId)
      : mode === "playlists"
      ? Boolean(selectedPlaylist?.id)
      : Boolean(selectedArtist?.id);
  const playlistContextTotalCount =
    mode === "playlists"
      ? selectedPlaylist?.type === "liked"
        ? likedTracksTotal
        : selectedPlaylist?.type === "all_music"
        ? allMyMusicTotal
        : typeof selectedPlaylist?.tracksTotal === "number"
        ? Math.max(0, selectedPlaylist.tracksTotal)
        : null
      : null;
  const visibleTrackCount = hasTrackContext
    ? mode === "tracks"
      ? filteredTrackItems.length
      : mode === "albums"
      ? filteredAlbumTrackItems.length
      : mode === "playlists"
      ? playlistContextTotalCount ??
        (selectedPlaylist?.type === "all_music" ? 0 : tracks.length)
      : tracks.length
    : 0;
  const visibleTrackCountLabel = `${visibleTrackCount} ${
    visibleTrackCount === 1 ? "track" : "tracks"
  }`;
  const selectedPlaylistMeta =
    mode === "playlists" && selectedPlaylist?.type === "playlist"
      ? [
          selectedPlaylist.ownerDisplayName
            ? `door ${selectedPlaylist.ownerDisplayName}`
            : null,
          selectedPlaylist.description
            ? String(selectedPlaylist.description).replace(/<[^>]*>/g, "")
            : null,
        ]
          .filter(Boolean)
          .join(" • ")
      : "";


  const selectorDock = (
    <div
      className="player-library-dock"
      data-open={selectorDockOpen ? "true" : "false"}
      onMouseEnter={() => setSelectorDockHovered(true)}
      onMouseLeave={() => setSelectorDockHovered(false)}
      onFocusCapture={() => setSelectorDockHovered(true)}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
          return;
        }
        setSelectorDockHovered(false);
      }}
    >
      <div
        className={`player-library-dock-toggle${selectorDockOpen ? " open" : ""}`}
      >
        <span className="player-library-dock-label">MyMusic Selectie</span>
        <span className="player-library-dock-value">
          <span className="text-subtle">{selectorModeLabel}</span>
          <strong>{selectorCurrentLabel}</strong>
          <span className="player-badge player-badge-compact">{visibleTrackCountLabel}</span>
          {selectedPlaylistMeta ? (
            <span className="player-library-dock-meta" title={selectedPlaylistMeta}>
              {selectedPlaylistMeta}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          className="player-library-dock-chevron-btn"
          aria-controls="player-library-dock-body"
          aria-expanded={selectorDockOpen}
          aria-label={selectorDockOpen ? "Selectiebalk inklappen" : "Selectiebalk uitklappen"}
          onClick={() => setSelectorDockManualOpen((prev) => !prev)}
        >
          <span
            className={`player-library-dock-chevron${selectorDockOpen ? " open" : ""}`}
            aria-hidden="true"
          >
            ⌄
          </span>
        </button>
        <button
          type="button"
          className={`player-library-dock-pin${selectorDockPinned ? " active" : ""}`}
          aria-pressed={selectorDockPinned}
          aria-label={selectorDockPinned ? "Bar losmaken" : "Bar vastzetten"}
          title={selectorDockPinned ? "Bar losmaken" : "Bar vastzetten"}
          onClick={() => setSelectorDockPinned((prev) => !prev)}
        >
          <svg
            className="player-library-dock-pin-icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M14 3l7 7-2 2-2-2-3 3v4l-2 2-2-6-3-3-2 2-2-2 7-7 2 2 3-3z" />
          </svg>
          <span className="sr-only">
            {selectorDockPinned ? "Bar losmaken" : "Bar vastzetten"}
          </span>
        </button>
      </div>
      <div
        id="player-library-dock-body"
        className={`player-library-dock-body${selectorDockOpen ? " open" : ""}`}
        aria-hidden={!selectorDockOpen}
      >
        <div className="player-library-controls-row">
          <div className="segmented segmented-integrated" role="tablist" aria-label="Library modes">
            {(["playlists", "artists", "tracks", "albums"] as Mode[]).map((value) => (
              <button
                key={value}
                type="button"
                className={`segmented-btn${mode === value ? " active" : ""}`}
                role="tab"
                aria-selected={mode === value}
                onClick={() => setMode(value)}
              >
                {value === "playlists"
                  ? "Playlists"
                  : value === "artists"
                  ? "Artiesten"
                  : value === "tracks"
                  ? "Tracks"
                  : "Albums"}
              </button>
            ))}
          </div>
          <div
            className="combo player-library-combo"
            ref={comboMenu.rootRef}
            onPointerDownCapture={comboMenu.markInteraction}
            onTouchStartCapture={comboMenu.markInteraction}
          >
            <label className="sr-only" htmlFor="playlist-search">
              Kies selectie
            </label>
            <input
              id="playlist-search"
              value={query}
              onClick={() => setOpen(true)}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setOpen(false);
                }
                if (event.key === "ArrowDown") {
                  setOpen(true);
                }
              }}
              onBlur={comboMenu.handleBlur}
              className="combo-input player-library-combo-input"
              aria-label="Selectie zoeken"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-haspopup="listbox"
              aria-controls="playlist-options"
              placeholder={
                mode === "playlists"
                  ? "Zoek playlists..."
                  : mode === "artists"
                  ? "Zoek artiesten..."
                  : mode === "tracks"
                  ? "Zoek tracks..."
                  : "Zoek albums..."
              }
              disabled={
                mode === "playlists"
                  ? loadingPlaylists
                  : mode === "artists"
                  ? loadingArtists
                  : loadingTracksList
              }
            />
            <button
              type="button"
              className={`player-library-combo-toggle${open ? " open" : ""}`}
              aria-label={open ? "Sluit selectie" : "Open selectie"}
              aria-expanded={open}
              aria-controls="playlist-options"
              onClick={() => setOpen((prev) => !prev)}
            >
              ▾
            </button>
            {selectedOption || query ? (
              <button
                type="button"
                className="combo-clear player-library-combo-clear"
                aria-label="Clear selection"
                onClick={() => {
                  setQuery("");
                  setDebouncedQuery("");
                  setOpen(true);
                  if (mode === "playlists") setSelectedPlaylistId("");
                  if (mode === "artists") setSelectedArtistId("");
                  if (mode === "tracks") {
                    setSelectedTrackId("");
                  }
                  if (mode === "albums") {
                    setSelectedAlbumId("");
                  }
                }}
              >
                ×
              </button>
            ) : null}
            {open ? (
              <div
                className="combo-list player-library-combo-list"
                role="listbox"
                id="playlist-options"
                ref={comboListRef}
                onScroll={(event) => {
                  const target = event.currentTarget;
                  if (target.scrollHeight - target.scrollTop - target.clientHeight < 80) {
                    if (mode === "playlists") loadMorePlaylists();
                    if (mode === "artists") loadMoreArtists();
                    if (mode === "tracks" || mode === "albums") loadMoreTrackOptions();
                  }
                }}
              >
                {filteredOptions.length === 0 ? (
                  <div className="combo-empty">Geen resultaten.</div>
                ) : mode === "tracks" ? (
                  (filteredOptions as TrackOption[]).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      role="option"
                      aria-selected={opt.id === selectedTrackId}
                      className={`combo-item${
                        opt.id === selectedTrackId ? " active" : ""
                      }`}
                      onClick={() => {
                        setSelectedTrackId(opt.id);
                        setQuery("");
                        setDebouncedQuery("");
                        setOpen(false);
                      }}
                    >
                      <span className="combo-track">
                        {opt.coverUrl ? (
                          <Image
                            src={opt.coverUrl}
                            alt=""
                            width={28}
                            height={28}
                            className="combo-track-cover"
                            unoptimized
                          />
                        ) : (
                          <span className="combo-track-cover placeholder" />
                        )}
                        <span>
                          <span className="combo-track-name">{opt.name}</span>
                        </span>
                      </span>
                    </button>
                  ))
                ) : (
                  filteredOptions.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      role="option"
                      aria-selected={
                        mode === "playlists"
                          ? opt.id === selectedPlaylistId
                          : mode === "artists"
                          ? opt.id === selectedArtistId
                          : opt.id === selectedAlbumId
                      }
                      className={`combo-item${
                        (mode === "playlists" && opt.id === selectedPlaylistId) ||
                        (mode === "artists" && opt.id === selectedArtistId) ||
                        (mode === "albums" && opt.id === selectedAlbumId)
                          ? " active"
                          : ""
                      }`}
                      onClick={() => {
                        if (mode === "playlists") setSelectedPlaylistId(opt.id);
                        if (mode === "artists") setSelectedArtistId(opt.id);
                        if (mode === "albums") setSelectedAlbumId(opt.id);
                        setQuery("");
                        setDebouncedQuery("");
                        setOpen(false);
                      }}
                    >
                      {mode === "playlists" ? (
                        <span className="combo-option">
                          {(opt as PlaylistOption).imageUrl ? (
                            <Image
                              src={(opt as PlaylistOption).imageUrl as string}
                              alt=""
                              width={28}
                              height={28}
                              className="combo-track-cover"
                              unoptimized
                            />
                          ) : (
                            <span className="combo-track-cover placeholder" />
                          )}
                          <span className="combo-option-text">
                            <span className="combo-track-name">{opt.name}</span>
                            <span className="combo-option-meta">
                              {(opt as PlaylistOption).ownerDisplayName
                                ? `door ${(opt as PlaylistOption).ownerDisplayName}`
                                : "Spotify playlist"}
                              {typeof (opt as PlaylistOption).tracksTotal === "number"
                                ? ` • ${(opt as PlaylistOption).tracksTotal} tracks`
                                : ""}
                              {(opt as PlaylistOption).description
                                ? ` • ${String((opt as PlaylistOption).description).replace(
                                    /<[^>]*>/g,
                                    ""
                                  )}`
                                : ""}
                            </span>
                          </span>
                        </span>
                      ) : (
                        opt.name
                      )}
                    </button>
                  ))
                )}
                {mode === "playlists" && loadingMorePlaylists ? (
                  <div className="combo-loading">Meer playlists laden...</div>
                ) : null}
                {mode === "artists" && loadingMoreArtists ? (
                  <div className="combo-loading">Meer artiesten laden...</div>
                ) : null}
                {(mode === "tracks" || mode === "albums") && loadingMoreTrackOptions ? (
                  <div className="combo-loading">Meer tracks laden...</div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <section className="library-browser">
      {authRequired ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Spotify is nog niet verbonden
          </div>
          <div className="text-body">
            Verbind je account om af te spelen en playlists te laden.
          </div>
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                window.location.href = "/api/auth/login";
              }}
            >
              Spotify verbinden
            </button>
          </div>
        </div>
      ) : null}
      {selectorDockHost ? createPortal(selectorDock, selectorDockHost) : selectorDock}

      {loadingPlaylists && mode === "playlists" ? (
        <p className="text-body" role="status">
          Playlists laden...
        </p>
      ) : null}
      {!loadingPlaylists &&
      mode === "playlists" &&
      playlistOptions.length <= 2 ? (
        <div className="empty-state">
          <div style={{ fontWeight: 600 }}>Nog geen playlists gevonden</div>
          <div className="text-body">
            Werk de bibliotheek bij via Settings en probeer opnieuw.
          </div>
        </div>
      ) : null}
      {loadingArtists && mode === "artists" ? (
        <p className="text-body" role="status">
          Artiesten laden...
        </p>
      ) : null}
      {!loadingArtists && mode === "artists" && artistOptions.length === 0 ? (
        <div className="empty-state">
          <div style={{ fontWeight: 600 }}>Nog geen artiesten gevonden</div>
          <div className="text-body">
            Werk de bibliotheek bij via Settings en probeer opnieuw.
          </div>
        </div>
      ) : null}
      {loadingTracksList && mode === "albums" ? (
        <p className="text-body" role="status">
          Albums laden...
        </p>
      ) : null}
      {!loadingTracksList && mode === "albums" && albumOptions.length === 0 ? (
        <div className="empty-state">
          <div style={{ fontWeight: 600 }}>Nog geen albums gevonden</div>
          <div className="text-body">
            Werk de bibliotheek bij via Settings en probeer opnieuw.
          </div>
        </div>
      ) : null}
      {error ? (
        <div style={{ color: "#fca5a5" }} role="alert">
          <p>{error}</p>
        </div>
      ) : null}
      {mode === "playlists" || mode === "artists" ? (
        <div className="track-list" style={{ marginTop: 16 }}>
          {!isContextSwitchLoading &&
          !loadingTracks &&
          !tracks.length &&
          ((mode === "playlists" && selectedPlaylist?.id) ||
            (mode === "artists" && selectedArtist?.id)) ? (
            <div className="empty-state">
              <div style={{ fontWeight: 600 }}>Geen tracks gevonden</div>
              <div className="text-body">
                Werk de bibliotheek bij via Settings als dit onverwacht is.
              </div>
            </div>
          ) : null}
          {tracks.length ? (
            <div className="track-header columns-6">
              <div />
              <div>Track</div>
              <div className="track-col-year">Jaar</div>
              <div className="track-col-playlists">Playlists</div>
              <div className="track-col-duration">Duur</div>
              <div className="track-col-actions">Acties</div>
            </div>
          ) : null}
          {tracks.length ? (
            <List
              height={listHeight}
              itemCount={tracks.length}
              itemSize={TRACK_ROW_HEIGHT}
              width="100%"
              overscanCount={6}
              onItemsRendered={({ visibleStopIndex }) => {
                if (nextCursor && visibleStopIndex >= tracks.length - 4) {
                  loadMore();
                }
              }}
              itemKey={(index: number, data: TrackRowData) => {
                const item = data.items[index];
                return item.itemId || item.trackId || index;
              }}
              itemData={{
                items: tracks,
                mode,
                currentTrackId,
                openDetailFromRow,
                handlePlayTrack,
                addTrackToQueue: handleAddTrackToQueue,
                addTrackToPlaylist: handleAddTrackToPlaylist,
                selectPlaylistInMyMusic,
                addTargetOptions,
                addingTargetKey,
                ensureAllPlaylistOptionsLoaded,
                allPlaylistNames,
                MAX_PLAYLIST_CHIPS,
              }}
              className="track-virtual-list"
            >
              {TrackRowRenderer}
            </List>
          ) : null}
        </div>
      ) : (
        <div className="track-list" style={{ marginTop: 16 }}>
          {!loadingTracksList &&
          (mode === "tracks" ? selectedTrackId : selectedAlbumId) &&
          !localFilteredTrackItems.length ? (
            <div className="empty-state">
              <div style={{ fontWeight: 600 }}>Geen resultaten</div>
              <div className="text-body">
                {mode === "tracks"
                  ? "Probeer een andere titel."
                  : "Probeer een ander album."}
              </div>
            </div>
          ) : null}
          {localFilteredTrackItems.length ? (
            <div className="track-header columns-6">
              <div />
              <div>Track</div>
              <div className="track-col-year">Jaar</div>
              <div className="track-col-playlists">Playlists</div>
              <div className="track-col-duration">Duur</div>
              <div className="track-col-actions">Acties</div>
            </div>
          ) : null}
          {localFilteredTrackItems.length ? (
            <List
              height={listHeight}
              itemCount={localFilteredTrackItems.length}
              itemSize={TRACK_ROW_HEIGHT}
              width="100%"
              overscanCount={6}
              itemKey={(index: number, data: TrackItemData) => {
                const item = data.items[index];
                return item.id || index;
              }}
              itemData={{
                items: localFilteredTrackItems,
                currentTrackId,
                openDetailFromItem,
                handlePlayTrack,
                addTrackToQueue: handleAddTrackToQueue,
                addTrackToPlaylist: handleAddTrackToPlaylist,
                selectPlaylistInMyMusic,
                addTargetOptions,
                addingTargetKey,
                ensureAllPlaylistOptionsLoaded,
                allPlaylistNames,
                MAX_PLAYLIST_CHIPS,
              }}
              className="track-virtual-list"
            >
              {TrackItemRenderer}
            </List>
          ) : null}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        {mode === "tracks" || mode === "albums" ? (
          !(mode === "tracks" ? selectedTrackId : selectedAlbumId) && loadingTracksList ? (
            <span className="text-body">Tracks laden...</span>
          ) : null
        ) : loadingTracks || loadingMoreTracks ? (
          <span className="text-body">Tracks laden...</span>
        ) : null}
      </div>

      {selectedTrackDetail && !selectedArtistDetail ? (
        <div
          className="track-detail-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="track-detail-dialog-title"
          onClick={closeTrackDetail}
        >
          <div
            className="track-detail-card"
            ref={trackDetailDialogRef}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="track-detail-header">
              <div className="track-detail-header-left">
                <div className="track-detail-header-cover">
                  {selectedTrackDetail.coverUrl || selectedTrackDetail.albumImageUrl ? (
                    <Image
                      src={
                        (selectedTrackDetail.coverUrl ||
                          selectedTrackDetail.albumImageUrl) as string
                      }
                      alt={selectedTrackDetail.albumName || "Album cover"}
                      width={72}
                      height={72}
                      unoptimized
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : (
                    <div className="track-detail-header-cover placeholder" />
                  )}
                </div>
                <div>
                  <div className="text-subtle">Trackdetails</div>
                  <div id="track-detail-dialog-title" style={{ fontWeight: 700, fontSize: 20 }}>
                    {selectedTrackDetail.name || "Onbekende track"}
                  </div>
                  {selectedTrackDetail.artists?.length ? (
                    <div className="text-body">
                      {selectedTrackDetail.artists.map((artist: { id: string; name: string }, index) => (
                        <span key={artist.id}>
                          <button
                            type="button"
                            className="artist-link"
                            onClick={() => openArtistDetail(artist.id, artist.name)}
                          >
                            {artist.name}
                          </button>
                          {index < (selectedTrackDetail.artists?.length ?? 0) - 1
                            ? ", "
                            : ""}
                        </span>
                      ))}
                    </div>
                  ) : selectedTrackDetail.artistsText ? (
                    <div className="text-body">{selectedTrackDetail.artistsText}</div>
                  ) : null}
                  {selectedTrackDetail.albumName ? (
                    <div className="text-subtle">{selectedTrackDetail.albumName}</div>
                  ) : null}
                </div>
              </div>
              <div className="track-detail-header-actions">
                {selectedTrackDetail.spotifyUrl ? (
                  <a
                    href={selectedTrackDetail.spotifyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-primary"
                    onClick={(event) => event.stopPropagation()}
                  >
                    Openen in Spotify
                  </a>
                ) : null}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={closeTrackDetail}
                >
                  Sluiten
                </button>
              </div>
            </div>
            <div className="track-detail-body">
              <div className="track-detail-content">
                <div className="track-detail-section">
                  <div className="track-detail-title">Basis</div>
                  <div className="track-detail-grid">
                    <div className="track-detail-field">
                      <div className="text-subtle">Duur</div>
                      <div>{formatDuration(selectedTrackDetail.durationMs)}</div>
                    </div>
                    <div className="track-detail-field">
                      <div className="text-subtle">Expliciet</div>
                      <div>{formatExplicit(selectedTrackDetail.explicit)}</div>
                    </div>
                    <div className="track-detail-field">
                      <div className="text-subtle">Populariteit</div>
                      <div>
                        {selectedTrackDetail.popularity === null ||
                        selectedTrackDetail.popularity === undefined
                          ? "—"
                          : selectedTrackDetail.popularity}
                      </div>
                    </div>
                    <div className="track-detail-field">
                      <div className="text-subtle">Top track (6 mnd)</div>
                      <div>
                        {selectedTrackDetail.topRank ? `#${selectedTrackDetail.topRank}` : "—"}
                      </div>
                    </div>
                    <div className="track-detail-field">
                      <div className="text-subtle">Toegevoegd op</div>
                      <div>{formatTimestamp(selectedTrackDetail.addedAt)}</div>
                    </div>
                    <div className="track-detail-field">
                      <div className="text-subtle">Laatst gespeeld</div>
                      <div>{formatTimestamp(selectedTrackDetail.lastPlayedAt)}</div>
                    </div>
                  </div>
                </div>

                <div className="track-detail-section">
                  <div className="track-detail-title">Album</div>
                  <div className="track-detail-grid">
                    <div className="track-detail-field">
                      <div className="text-subtle">Album</div>
                      <div>{selectedTrackDetail.albumName || "—"}</div>
                    </div>
                  </div>
                </div>

                <div className="track-detail-section">
                  <div className="track-detail-title">Beschikbaarheid</div>
                  <div className="track-detail-grid">
                    <div className="track-detail-field">
                      <div className="text-subtle">Local track</div>
                      <div>
                        {selectedTrackDetail.isLocal === null ||
                        selectedTrackDetail.isLocal === undefined
                          ? "—"
                          : selectedTrackDetail.isLocal
                          ? "Ja"
                          : "Nee"}
                      </div>
                    </div>
                    <div className="track-detail-field">
                      <div className="text-subtle">Spotify restrictie</div>
                      <div>{selectedTrackDetail.restrictionsReason || "Geen"}</div>
                    </div>
                    <div className="track-detail-field">
                      <div className="text-subtle">Linked-from track</div>
                      <div>{selectedTrackDetail.linkedFromTrackId || "—"}</div>
                    </div>
                  </div>
                </div>

                <div className="track-detail-section">
                  <div className="track-detail-title">Artiesten</div>
                  <div className="track-detail-grid">
                    <div className="track-detail-field">
                      {selectedTrackDetail.artists?.length ? (
                        <div>
                          {selectedTrackDetail.artists.map((artist: { id: string; name: string }) => (
                            <div key={artist.id}>
                              <button
                                type="button"
                                className="artist-link"
                                onClick={() => openArtistDetail(artist.id, artist.name)}
                              >
                                {artist.name}
                              </button>{" "}
                              {artist.id ? (
                                <span className="text-subtle">({artist.id})</span>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : trackArtistsLoading ? (
                        <div className="text-subtle">Artiestinfo laden…</div>
                      ) : (
                        <div>{selectedTrackDetail.artistsText || "—"}</div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="track-detail-section">
                  <div className="track-detail-title">Playlists</div>
                  <div className="track-detail-grid">
                    <div className="track-detail-field">
                      {selectedTrackDetail.playlists?.length ? (
                        <div className="track-detail-playlists">
                          {selectedTrackDetail.playlists.map((pl) => (
                            <div key={pl.id} className="track-detail-playlist-row">
                              <button
                                type="button"
                                className="track-detail-playlist-link"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  closeTrackDetail();
                                  selectPlaylistInMyMusic(pl.id);
                                }}
                              >
                                {pl.name || "Naamloze playlist"}
                              </button>
                              <button
                                type="button"
                                className="playlist-remove-btn"
                                aria-label={`Verwijder uit ${pl.name || "playlist"}`}
                                title={`Verwijder uit ${pl.name || "playlist"}`}
                                disabled={
                                  !selectedTrackDetail.trackId ||
                                  removingTargetKey ===
                                    `${selectedTrackDetail.trackId}:${pl.id}`
                                }
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleRemoveTrackFromPlaylist(pl);
                                }}
                              >
                                {removingTargetKey ===
                                `${selectedTrackDetail.trackId}:${pl.id}`
                                  ? "…"
                                  : "−"}
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div>—</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {mode === "tracks" && !selectedTrackId ? (
        <div className="empty-state" style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 600 }}>Kies een track</div>
          <div className="text-body">
            Selecteer een track om resultaten te bekijken.
          </div>
        </div>
      ) : null}
      {mode === "albums" && !selectedAlbumId ? (
        <div className="empty-state" style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 600 }}>Kies een album</div>
          <div className="text-body">
            Selecteer een album om resultaten te bekijken.
          </div>
        </div>
      ) : null}
      {mode === "artists" && !selectedArtistId ? (
        <div className="empty-state" style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 600 }}>Kies een artiest</div>
          <div className="text-body">
            Selecteer een artiest om resultaten te bekijken.
          </div>
        </div>
      ) : null}
      {mode === "playlists" && !selectedPlaylist?.id ? (
        <div className="empty-state" style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 600 }}>Kies een playlist</div>
          <div className="text-body">
            Selecteer een playlist om resultaten te bekijken.
          </div>
        </div>
      ) : null}

      {selectedArtistDetail ? (
        <div
          className="track-detail-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="artist-detail-dialog-title"
          onClick={() => setSelectedArtistDetail(null)}
        >
          <div
            className="track-detail-card"
            ref={artistDetailDialogRef}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="track-detail-header">
              <div className="track-detail-header-left">
                <div className="track-detail-header-cover">
                  {selectedArtistDetail.imageUrl ? (
                    <Image
                      src={selectedArtistDetail.imageUrl}
                      alt={selectedArtistDetail.name || "Artiest"}
                      width={72}
                      height={72}
                      unoptimized
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : (
                    <div className="track-detail-header-cover placeholder" />
                  )}
                </div>
                <div>
                  <div className="text-subtle">Artiestdetails</div>
                  <div id="artist-detail-dialog-title" style={{ fontWeight: 700, fontSize: 20 }}>
                    {selectedArtistDetail.name || "Onbekende artiest"}
                  </div>
                  {selectedArtistDetail.genres?.length ? (
                    <div className="text-body">
                      {selectedArtistDetail.genres.join(", ")}
                    </div>
                  ) : (
                    <div className="text-subtle">Geen genres beschikbaar</div>
                  )}
                </div>
              </div>
              <div className="track-detail-header-actions">
                {selectedArtistDetail.spotifyUrl ? (
                  <a
                    href={selectedArtistDetail.spotifyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-primary"
                    onClick={(event) => event.stopPropagation()}
                  >
                    Openen in Spotify
                  </a>
                ) : null}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setSelectedArtistDetail(null)}
                >
                  Terug
                </button>
              </div>
            </div>
            <div className="track-detail-body">
              <div className="track-detail-content">
                <div className="track-detail-section">
                  <div className="track-detail-title">Overzicht</div>
                  <div className="track-detail-grid">
                    <div className="track-detail-field">
                      <div className="text-subtle">Populariteit</div>
                      <div>
                        {selectedArtistDetail.popularity === null ||
                        selectedArtistDetail.popularity === undefined
                          ? "—"
                          : selectedArtistDetail.popularity}
                      </div>
                    </div>
                    <div className="track-detail-field">
                      <div className="text-subtle">Tracks in bibliotheek</div>
                      <div>{selectedArtistDetail.tracksCount ?? 0}</div>
                    </div>
                    <div className="track-detail-field">
                      <div className="text-subtle">Volgers</div>
                      <div>
                        {selectedArtistDetail.followersTotal === null ||
                        selectedArtistDetail.followersTotal === undefined
                          ? "—"
                          : selectedArtistDetail.followersTotal.toLocaleString("nl-NL")}
                      </div>
                    </div>
                    <div className="track-detail-field">
                      <div className="text-subtle">Top artiest (6 mnd)</div>
                      <div>
                        {selectedArtistDetail.topRank ? `#${selectedArtistDetail.topRank}` : "—"}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="track-detail-section">
                  <div className="track-detail-title">Genres</div>
                  <div className="track-detail-grid">
                    <div className="track-detail-field">
                      {selectedArtistDetail.genres?.length ? (
                        <div className="track-detail-playlists">
                          {selectedArtistDetail.genres.map((genre) => (
                            <span key={genre}>{genre}</span>
                          ))}
                        </div>
                      ) : (
                        <div>—</div>
                      )}
                    </div>
                  </div>
                </div>
                {artistDetailLoading ? (
                  <div className="text-subtle">Artiestdetails laden...</div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

type CursorResponse<T> = {
  items?: T[];
  nextCursor?: string | null;
  totalCount?: number | null;
};

type PlaylistApiItem = {
  playlistId: string;
  name: string;
  tracksTotal?: number | null;
  ownerDisplayName?: string | null;
  description?: string | null;
  imageUrl?: string | null;
};

type ArtistApiItem = {
  artistId: string;
  name: string;
  followersTotal?: number | null;
  imageUrl?: string | null;
};

type TrackApiItem = {
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
  isLocal?: number | null;
  restrictionsReason?: string | null;
  linkedFromTrackId?: string | null;
  popularity?: number | null;
  albumImageUrl?: string | null;
  playlists?: { id: string; name: string; spotifyUrl?: string }[];
};

type AddToPlaylistMenuProps = {
  track: TrackRow | TrackItem;
  options: PlaylistOption[];
  addingTargetKey: string | null;
  onAdd: (track: TrackRow | TrackItem, target: PlaylistOption) => Promise<void>;
  onOpen?: () => void;
};

function AddToPlaylistMenu({
  track,
  options,
  addingTargetKey,
  onAdd,
  onOpen,
}: AddToPlaylistMenuProps) {
  const trackId = resolveTrackId(track);
  const [open, setOpen] = useState(false);
  const { rootRef, markInteraction, handleBlur } = useStableMenu<HTMLDivElement>({
    onClose: () => setOpen(false),
  });

  return (
    <div
      ref={rootRef}
      style={{ position: "relative" }}
      onPointerDownCapture={markInteraction}
      onTouchStartCapture={markInteraction}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="detail-btn queue-add-btn"
        aria-label="Toevoegen aan playlist"
        title="Toevoegen aan playlist"
        disabled={!trackId || options.length === 0}
        onClick={() =>
          setOpen((prev) => {
            const next = !prev;
            if (next) onOpen?.();
            return next;
          })
        }
        onBlur={handleBlur}
      >
        ＋
      </button>
      {open ? (
        <div className="combo-list" role="menu" style={{ right: 0, left: "auto", width: 260 }}>
          {options.length === 0 ? (
            <div className="combo-empty">Geen playlist-doelen.</div>
          ) : (
            options.map((option) => {
              const opKey = `${trackId}:${option.id}`;
              const busy = addingTargetKey === opKey;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="menuitem"
                  className="combo-item"
                  disabled={!trackId || busy}
                  onClick={async () => {
                    if (!trackId || busy) return;
                    await onAdd(track, option);
                    setOpen(false);
                  }}
                >
                  {busy ? "Bezig..." : option.name}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

type AddToQueueButtonProps = {
  track: TrackRow | TrackItem;
  onAdd: (track: TrackRow | TrackItem) => void;
};

function AddToQueueButton({ track, onAdd }: AddToQueueButtonProps) {
  const trackId = resolveTrackId(track);
  return (
    <button
      type="button"
      className="queue-row-btn"
      aria-label="Toevoegen aan queue"
      title="Toevoegen aan queue"
      disabled={!trackId}
      onClick={(event) => {
        event.stopPropagation();
        if (!trackId) return;
        onAdd(track);
      }}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none">
        <path
          d="M4 7h10M4 12h10M4 17h6M18 11v6M15 14h6"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

type TrackRowData = {
  items: TrackRow[];
  mode: Mode;
  currentTrackId: string | null;
  openDetailFromRow: (track: TrackRow, trigger?: HTMLElement | null) => void;
  handlePlayTrack: (track: TrackRow | TrackItem | null | undefined) => Promise<void>;
  addTrackToQueue: (track: TrackRow | TrackItem) => void;
  addTrackToPlaylist: (track: TrackRow | TrackItem, target: PlaylistOption) => Promise<void>;
  selectPlaylistInMyMusic: (playlistId: string) => void;
  addTargetOptions: PlaylistOption[];
  addingTargetKey: string | null;
  ensureAllPlaylistOptionsLoaded: () => void;
  allPlaylistNames: string[];
  MAX_PLAYLIST_CHIPS: number;
};

function TrackRowRenderer({ index, style, data }: ListChildComponentProps<TrackRowData>) {
  const track = data.items[index];
  const isGrid = data.mode === "artists" || data.mode === "playlists";
  const isPlaying = Boolean(
    data.currentTrackId &&
      (track.trackId === data.currentTrackId || track.id === data.currentTrackId)
  );
  const rowColumnsStyle = {
    ["--track-row-height" as const]: `${TRACK_ROW_HEIGHT}px`,
    ["--track-row-columns" as const]: isGrid
      ? TRACK_GRID_COLUMNS_FULL
      : TRACK_GRID_COLUMNS_COMPACT,
  } as CSSProperties;
  return (
    <div
      style={style}
      className={`track-row${isPlaying ? " playing" : ""}`}
      role="button"
      tabIndex={0}
      onClick={(event) => data.openDetailFromRow(track, event.currentTarget)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          data.openDetailFromRow(track, event.currentTarget);
        }
      }}
    >
      <div
        className={`track-row-inner${isPlaying ? " playing" : ""} track-row-grid`}
        style={rowColumnsStyle}
      >
        <div className="track-media-cell" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="play-btn"
            aria-label="Track afspelen"
            title="Afspelen"
            disabled={!track.trackId}
            onClick={() => data.handlePlayTrack(track)}
          >
            ▶
          </button>
          {track.coverUrl || track.albumImageUrl ? (
            <Image
              src={(track.coverUrl || track.albumImageUrl) as string}
              alt={track.albumName || "Album cover"}
              width={48}
              height={48}
              unoptimized
              className="track-cover-image"
            />
          ) : (
            <div className="track-cover-placeholder" />
          )}
        </div>
        <div className="track-col-track">
          <div className="track-title-line" title={track.name || "Onbekend"}>
            <span className="track-title-text">{track.name || "Onbekend"}</span>
            {isPlaying ? (
              <span className="playing-indicator" aria-label="Now playing">
                ▶
              </span>
            ) : null}
          </div>
          <div
            className="text-body track-artist-line"
            title={dedupeArtistText(track.artists || "") || "Onbekende artiest"}
          >
            {dedupeArtistText(track.artists || "") || "Onbekende artiest"}
          </div>
          {track.albumName ? (
            <div className="text-subtle track-album-line" title={track.albumName}>
              {track.albumName}
            </div>
          ) : null}
        </div>
        {isGrid ? (
          <div className="text-subtle track-col-year">{track.releaseYear ?? "—"}</div>
        ) : null}
        {isGrid ? (
          <div className="track-col-playlists">
            <PlaylistChips
              playlists={track.playlists}
              maxVisible={data.MAX_PLAYLIST_CHIPS}
              onSelectPlaylist={data.selectPlaylistInMyMusic}
            />
          </div>
        ) : null}
        {isGrid ? (
          <div className="text-subtle track-col-duration">{formatDuration(track.durationMs)}</div>
        ) : null}
        <div className="track-col-actions track-actions-group">
          <AddToQueueButton track={track} onAdd={data.addTrackToQueue} />
          <AddToPlaylistMenu
            track={track}
            options={data.addTargetOptions}
            addingTargetKey={data.addingTargetKey}
            onAdd={data.addTrackToPlaylist}
            onOpen={data.ensureAllPlaylistOptionsLoaded}
          />
          <ChatGptButton
            trackUrl={
              track.trackId ? `https://open.spotify.com/track/${track.trackId}` : null
            }
            playlistNames={data.allPlaylistNames}
            trackId={track.trackId ?? null}
            trackMeta={formatTrackMeta({
              id: track.trackId ?? null,
              name: track.name ?? null,
              artistNames: track.artists
                ? dedupeArtistText(track.artists)
                    ?.split(",")
                    .map((value) => value.trim())
                    .filter(Boolean)
                : undefined,
              albumId: track.albumId ?? null,
              durationMs: track.durationMs ?? null,
              explicit: track.explicit ?? null,
              popularity: track.popularity ?? null,
            })}
          />
          {track.trackId ? (
            <a
              href={`https://open.spotify.com/track/${track.trackId}`}
              target="_blank"
              rel="noreferrer"
              aria-label="Openen in Spotify"
              title="Openen in Spotify"
              className="track-action-link"
              onClick={(event) => event.stopPropagation()}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="currentColor"
              >
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm4.6 14.52c-.18.3-.57.4-.87.22-2.4-1.46-5.42-1.8-8.97-1.02-.34.08-.68-.13-.76-.47-.08-.34.13-.68.47-.76 3.86-.86 7.2-.47 9.9 1.18.3.18.4.57.22.87Zm1.24-2.76c-.22.36-.7.48-1.06.26-2.74-1.68-6.92-2.17-10.17-1.18-.41.12-.85-.11-.97-.52-.12-.41.11-.85.52-.97 3.71-1.12 8.33-.57 11.47 1.36.36.22.48.7.26 1.05Zm.11-2.87c-3.28-1.95-8.69-2.13-11.82-1.18-.49.15-1.02-.13-1.17-.62-.15-.49.13-1.02.62-1.17 3.59-1.09 9.56-.88 13.33 1.36.44.26.58.83.32 1.27-.26.44-.83.58-1.27.32Z" />
              </svg>
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type TrackItemData = {
  items: TrackItem[];
  currentTrackId: string | null;
  openDetailFromItem: (track: TrackItem, trigger?: HTMLElement | null) => void;
  handlePlayTrack: (track: TrackRow | TrackItem | null | undefined) => Promise<void>;
  addTrackToQueue: (track: TrackRow | TrackItem) => void;
  addTrackToPlaylist: (track: TrackRow | TrackItem, target: PlaylistOption) => Promise<void>;
  selectPlaylistInMyMusic: (playlistId: string) => void;
  addTargetOptions: PlaylistOption[];
  addingTargetKey: string | null;
  ensureAllPlaylistOptionsLoaded: () => void;
  allPlaylistNames: string[];
  MAX_PLAYLIST_CHIPS: number;
};

function TrackItemRenderer({
  index,
  style,
  data,
}: ListChildComponentProps<TrackItemData>) {
  const track = data.items[index];
  const isPlaying = Boolean(
    data.currentTrackId &&
      (track.id === data.currentTrackId || track.trackId === data.currentTrackId)
  );
  const coverUrl = track.album?.images?.[0]?.url ?? null;
  const artistNames = track.artists
    .map((artist) => artist?.name)
    .filter(Boolean)
    .join(", ");
  const uniqueArtistNames = dedupeArtistText(artistNames);
  const rowColumnsStyle = {
    ["--track-row-height" as const]: `${TRACK_ROW_HEIGHT}px`,
    ["--track-row-columns" as const]: TRACK_GRID_COLUMNS_FULL,
  } as CSSProperties;
  return (
    <div
      style={style}
      className={`track-row${isPlaying ? " playing" : ""}`}
      role="button"
      tabIndex={0}
      onClick={(event) => data.openDetailFromItem(track, event.currentTarget)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          data.openDetailFromItem(track, event.currentTarget);
        }
      }}
    >
      <div
        className={`track-row-inner${isPlaying ? " playing" : ""} track-row-grid`}
        style={rowColumnsStyle}
      >
        <div className="track-media-cell" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="play-btn"
            aria-label="Track afspelen"
            title="Afspelen"
            onClick={() => data.handlePlayTrack(track)}
          >
            ▶
          </button>
          {coverUrl ? (
            <Image
              src={coverUrl}
              alt={track.album?.name || "Album cover"}
              width={48}
              height={48}
              unoptimized
              className="track-cover-image"
            />
          ) : (
            <div className="track-cover-placeholder" />
          )}
        </div>
        <div className="track-col-track">
          <div className="track-title-line" title={track.name || "Onbekend"}>
            <span className="track-title-text">{track.name || "Onbekend"}</span>
            {isPlaying ? (
              <span className="playing-indicator" aria-label="Now playing">
                ▶
              </span>
            ) : null}
          </div>
          <div
            className="text-body track-artist-line"
            title={uniqueArtistNames || "Onbekende artiest"}
          >
            {uniqueArtistNames || "Onbekende artiest"}
          </div>
          {track.album?.name ? (
            <div className="text-subtle track-album-line" title={track.album.name}>
              {track.album.name}
            </div>
          ) : null}
        </div>
        <div className="text-subtle track-col-year">{track.releaseYear ?? "—"}</div>
        <div className="track-col-playlists">
          <PlaylistChips
            playlists={track.playlists}
            maxVisible={data.MAX_PLAYLIST_CHIPS}
            onSelectPlaylist={data.selectPlaylistInMyMusic}
          />
        </div>
        <div className="text-subtle track-col-duration">{formatDuration(track.durationMs)}</div>
        <div className="track-col-actions track-actions-group">
          <AddToQueueButton track={track} onAdd={data.addTrackToQueue} />
          <AddToPlaylistMenu
            track={track}
            options={data.addTargetOptions}
            addingTargetKey={data.addingTargetKey}
            onAdd={data.addTrackToPlaylist}
            onOpen={data.ensureAllPlaylistOptionsLoaded}
          />
          <ChatGptButton
            trackUrl={track.id ? `https://open.spotify.com/track/${track.id}` : null}
            playlistNames={data.allPlaylistNames}
            trackId={track.id ?? track.trackId ?? null}
            trackMeta={formatTrackMeta({
              id: track.id ?? track.trackId ?? null,
              name: track.name ?? null,
              artistIds: track.artists?.map((artist) => artist.id).filter(Boolean),
              artistNames: track.artists?.map((artist) => artist.name).filter(Boolean),
              albumId: track.album?.id ?? null,
              durationMs: track.durationMs ?? null,
              explicit: track.explicit ?? null,
              popularity: track.popularity ?? null,
            })}
          />
          <a
            href={`https://open.spotify.com/track/${track.id}`}
            target="_blank"
            rel="noreferrer"
            aria-label="Openen in Spotify"
            title="Openen in Spotify"
            className="track-action-link"
            onClick={(event) => event.stopPropagation()}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="currentColor"
            >
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm4.6 14.52c-.18.3-.57.4-.87.22-2.4-1.46-5.42-1.8-8.97-1.02-.34.08-.68-.13-.76-.47-.08-.34.13-.68.47-.76 3.86-.86 7.2-.47 9.9 1.18.3.18.4.57.22.87Zm1.24-2.76c-.22.36-.7.48-1.06.26-2.74-1.68-6.92-2.17-10.17-1.18-.41.12-.85-.11-.97-.52-.12-.41.11-.85.52-.97 3.71-1.12 8.33-.57 11.47 1.36.36.22.48.7.26 1.05Zm.11-2.87c-3.28-1.95-8.69-2.13-11.82-1.18-.49.15-1.02-.13-1.17-.62-.15-.49.13-1.02.62-1.17 3.59-1.09 9.56-.88 13.33 1.36.44.26.58.83.32 1.27-.26.44-.83.58-1.27.32Z" />
            </svg>
          </a>
        </div>
      </div>
    </div>
  );
}
