"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
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

export default function PlaylistBrowser() {
  const [mode, setMode] = useState<Mode>("playlists");
  const [playlistOptions, setPlaylistOptions] = useState<PlaylistOption[]>([]);
  const [artistOptions, setArtistOptions] = useState<ArtistOption[]>([]);
  const [trackOptions, setTrackOptions] = useState<TrackOption[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string>("");
  const [selectedArtistId, setSelectedArtistId] = useState<string>("");
  const [selectedTrackName, setSelectedTrackName] = useState<string>("");
  const [query, setQuery] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [trackItems, setTrackItems] = useState<TrackItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
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
  const MAX_PLAYLIST_CHIPS = 2;
  const [listHeight, setListHeight] = useState(560);
  const ROW_HEIGHT = 96;
  const allPlaylistNames = useMemo(
    () => playlistOptions.map((pl) => pl.name || "Untitled playlist"),
    [playlistOptions]
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
    let cancelled = false;
    async function loadPlaylists() {
      setLoadingPlaylists(true);
      setError(null);
      setAuthRequired(false);
      try {
        const all: PlaylistOption[] = [];
        let cursor: string | null = null;
        do {
          const url = new URL("/api/spotify/me/playlists", window.location.origin);
          url.searchParams.set("limit", "50");
          if (cursor) url.searchParams.set("cursor", cursor);
          const res = await fetch(url.toString());
          if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
              setAuthRequired(true);
              setError("Je bent nog niet verbonden met Spotify.");
            } else if (res.status === 429) {
              setError("Je hebt even te veel aanvragen gedaan. Probeer het zo opnieuw.");
            } else {
              setError("Playlists laden lukt nu niet.");
            }
            return;
          }
          const data = await res.json();
          const items = Array.isArray(data.items) ? data.items : [];
          all.push(
            ...items.map(
              (p: any): PlaylistOption => ({
                id: p.playlistId,
                name: p.name,
                type: "playlist",
                spotifyUrl: `https://open.spotify.com/playlist/${p.playlistId}`,
              })
            )
          );
          cursor = data.nextCursor ?? null;
        } while (cursor);
        const unique = new Map<string, PlaylistOption>();
        for (const option of all) unique.set(option.id, option);
        const playlistOptions: PlaylistOption[] = Array.from(unique.values()).sort(
          (a: PlaylistOption, b: PlaylistOption) =>
            a.name.localeCompare(b.name, "en", { sensitivity: "base" })
        );
        const list: PlaylistOption[] = [LIKED_OPTION, ...playlistOptions];
        if (!cancelled) {
          setPlaylistOptions(list);
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
    let cancelled = false;
    async function loadArtists() {
      setLoadingArtists(true);
      try {
        const all: ArtistOption[] = [];
        let cursor: string | null = null;
        do {
          const url = new URL("/api/spotify/artists", window.location.origin);
          url.searchParams.set("limit", "100");
          if (cursor) url.searchParams.set("cursor", cursor);
          const res = await fetch(url.toString());
          if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
              setAuthRequired(true);
              setError("Je bent nog niet verbonden met Spotify.");
            } else if (res.status === 429) {
              setError("Je hebt even te veel aanvragen gedaan. Probeer het zo opnieuw.");
            } else {
              setError("Artiesten laden lukt nu niet.");
            }
            return;
          }
          const data = await res.json();
          const items = Array.isArray(data.items) ? data.items : [];
          all.push(
            ...items.map(
              (artist: any): ArtistOption => ({
                id: artist.artistId,
                name: artist.name,
                spotifyUrl: `https://open.spotify.com/artist/${artist.artistId}`,
              })
            )
          );
          cursor = data.nextCursor ?? null;
        } while (cursor);
        const unique = new Map<string, ArtistOption>();
        for (const option of all) unique.set(option.id, option);
        const list = Array.from(unique.values()).sort((a, b) =>
          a.name.localeCompare(b.name, "en", { sensitivity: "base" })
        );
        if (!cancelled) {
          setArtistOptions(list);
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
    let cancelled = false;
    async function loadTracksList() {
      setLoadingTracksList(true);
      try {
        const all: TrackItem[] = [];
        let cursor: string | null = null;
        do {
          const url = new URL("/api/spotify/tracks", window.location.origin);
          url.searchParams.set("limit", "100");
          if (cursor) url.searchParams.set("cursor", cursor);
          const res = await fetch(url.toString());
          if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
              setAuthRequired(true);
              setError("Je bent nog niet verbonden met Spotify.");
            } else if (res.status === 429) {
              setError("Je hebt even te veel aanvragen gedaan. Probeer het zo opnieuw.");
            } else {
              setError("Tracks laden lukt nu niet.");
            }
            return;
          }
          const data = await res.json();
          const items = Array.isArray(data.items) ? data.items : [];
          all.push(
            ...items.map(
              (track: any): TrackItem => ({
                id: String(track.id ?? track.trackId ?? ""),
                trackId: track.trackId ?? null,
                name: String(track.name ?? ""),
                artists: Array.isArray(track.artists) ? track.artists : [],
                album: track.album ?? { id: null, name: null, images: [] },
                durationMs: track.durationMs ?? null,
                explicit: track.explicit ?? null,
                popularity: track.popularity ?? null,
                albumImageUrl: track.albumImageUrl ?? null,
                playlists: Array.isArray(track.playlists) ? track.playlists : [],
              })
            )
          );
          cursor = data.nextCursor ?? null;
        } while (cursor);
        const unique = new Map<string, TrackOption>();
        for (const track of all) {
          const name = String(track.name ?? "").trim();
          const key = name.toLowerCase();
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
          setTrackItems(all);
          setSelectedTrackName((prev) => prev || (list[0]?.name ?? ""));
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

  const selectedPlaylist = useMemo(() => {
    if (!selectedPlaylistId) return null;
    return playlistOptions.find((opt) => opt.id === selectedPlaylistId) || null;
  }, [playlistOptions, selectedPlaylistId]);

  const selectedArtist = useMemo(
    () => artistOptions.find((opt) => opt.id === selectedArtistId) || null,
    [artistOptions, selectedArtistId]
  );

  const selectedTrack = useMemo(() => {
    if (!selectedTrackName) return null;
    return trackOptions.find((opt) => opt.name === selectedTrackName) || null;
  }, [trackOptions, selectedTrackName]);

  const selectedOption =
    mode === "playlists"
      ? selectedPlaylist
      : mode === "artists"
      ? selectedArtist
      : selectedTrack;

  const filteredOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    const list =
      mode === "playlists"
        ? playlistOptions
        : mode === "artists"
        ? artistOptions
        : trackOptions;
    if (!term) return list;
    return list.filter((opt) => opt.name.toLowerCase().includes(term));
  }, [playlistOptions, artistOptions, trackOptions, query, mode]);

  useEffect(() => {
    setOpen(false);
    setQuery("");
    if (mode === "playlists") setSelectedPlaylistId("");
    if (mode === "artists") setSelectedArtistId("");
    if (mode === "tracks") {
      setSelectedTrackName("");
    }
  }, [mode]);

  const filteredTrackItems = useMemo(() => {
    if (!selectedTrackName) return [];
    return trackItems.filter((track) => track.name === selectedTrackName);
  }, [trackItems, selectedTrackName]);


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
    async function loadTracks(cursor?: string | null, append = false) {
      setLoadingTracks(true);
      setError(null);
      try {
    const baseUrl =
      mode === "playlists"
        ? selectedPlaylist?.type === "liked"
          ? "/api/spotify/me/tracks"
          : `/api/spotify/playlists/${selectedPlaylist?.id}/items`
        : `/api/spotify/artists/${selectedArtist?.id}/tracks`;
        const url = new URL(baseUrl, window.location.origin);
        url.searchParams.set("limit", "50");
        if (cursor) url.searchParams.set("cursor", cursor);

        const res = await fetch(url.toString());
        if (!res.ok) {
          if (res.status === 401) {
            setError("Je bent nog niet verbonden met Spotify.");
          } else {
            setError("Tracks laden lukt nu niet.");
          }
          return;
        }
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];
        if (!cancelled) {
          setTracks((prev) => (append ? prev.concat(items) : items));
          setNextCursor(data.nextCursor ?? null);
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

    setTracks([]);
    setNextCursor(null);
    loadTracks(null, false);

    return () => {
      cancelled = true;
    };
  }, [mode, selectedPlaylist?.id, selectedPlaylist?.type, selectedArtist?.id]);

  async function loadMore() {
    if (!nextCursor) return;
    if (mode === "playlists" && !selectedPlaylist?.id) return;
    if (mode === "artists" && !selectedArtist?.id) return;
    const cursor = nextCursor;
    const baseUrl =
      mode === "playlists"
        ? selectedPlaylist?.type === "liked"
          ? "/api/spotify/me/tracks"
          : `/api/spotify/playlists/${selectedPlaylist?.id}/items`
        : `/api/spotify/artists/${selectedArtist?.id}/tracks`;
    const url = new URL(baseUrl, window.location.origin);
    url.searchParams.set("limit", "50");
    url.searchParams.set("cursor", cursor);

    setLoadingTracks(true);
    try {
      const res = await fetch(url.toString());
      if (!res.ok) return;
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      setTracks((prev) => prev.concat(items));
      setNextCursor(data.nextCursor ?? null);
    } finally {
      setLoadingTracks(false);
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
    const trackId = "trackId" in track ? track.trackId : track.id;
    if (!trackId) return;

    if (mode === "playlists" && selectedPlaylist?.id) {
      const contextUri =
        selectedPlaylist.type === "liked"
          ? "spotify:collection:tracks"
          : `spotify:playlist:${selectedPlaylist.id}`;
      const offsetPosition =
        "position" in track && typeof track.position === "number"
          ? track.position
          : null;
      await playerApi.playContext(
        contextUri,
        offsetPosition,
        `spotify:track:${trackId}`
      );
      return;
    }

    const queue = buildQueue();
    if (!queue.uris.length) return;
    const targetUri = `spotify:track:${trackId}`;
    await playerApi.playQueue(queue.uris, targetUri);
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
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
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
                  setSelectedTrackName("");
                }
              }}
            >
              ×
            </button>
          ) : null}
          {open ? (
            <div className="combo-list" role="listbox" id="playlist-options">
              {filteredOptions.length === 0 ? (
                <div className="combo-empty">Geen resultaten.</div>
              ) : mode === "tracks" ? (
                (filteredOptions as TrackOption[]).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    role="option"
                    aria-selected={opt.name === selectedTrackName}
                    className={`combo-item${
                      opt.name === selectedTrackName ? " active" : ""
                    }`}
                    onMouseDown={() => {
                      suppressCloseRef.current = true;
                      setSelectedTrackName(opt.name);
                      setQuery(opt.name);
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
                      setQuery(opt.name);
                      setOpen(false);
                    }}
                  >
                    {opt.name}
                  </button>
                ))
              )}
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
            Werk de bibliotheek bij via Account en probeer opnieuw.
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
            Werk de bibliotheek bij via Account en probeer opnieuw.
          </div>
        </div>
      ) : null}
      {loadingTracksList && mode === "tracks" && selectedTrackName ? (
        <p className="text-body" role="status">
          Tracks laden...
        </p>
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
                Werk de bibliotheek bij via Account als dit onverwacht is.
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
          {selectedTrackName ? (
            <div className="text-body" style={{ marginBottom: 6 }}>
              Tracks met naam: <strong>{selectedTrackName}</strong>
            </div>
          ) : null}
          {!loadingTracksList && selectedTrackName && !filteredTrackItems.length ? (
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
          loadingTracksList ? (
            <span className="text-body">Tracks laden...</span>
          ) : null
        ) : loadingTracks ? (
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
      {mode === "tracks" && !selectedTrackName ? (
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

type TrackRowData = {
  items: TrackRow[];
  mode: Mode;
  currentTrackId: string | null;
  openDetailFromRow: (track: TrackRow) => void;
  handlePlayTrack: (track: TrackRow | TrackItem | null | undefined) => Promise<void>;
  allPlaylistNames: string[];
  MAX_PLAYLIST_CHIPS: number;
};

function TrackRowRenderer({ index, style, data }: ListChildComponentProps<TrackRowData>) {
  const track = data.items[index];
  const isGrid = data.mode === "artists" || data.mode === "playlists";
  const isPlaying = Boolean(
    data.currentTrackId && track.trackId === data.currentTrackId
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
          gap: 12,
          alignItems: "center",
          height: "100%",
          padding: "12px",
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", gap: 10 }}
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
              width={56}
              height={56}
              unoptimized
              style={{ borderRadius: 12, objectFit: "cover" }}
            />
          ) : (
            <div
              style={{
                width: 56,
                height: 56,
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
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="text-subtle">{formatDuration(track.durationMs)}</div>
          <ChatGptButton
            trackUrl={
              track.trackId ? `https://open.spotify.com/track/${track.trackId}` : null
            }
            playlistNames={data.allPlaylistNames}
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
                width="18"
                height="18"
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
  allPlaylistNames: string[];
  MAX_PLAYLIST_CHIPS: number;
};

function TrackItemRenderer({
  index,
  style,
  data,
}: ListChildComponentProps<TrackItemData>) {
  const track = data.items[index];
  const isPlaying = Boolean(data.currentTrackId && track.id === data.currentTrackId);
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
          gap: 12,
          alignItems: "center",
          height: "100%",
          padding: "12px",
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", gap: 10 }}
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
              width={56}
              height={56}
              unoptimized
              style={{ borderRadius: 12, objectFit: "cover" }}
            />
          ) : (
            <div
              style={{
                width: 56,
                height: 56,
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
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <ChatGptButton
            trackUrl={track.id ? `https://open.spotify.com/track/${track.id}` : null}
            playlistNames={data.allPlaylistNames}
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
              width="18"
              height="18"
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
