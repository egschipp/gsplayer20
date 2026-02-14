"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FixedSizeList as List, type ListChildComponentProps } from "react-window";
import { usePlayer } from "./player/PlayerProvider";
import ChatGptButton from "./playlist/ChatGptButton";
import PlaylistChips from "./playlist/PlaylistChips";
import {
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
import { useQueueStore } from "@/lib/queue/QueueProvider";
import type { QueueTrackInput } from "@/lib/queue/types";

export default function PlaylistBrowser() {
  const [mode, setMode] = useState<Mode>("playlists");
  const [playlistOptions, setPlaylistOptions] = useState<PlaylistOption[]>([]);
  const [artistOptions, setArtistOptions] = useState<ArtistOption[]>([]);
  const [trackOptions, setTrackOptions] = useState<TrackOption[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string>("");
  const [selectedArtistId, setSelectedArtistId] = useState<string>("");
  const [selectedTrackId, setSelectedTrackId] = useState<string>("");
  const [query, setQuery] = useState<string>("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [trackItems, setTrackItems] = useState<TrackItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [playlistCursor, setPlaylistCursor] = useState<string | null>(null);
  const [artistCursor, setArtistCursor] = useState<string | null>(null);
  const [trackCursor, setTrackCursor] = useState<string | null>(null);
  const [loadingMorePlaylists, setLoadingMorePlaylists] = useState(false);
  const [loadingMoreArtists, setLoadingMoreArtists] = useState(false);
  const [loadingMoreTracksList, setLoadingMoreTracksList] = useState(false);
  const [loadingMoreTracks, setLoadingMoreTracks] = useState(false);
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
  const suppressCloseRef = useRef(false);
  const { api: playerApi, currentTrackId } = usePlayer();
  const queue = useQueueStore();
  const comboListRef = useRef<HTMLDivElement | null>(null);
  const loadingMoreTracksRef = useRef(false);
  const MAX_PLAYLIST_CHIPS = 2;
  const [listHeight, setListHeight] = useState(560);
  const ROW_HEIGHT = 64;
  const hydratedSelectionRef = useRef(false);
  const skipModeResetRef = useRef(true);
  const [tracksContextKey, setTracksContextKey] = useState<string | null>(null);
  const [likedRefreshNonce, setLikedRefreshNonce] = useState(0);
  const [cacheHydrated, setCacheHydrated] = useState(false);
  const hasCachedPlaylistsRef = useRef(false);
  const hasCachedArtistsRef = useRef(false);
  const hasCachedTrackOptionsRef = useRef(false);
  const CACHE_KEY = "gs_library_cache_v1";
  const allPlaylistNames = useMemo(() => {
    const emojiStart = /^\s*\p{Extended_Pictographic}/u;
    return playlistOptions
      .map((pl) => pl.name || "Untitled playlist")
      .filter((name) => emojiStart.test(name));
  }, [playlistOptions]);

  const toQueueTrackInput = useCallback(
    (track: TrackRow | TrackItem | null | undefined): QueueTrackInput | null => {
      if (!track) return null;
      const rowTrackId = "trackId" in track ? track.trackId ?? null : null;
      const rawTrackId =
        rowTrackId ??
        ("id" in track && typeof track.id === "string" ? track.id : null);
      if (!rawTrackId) return null;

      if ("album" in track) {
        const artists = (track.artists || [])
          .map((artist) => artist?.name)
          .filter(Boolean)
          .join(", ");
        return {
          uri: `spotify:track:${rawTrackId}`,
          trackId: rawTrackId,
          name: track.name || "Onbekend nummer",
          artists: artists || "Onbekende artiest",
          durationMs: track.durationMs ?? null,
          artworkUrl: track.album?.images?.[0]?.url ?? track.albumImageUrl ?? null,
        };
      }

      return {
        uri: `spotify:track:${rawTrackId}`,
        trackId: rawTrackId,
        name: track.name || "Onbekend nummer",
        artists: dedupeArtistText(track.artists || "") || "Onbekende artiest",
        durationMs: track.durationMs ?? null,
        artworkUrl: track.coverUrl || track.albumImageUrl || null,
      };
    },
    []
  );

  const handleAddTrackToQueue = useCallback(
    (track: TrackRow | TrackItem | null | undefined) => {
      const item = toQueueTrackInput(track);
      if (!item) return;
      queue.addTracks([item]);
    },
    [queue, toQueueTrackInput]
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
    const stored = window.localStorage.getItem("gs_playlist_selection");
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
      };
      if (parsed.mode) setMode(parsed.mode);
      if (parsed.playlistId) setSelectedPlaylistId(parsed.playlistId);
      if (parsed.artistId) setSelectedArtistId(parsed.artistId);
      if (parsed.trackId) setSelectedTrackId(parsed.trackId);
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
    const raw = window.sessionStorage.getItem(CACHE_KEY);
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
        setPlaylistOptions(parsed.playlistOptions);
        setLoadingPlaylists(false);
      }
      if (Array.isArray(parsed.artistOptions)) {
        hasCachedArtistsRef.current = parsed.artistOptions.length > 0;
        setArtistOptions(parsed.artistOptions);
        setLoadingArtists(false);
      }
      if (Array.isArray(parsed.trackOptions)) {
        hasCachedTrackOptionsRef.current = parsed.trackOptions.length > 0;
        setTrackOptions(parsed.trackOptions);
        setLoadingTracksList(false);
      }
      if (Array.isArray(parsed.trackItems)) setTrackItems(parsed.trackItems);
      if (Array.isArray(parsed.tracks)) setTracks(parsed.tracks);
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
    window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(payload));
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
    });
    window.localStorage.setItem("gs_playlist_selection", payload);
  }, [mode, selectedPlaylistId, selectedArtistId, selectedTrackId]);

  useEffect(() => {
    let cancelled = false;
    async function loadPlaylists() {
      if (hasCachedPlaylistsRef.current) {
        setLoadingPlaylists(false);
        return;
      }
      setLoadingPlaylists(true);
      setError(null);
      setAuthRequired(false);
      try {
        const all: PlaylistOption[] = [];
        let cursor: string | null = null;
        let pages = 0;
        const MAX_PAGES = 20;
        do {
          const url = new URL("/api/spotify/me/playlists", window.location.origin);
          url.searchParams.set("limit", "50");
          if (cursor) url.searchParams.set("cursor", cursor);
          const res = await fetch(url.toString());
          if (!res.ok) {
            const mapped = mapSpotifyApiError(
              res.status,
              "Playlists laden lukt nu niet."
            );
            if (!cancelled) {
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
            })
          );
          all.push(...mappedItems);
          cursor = data.nextCursor ?? null;
          pages += 1;
        } while (cursor && pages < MAX_PAGES);

        const unique = new Map<string, PlaylistOption>();
        for (const option of [LIKED_OPTION, ...all]) {
          unique.set(option.id, option);
        }
        const sorted: PlaylistOption[] = Array.from(unique.values())
          .filter((item) => item.id !== LIKED_OPTION.id)
          .sort((a, b) =>
            a.name.localeCompare(b.name, "en", { sensitivity: "base" })
          );
        const list: PlaylistOption[] = [LIKED_OPTION, ...sorted];
        if (!cancelled) {
          setPlaylistOptions(list);
          setPlaylistCursor(cursor ?? null);
        }
      } catch {
        if (!cancelled) setError("Playlists laden lukt nu niet.");
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
    let cancelled = false;
    async function loadArtists() {
      if (hasCachedArtistsRef.current) {
        setLoadingArtists(false);
        return;
      }
      setLoadingArtists(true);
      try {
        const url = new URL("/api/spotify/artists", window.location.origin);
        url.searchParams.set("limit", "100");
        const res = await fetch(url.toString());
        if (!res.ok) {
          const mapped = mapSpotifyApiError(res.status, "Artiesten laden lukt nu niet.");
          if (!cancelled) {
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
        const unique = new Map<string, ArtistOption>();
        for (const option of mappedItems) unique.set(option.id, option);
        const list = Array.from(unique.values()).sort((a, b) =>
          a.name.localeCompare(b.name, "en", { sensitivity: "base" })
        );
        if (!cancelled) {
          setArtistOptions(list);
          setArtistCursor(data.nextCursor ?? null);
        }
        } finally {
        if (!cancelled) setLoadingArtists(false);
      }
    }
    loadArtists();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedArtistId || loadingArtists) return;
    const exists = artistOptions.some((option) => option.id === selectedArtistId);
    if (!exists) setSelectedArtistId("");
  }, [artistOptions, loadingArtists, selectedArtistId]);

  useEffect(() => {
    let cancelled = false;
    async function loadTracksList() {
      if (hasCachedTrackOptionsRef.current) {
        setLoadingTracksList(false);
        return;
      }
      setLoadingTracksList(true);
      try {
        const url = new URL("/api/spotify/tracks", window.location.origin);
        url.searchParams.set("limit", "100");
        const res = await fetch(url.toString());
        if (!res.ok) {
          const mapped = mapSpotifyApiError(res.status, "Tracks laden lukt nu niet.");
          if (!cancelled) {
            setAuthRequired(Boolean(mapped.authRequired));
            setError(mapped.message);
          }
          return;
        }
        const data = (await res.json()) as CursorResponse<TrackApiItem>;
        const items = Array.isArray(data.items) ? data.items : [];
        const mappedItems: TrackItem[] = items.map((track): TrackItem => ({
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
          },
          durationMs: track.durationMs ?? null,
          explicit:
            typeof track.explicit === "boolean"
              ? track.explicit
                ? 1
                : 0
              : track.explicit ?? null,
          popularity: track.popularity ?? null,
          albumImageUrl: track.albumImageUrl ?? null,
          playlists: Array.isArray(track.playlists)
            ? track.playlists
                .filter((pl): pl is { id: string; name: string; spotifyUrl?: string } =>
                  Boolean(pl?.id && pl?.name)
                )
                .map((pl) => ({
                  id: pl.id,
                  name: pl.name,
                  spotifyUrl:
                    pl.spotifyUrl ?? `https://open.spotify.com/playlist/${pl.id}`,
                }))
            : [],
        }));
        const unique = new Map<string, TrackOption>();
        for (const track of mappedItems) {
          const name = String(track.name ?? "").trim();
          const key = track.id || track.trackId || "";
          if (!key) continue;
          const artistNames = track.artists
            .map((artist) => artist?.name)
            .filter(Boolean)
            .join(", ");
          const coverUrl = track.album?.images?.[0]?.url ?? null;
          const option: TrackOption = {
            id: key,
            name,
            spotifyUrl: `https://open.spotify.com/track/${track.id}`,
            coverUrl,
            trackId: track.id ?? null,
            artistNames: artistNames || null,
          };
          const existing = unique.get(key);
          if (!existing) {
            unique.set(key, option);
          } else if (!existing.coverUrl && option.coverUrl) {
            unique.set(key, option);
          }
        }
        const list = Array.from(unique.values()).sort((a, b) =>
          a.name.localeCompare(b.name, "en", { sensitivity: "base" })
        );
        if (!cancelled) {
          setTrackOptions(list);
          setTrackItems(mappedItems);
          setTrackCursor(data.nextCursor ?? null);
        }
        } finally {
        if (!cancelled) setLoadingTracksList(false);
      }
    }
    loadTracksList();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedTrackId || loadingTracksList) return;
    const exists = trackOptions.some((option) => option.id === selectedTrackId);
    if (!exists) setSelectedTrackId("");
  }, [loadingTracksList, trackOptions, selectedTrackId]);

  const selectedPlaylist = useMemo(() => {
    if (!selectedPlaylistId) return null;
    return playlistOptions.find((opt) => opt.id === selectedPlaylistId) || null;
  }, [playlistOptions, selectedPlaylistId]);

  const selectedArtist = useMemo(
    () => artistOptions.find((opt) => opt.id === selectedArtistId) || null,
    [artistOptions, selectedArtistId]
  );

  const selectedTrack = useMemo(() => {
    if (!selectedTrackId) return null;
    return trackOptions.find((opt) => opt.id === selectedTrackId) || null;
  }, [trackOptions, selectedTrackId]);

  const selectedOption =
    mode === "playlists"
      ? selectedPlaylist
      : mode === "artists"
      ? selectedArtist
      : selectedTrack;

  const sortedPlaylists = useMemo(() => {
    if (!playlistOptions.length) return playlistOptions;
    const map = new Map<string, PlaylistOption>();
    for (const option of playlistOptions) map.set(option.id, option);
    const list = Array.from(map.values())
      .filter((item) => item.id !== LIKED_OPTION.id)
      .sort((a, b) =>
        String(a.name ?? "").localeCompare(String(b.name ?? ""), "nl", {
          sensitivity: "base",
        })
      );
    return [LIKED_OPTION, ...list];
  }, [playlistOptions]);

  const filteredOptions = useMemo(() => {
    const term = debouncedQuery.trim().toLowerCase();
    const list =
      mode === "playlists"
        ? sortedPlaylists
        : mode === "artists"
        ? artistOptions
        : trackOptions;
    if (!term) return list;
    return list.filter((opt) => opt.name.toLowerCase().includes(term));
  }, [sortedPlaylists, artistOptions, trackOptions, debouncedQuery, mode]);

  useEffect(() => {
    if (skipModeResetRef.current) return;
    setOpen(false);
    setQuery("");
    setDebouncedQuery("");
  }, [mode]);

  useEffect(() => {
    if (!open) return;
    const term = debouncedQuery.trim();
    if (term.length < 2) return;
    if (mode === "playlists" && playlistCursor && !loadingMorePlaylists) {
      loadMorePlaylists();
    }
    if (mode === "artists" && artistCursor && !loadingMoreArtists) {
      loadMoreArtists();
    }
    if (mode === "tracks" && trackCursor && !loadingMoreTracksList) {
      loadMoreTracksList();
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
    loadingMoreTracksList,
  ]);

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedQuery(query);
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  const filteredTrackItems = useMemo(() => {
    if (!selectedTrackId) return [];
    return trackItems.filter((track) => track.id === selectedTrackId);
  }, [trackItems, selectedTrackId]);

  async function loadMorePlaylists() {
    if (!playlistCursor || loadingMorePlaylists) return;
    setLoadingMorePlaylists(true);
    try {
      const url = new URL("/api/spotify/me/playlists", window.location.origin);
      url.searchParams.set("limit", "50");
      url.searchParams.set("cursor", playlistCursor);
      const res = await fetch(url.toString());
      if (!res.ok) return;
      const data = (await res.json()) as CursorResponse<PlaylistApiItem>;
      const items = Array.isArray(data.items) ? data.items : [];
      const mappedItems = items.map(
        (p): PlaylistOption => ({
          id: p.playlistId,
          name: p.name,
          type: "playlist",
          spotifyUrl: `https://open.spotify.com/playlist/${p.playlistId}`,
        })
      );
      setPlaylistOptions((prev) => {
        const unique = new Map<string, PlaylistOption>();
        for (const option of prev) unique.set(option.id, option);
        for (const option of mappedItems) unique.set(option.id, option);
        const sorted: PlaylistOption[] = Array.from(unique.values())
          .filter((item) => item.id !== LIKED_OPTION.id)
          .sort((a, b) =>
            a.name.localeCompare(b.name, "en", { sensitivity: "base" })
          );
        return [LIKED_OPTION, ...sorted];
      });
      setPlaylistCursor(data.nextCursor ?? null);
    } finally {
      setLoadingMorePlaylists(false);
    }
  }

  async function loadMoreArtists() {
    if (!artistCursor || loadingMoreArtists) return;
    setLoadingMoreArtists(true);
    try {
      const url = new URL("/api/spotify/artists", window.location.origin);
      url.searchParams.set("limit", "100");
      url.searchParams.set("cursor", artistCursor);
      const res = await fetch(url.toString());
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
      setArtistOptions((prev) => {
        const unique = new Map<string, ArtistOption>();
        for (const option of prev) unique.set(option.id, option);
        for (const option of mappedItems) unique.set(option.id, option);
        return Array.from(unique.values()).sort((a, b) =>
          a.name.localeCompare(b.name, "en", { sensitivity: "base" })
        );
      });
      setArtistCursor(data.nextCursor ?? null);
    } finally {
      setLoadingMoreArtists(false);
    }
  }

  async function loadMoreTracksList() {
    if (!trackCursor || loadingMoreTracksList) return;
    setLoadingMoreTracksList(true);
    try {
      const url = new URL("/api/spotify/tracks", window.location.origin);
      url.searchParams.set("limit", "100");
      url.searchParams.set("cursor", trackCursor);
      const res = await fetch(url.toString());
      if (!res.ok) return;
      const data = (await res.json()) as CursorResponse<TrackApiItem>;
      const items = Array.isArray(data.items) ? data.items : [];
      const mappedItems: TrackItem[] = items.map((track): TrackItem => ({
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
        },
        durationMs: track.durationMs ?? null,
        explicit:
          typeof track.explicit === "boolean"
            ? track.explicit
              ? 1
              : 0
            : track.explicit ?? null,
        popularity: track.popularity ?? null,
        albumImageUrl: track.albumImageUrl ?? null,
        playlists: Array.isArray(track.playlists)
          ? track.playlists
              .filter((pl): pl is { id: string; name: string; spotifyUrl?: string } =>
                Boolean(pl?.id && pl?.name)
              )
              .map((pl) => ({
                id: pl.id,
                name: pl.name,
                spotifyUrl:
                  pl.spotifyUrl ?? `https://open.spotify.com/playlist/${pl.id}`,
              }))
          : [],
      }));
      setTrackItems((prev) => {
        const next = prev.concat(mappedItems);
        return next;
      });
      setTrackOptions((prev) => {
        const unique = new Map<string, TrackOption>();
        for (const option of prev) unique.set(option.id, option);
        for (const track of mappedItems) {
          const name = String(track.name ?? "").trim();
          const key = track.id || track.trackId || "";
          if (!key) continue;
          const artistNames = track.artists
            .map((artist) => artist?.name)
            .filter(Boolean)
            .join(", ");
          const coverUrl = track.album?.images?.[0]?.url ?? null;
          const option: TrackOption = {
            id: key,
            name,
            spotifyUrl: `https://open.spotify.com/track/${track.id}`,
            coverUrl,
            trackId: track.id ?? null,
            artistNames: artistNames || null,
          };
          const existing = unique.get(key);
          if (!existing) {
            unique.set(key, option);
          } else if (!existing.coverUrl && option.coverUrl) {
            unique.set(key, option);
          }
        }
        return Array.from(unique.values()).sort((a, b) =>
          a.name.localeCompare(b.name, "en", { sensitivity: "base" })
        );
      });
      setTrackCursor(data.nextCursor ?? null);
    } finally {
      setLoadingMoreTracksList(false);
    }
  }


  function openDetailFromRow(track: TrackRow) {
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
      popularity: track.popularity ?? null,
      addedAt: track.addedAt ?? null,
      addedBySpotifyUserId: track.addedBySpotifyUserId ?? null,
      position: track.position ?? null,
      snapshotIdAtSync: track.snapshotIdAtSync ?? null,
      syncRunId: track.syncRunId ?? null,
      playlists: track.playlists ?? [],
      spotifyUrl,
    });
  }

  function openDetailFromItem(track: TrackItem) {
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
      popularity: track.popularity ?? null,
      playlists: track.playlists ?? [],
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
      tracksCount: 0,
      spotifyUrl: `https://open.spotify.com/artist/${artistId}`,
    });
    try {
      const res = await fetch(`/api/spotify/artists/${artistId}`);
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      setSelectedArtistDetail({
        artistId: data.artistId ?? artistId,
        name: data.name ?? name ?? "Unknown artist",
        genres: Array.isArray(data.genres) ? data.genres : [],
        popularity:
          data.popularity === null || data.popularity === undefined
            ? null
            : Number(data.popularity),
        tracksCount: Number(data.tracksCount ?? 0),
        updatedAt: data.updatedAt ?? null,
        spotifyUrl: data.spotifyUrl ?? `https://open.spotify.com/artist/${artistId}`,
      });
    } finally {
      setArtistDetailLoading(false);
    }
  }

  useEffect(() => {
    if (!selectedTrackDetail) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectedTrackDetail(null);
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [selectedTrackDetail]);

  useEffect(() => {
    const trackId = selectedTrackDetail?.trackId ?? null;
    if (!trackId) return;
    if (selectedTrackDetail?.artists && selectedTrackDetail.artists.length > 0) return;
    let cancelled = false;
    async function loadTrackArtists() {
      try {
        setTrackArtistsLoading(true);
        const res = await fetch(`/api/spotify/tracks/${trackId}/artists`);
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
        if (!cancelled) setTrackArtistsLoading(false);
      }
    }
    loadTrackArtists();
    return () => {
      cancelled = true;
    };
  }, [selectedTrackDetail?.trackId, selectedTrackDetail?.artists]);

  useEffect(() => {
    if (!selectedArtistDetail) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectedArtistDetail(null);
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [selectedArtistDetail]);

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
      setLoadingTracks(true);
      setError(null);
      try {
        const baseUrl =
          mode === "playlists"
            ? selectedPlaylist?.type === "liked"
              ? "/api/spotify/me/tracks?live=1"
              : `/api/spotify/playlists/${selectedPlaylist?.id}/items`
            : `/api/spotify/artists/${selectedArtist?.id}/tracks`;
        const url = new URL(baseUrl, window.location.origin);
        url.searchParams.set("limit", "50");
        const res = await fetch(url.toString());
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
        if (!cancelled) {
          setTracks(items);
          setNextCursor(data.nextCursor ?? null);
          if (nextContextKey) setTracksContextKey(nextContextKey);
        }
      } catch {
        if (!cancelled) setError("Tracks laden lukt nu niet.");
      } finally {
        if (!cancelled) setLoadingTracks(false);
      }
    }

    if (mode === "tracks") return;

    if (mode === "artists" && !selectedArtist?.id) return;

    if (mode === "playlists" && !selectedPlaylist?.id) return;

    const shouldRefreshLiked =
      mode === "playlists" &&
      selectedPlaylist?.type === "liked" &&
      likedRefreshNonce > 0;
    const contextChanged = nextContextKey !== tracksContextKey;
    const hasCachedTracksForContext = Boolean(
      nextContextKey &&
        nextContextKey === tracksContextKey &&
        tracks.length > 0
    );
    if (!contextChanged && hasCachedTracksForContext && !shouldRefreshLiked) {
      setLoadingTracks(false);
      return;
    }
    if (contextChanged) {
      setTracks([]);
      setNextCursor(null);
      setTracksContextKey(nextContextKey);
    }
    loadTracks();

    return () => {
      cancelled = true;
    };
  }, [
    mode,
    selectedPlaylist?.id,
    selectedPlaylist?.type,
    selectedArtist?.id,
    likedRefreshNonce,
    tracks.length,
    tracksContextKey,
  ]);

  async function loadMore() {
    if (!nextCursor || loadingMoreTracksRef.current) return;
    if (mode === "playlists" && !selectedPlaylist?.id) return;
    if (mode === "artists" && !selectedArtist?.id) return;
    const cursor = nextCursor;
    const baseUrl =
      mode === "playlists"
        ? selectedPlaylist?.type === "liked"
          ? "/api/spotify/me/tracks?live=1"
          : `/api/spotify/playlists/${selectedPlaylist?.id}/items`
        : `/api/spotify/artists/${selectedArtist?.id}/tracks`;
    const url = new URL(baseUrl, window.location.origin);
    url.searchParams.set("limit", "50");
    url.searchParams.set("cursor", cursor);

    loadingMoreTracksRef.current = true;
    setLoadingMoreTracks(true);
    try {
      const res = await fetch(url.toString());
      if (!res.ok) return;
      const data = (await res.json()) as CursorResponse<TrackRow>;
      const items = Array.isArray(data.items) ? data.items : [];
      setTracks((prev) => prev.concat(items));
      setNextCursor(data.nextCursor ?? null);
    } finally {
      loadingMoreTracksRef.current = false;
      setLoadingMoreTracks(false);
    }
  }

  function buildQueue(): { uris: string[]; byId: Set<string> } {
    if (mode === "tracks") {
      const uris = filteredTrackItems
        .map((track) => track.id)
        .filter(Boolean)
        .map((id) => `spotify:track:${id}`);
      return { uris, byId: new Set(filteredTrackItems.map((t) => t.id)) };
    }
    const uris = tracks
      .map((track) => track.trackId)
      .filter(Boolean)
      .map((id) => `spotify:track:${id}`);
    return { uris, byId: new Set(tracks.map((t) => t.trackId || "")) };
  }

  async function handlePlayTrack(track: TrackRow | TrackItem | null | undefined) {
    if (!track || !playerApi) return;
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
      if (selectedPlaylist.type === "liked") {
        const playbackQueue = buildQueue();
        const targetUri = `spotify:track:${trackId}`;
        if (playbackQueue.uris.length && playbackQueue.byId.has(trackId)) {
          await playerApi.playQueue(playbackQueue.uris, targetUri);
        } else {
          await playerApi.playContext(
            "spotify:collection:tracks",
            null,
            targetUri
          );
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
    if (!playbackQueue.uris.length) return;
    const targetUri = `spotify:track:${trackId}`;
    const offsetPosition =
      "position" in track && typeof track.position === "number" ? track.position : null;
    await playerApi.playQueue(playbackQueue.uris, targetUri, offsetPosition);
  }


  return (
    <section style={{ marginTop: 24 }}>
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
      <div className="segmented" role="tablist" aria-label="Library modes">
        {(["playlists", "artists", "tracks"] as Mode[]).map((value) => (
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
              : "Tracks"}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div className="combo" style={{ minWidth: 260 }}>
          <label className="sr-only" htmlFor="playlist-search">
            Kies selectie
          </label>
          <input
            id="playlist-search"
            value={query}
            onMouseDown={() => {
              suppressCloseRef.current = true;
              setQuery("");
              setDebouncedQuery("");
              setOpen(true);
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => {
              setQuery("");
              setDebouncedQuery("");
              setOpen(true);
            }}
            onBlur={() => {
              setTimeout(() => {
                if (!suppressCloseRef.current) setOpen(false);
                suppressCloseRef.current = false;
              }, 100);
            }}
            className="combo-input"
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
                : "Zoek tracks..."
            }
            disabled={
              mode === "playlists"
                ? loadingPlaylists
                : mode === "artists"
                ? loadingArtists
                : loadingTracksList
            }
          />
          {selectedOption || query ? (
            <button
              type="button"
              className="combo-clear"
              aria-label="Clear selection"
              onMouseDown={() => {
                suppressCloseRef.current = true;
                setQuery("");
                setOpen(true);
                if (mode === "playlists") setSelectedPlaylistId("");
                if (mode === "artists") setSelectedArtistId("");
                if (mode === "tracks") {
                  setSelectedTrackId("");
                }
              }}
            >
              ×
            </button>
          ) : null}
          {open ? (
            <div
              className="combo-list"
              role="listbox"
              id="playlist-options"
              ref={comboListRef}
              onScroll={(event) => {
                const target = event.currentTarget;
                if (target.scrollHeight - target.scrollTop - target.clientHeight < 80) {
                  if (mode === "playlists") loadMorePlaylists();
                  if (mode === "artists") loadMoreArtists();
                  if (mode === "tracks") loadMoreTracksList();
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
                    onMouseDown={() => {
                      suppressCloseRef.current = true;
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
                        {opt.artistNames ? (
                          <span className="text-subtle"> {opt.artistNames}</span>
                        ) : null}
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
                        : opt.id === selectedArtistId
                    }
                    className={`combo-item${
                      (mode === "playlists" && opt.id === selectedPlaylistId) ||
                      (mode === "artists" && opt.id === selectedArtistId)
                        ? " active"
                        : ""
                    }`}
                    onMouseDown={() => {
                      suppressCloseRef.current = true;
                      if (mode === "playlists") setSelectedPlaylistId(opt.id);
                      if (mode === "artists") setSelectedArtistId(opt.id);
                      setQuery("");
                      setDebouncedQuery("");
                      setOpen(false);
                    }}
                  >
                    {opt.name}
                  </button>
                ))
              )}
              {mode === "playlists" && loadingMorePlaylists ? (
                <div className="combo-loading">Meer playlists laden...</div>
              ) : null}
              {mode === "artists" && loadingMoreArtists ? (
                <div className="combo-loading">Meer artiesten laden...</div>
              ) : null}
              {mode === "tracks" && loadingMoreTracksList ? (
                <div className="combo-loading">Meer tracks laden...</div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {loadingPlaylists && mode === "playlists" ? (
        <p className="text-body" role="status">
          Playlists laden...
        </p>
      ) : null}
      {!loadingPlaylists &&
      mode === "playlists" &&
      playlistOptions.length <= 1 ? (
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
      {loadingTracksList && mode === "tracks" && selectedTrackId ? (
        <p className="text-body" role="status">
          Tracks laden...
        </p>
      ) : null}
      {mode === "tracks" && selectedTrack?.artistNames ? (
        <div className="text-subtle" style={{ marginTop: 6 }}>
          Geselecteerd: {selectedTrack.name} • {selectedTrack.artistNames}
        </div>
      ) : null}
      {error ? (
        <div style={{ color: "#fca5a5" }} role="alert">
          <p>{error}</p>
        </div>
      ) : null}

      {mode !== "tracks" ? (
        <div className="track-list" style={{ marginTop: 16 }}>
          {mode === "playlists" && selectedPlaylist?.name ? (
            <div className="text-body" style={{ marginBottom: 6 }}>
              Tracks in: <strong>{selectedPlaylist.name}</strong>
            </div>
          ) : null}
          {mode === "artists" && selectedArtist?.name ? (
            <div className="text-body" style={{ marginBottom: 6 }}>
              Tracks van: <strong>{selectedArtist.name}</strong>
            </div>
          ) : null}
          {!loadingTracks && !tracks.length && selectedPlaylist?.id ? (
            <div className="empty-state">
              <div style={{ fontWeight: 600 }}>Geen tracks gevonden</div>
              <div className="text-body">
                Werk de bibliotheek bij via Settings als dit onverwacht is.
              </div>
            </div>
          ) : null}
          {tracks.length ? (
            <div
              className={`track-header${
                mode === "artists" || mode === "playlists" ? " columns-4" : ""
              }`}
            >
              <div />
              <div>Track</div>
              {mode === "artists" || mode === "playlists" ? (
                <div>Playlists</div>
              ) : null}
              <div>Duur / Acties</div>
            </div>
          ) : null}
          {tracks.length ? (
            <List
              height={listHeight}
              itemCount={tracks.length}
              itemSize={ROW_HEIGHT}
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
          {selectedTrack?.name ? (
            <div className="text-body" style={{ marginBottom: 6 }}>
              Tracks met naam: <strong>{selectedTrack?.name}</strong>
            </div>
          ) : null}
          {!loadingTracksList && selectedTrackId && !filteredTrackItems.length ? (
            <div className="empty-state">
              <div style={{ fontWeight: 600 }}>Geen resultaten</div>
              <div className="text-body">Probeer een andere titel.</div>
            </div>
          ) : null}
          {filteredTrackItems.length ? (
            <div className="track-header columns-4">
              <div />
              <div>Track</div>
              <div>Playlists</div>
              <div>Acties</div>
            </div>
          ) : null}
          {filteredTrackItems.length ? (
            <List
              height={listHeight}
              itemCount={filteredTrackItems.length}
              itemSize={ROW_HEIGHT}
              width="100%"
              overscanCount={6}
              itemKey={(index: number, data: TrackItemData) => {
                const item = data.items[index];
                return item.id || index;
              }}
              itemData={{
                items: filteredTrackItems,
                currentTrackId,
                openDetailFromItem,
                handlePlayTrack,
                addTrackToQueue: handleAddTrackToQueue,
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
        {mode === "tracks" ? (
          loadingTracksList || loadingMoreTracksList ? (
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
          aria-label="Track details"
          onClick={() => setSelectedTrackDetail(null)}
        >
          <div
            className="track-detail-card"
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
                  <div style={{ fontWeight: 700, fontSize: 20 }}>
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
                  onClick={() => setSelectedTrackDetail(null)}
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
                      <div className="text-subtle">Toegevoegd op</div>
                      <div>{formatTimestamp(selectedTrackDetail.addedAt)}</div>
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
                            <a
                              key={pl.id}
                              href={pl.spotifyUrl}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {pl.name || "Naamloze playlist"}
                            </a>
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
            aria-label="Artiestdetails"
          onClick={() => setSelectedArtistDetail(null)}
        >
          <div
            className="track-detail-card"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="track-detail-header">
              <div className="track-detail-header-left">
                <div>
                  <div className="text-subtle">Artiestdetails</div>
                  <div style={{ fontWeight: 700, fontSize: 20 }}>
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
};

type PlaylistApiItem = {
  playlistId: string;
  name: string;
};

type ArtistApiItem = {
  artistId: string;
  name: string;
};

type TrackApiItem = {
  id?: string;
  trackId?: string;
  name?: string;
  artists?: { id?: string; name?: string }[];
  album?: { id?: string | null; name?: string | null; images?: { url: string }[] };
  durationMs?: number | null;
  explicit?: boolean | null;
  popularity?: number | null;
  albumImageUrl?: string | null;
  playlists?: { id: string; name: string; spotifyUrl?: string }[];
};

type TrackRowData = {
  items: TrackRow[];
  mode: Mode;
  currentTrackId: string | null;
  openDetailFromRow: (track: TrackRow) => void;
  handlePlayTrack: (track: TrackRow | TrackItem | null | undefined) => Promise<void>;
  addTrackToQueue: (track: TrackRow | TrackItem | null | undefined) => void;
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
  return (
    <div
      style={style}
      className={`track-row${isPlaying ? " playing" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => data.openDetailFromRow(track)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          data.openDetailFromRow(track);
        }
      }}
    >
      <div
        className={`track-row-inner${isPlaying ? " playing" : ""}`}
        style={{
          display: "grid",
          gridTemplateColumns: isGrid ? "98px 1fr 1fr auto" : "98px 1fr auto",
          gap: 16,
          alignItems: "center",
          height: "64px",
          padding: "0 16px",
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", gap: 8 }}
          onClick={(event) => event.stopPropagation()}
        >
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
              style={{ borderRadius: 12, objectFit: "cover" }}
            />
          ) : (
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 12,
                background: "#2a2a2a",
              }}
            />
          )}
        </div>
        <div>
          <div style={{ fontWeight: 600, display: "flex", gap: 8, alignItems: "center" }}>
            {track.name || "Onbekend"}
            {isPlaying ? (
              <span className="playing-indicator" aria-label="Now playing">
                ▶
              </span>
            ) : null}
          </div>
          <div className="text-body">
            {dedupeArtistText(track.artists || "") || "Onbekende artiest"}
          </div>
          {track.albumName ? (
            <div className="text-subtle">{track.albumName}</div>
          ) : null}
        </div>
        {isGrid ? (
          <div>
            <PlaylistChips
              playlists={track.playlists}
              maxVisible={data.MAX_PLAYLIST_CHIPS}
            />
          </div>
        ) : null}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="text-subtle">{formatDuration(track.durationMs)}</div>
          <button
            type="button"
            className="detail-btn queue-add-btn"
            aria-label="Toevoegen aan custom queue"
            title="Toevoegen aan custom queue"
            disabled={!track.trackId}
            onClick={(event) => {
              event.stopPropagation();
              data.addTrackToQueue(track);
            }}
          >
            ＋
          </button>
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
              style={{ color: "var(--text-primary)", display: "inline-flex" }}
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
          {track.trackId ? <span className="text-subtle">Spotify</span> : null}
        </div>
      </div>
    </div>
  );
}

type TrackItemData = {
  items: TrackItem[];
  currentTrackId: string | null;
  openDetailFromItem: (track: TrackItem) => void;
  handlePlayTrack: (track: TrackRow | TrackItem | null | undefined) => Promise<void>;
  addTrackToQueue: (track: TrackRow | TrackItem | null | undefined) => void;
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
  return (
    <div
      style={style}
      className={`track-row${isPlaying ? " playing" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => data.openDetailFromItem(track)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          data.openDetailFromItem(track);
        }
      }}
    >
      <div
        className={`track-row-inner${isPlaying ? " playing" : ""}`}
        style={{
          display: "grid",
          gridTemplateColumns: "98px 1fr 1fr auto",
          gap: 16,
          alignItems: "center",
          height: "64px",
          padding: "0 16px",
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", gap: 8 }}
          onClick={(event) => event.stopPropagation()}
        >
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
              style={{ borderRadius: 12, objectFit: "cover" }}
            />
          ) : (
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 12,
                background: "#2a2a2a",
              }}
            />
          )}
        </div>
        <div>
          <div style={{ fontWeight: 600, display: "flex", gap: 8, alignItems: "center" }}>
            {track.name}
            {isPlaying ? (
              <span className="playing-indicator" aria-label="Now playing">
                ▶
              </span>
            ) : null}
          </div>
          <div className="text-body">{uniqueArtistNames || "Onbekende artiest"}</div>
          {track.album?.name ? <div className="text-subtle">{track.album.name}</div> : null}
        </div>
        <div>
          <PlaylistChips
            playlists={track.playlists}
            maxVisible={data.MAX_PLAYLIST_CHIPS}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            className="detail-btn queue-add-btn"
            aria-label="Toevoegen aan custom queue"
            title="Toevoegen aan custom queue"
            disabled={!track.id && !track.trackId}
            onClick={(event) => {
              event.stopPropagation();
              data.addTrackToQueue(track);
            }}
          >
            ＋
          </button>
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
            style={{ color: "var(--text-primary)", display: "inline-flex" }}
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
          <span className="text-subtle" style={{ marginLeft: 6 }}>
            Spotify
          </span>
        </div>
      </div>
    </div>
  );
}
