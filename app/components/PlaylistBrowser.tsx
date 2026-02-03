"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Mode = "playlists" | "artists" | "tracks";

type PlaylistOption = {
  id: string;
  name: string;
  type: "liked" | "playlist";
  spotifyUrl: string;
};

type ArtistOption = {
  id: string;
  name: string;
  spotifyUrl: string;
};

type TrackOption = {
  id: string;
  name: string;
  spotifyUrl: string;
  coverUrl?: string | null;
  trackId?: string | null;
  artistNames?: string | null;
};

type TrackItem = {
  id: string;
  trackId?: string | null;
  name: string;
  artists: { id: string; name: string }[];
  album: { id: string | null; name: string | null; images: { url: string }[] };
};

type TrackRow = {
  itemId?: string | null;
  trackId?: string | null;
  name: string | null;
  albumName?: string | null;
  albumImageUrl?: string | null;
  coverUrl?: string | null;
  artists?: string | null;
  durationMs?: number | null;
};

const LIKED_OPTION: PlaylistOption = {
  id: "liked",
  name: "Liked Songs",
  type: "liked",
  spotifyUrl: "https://open.spotify.com/collection/tracks",
};

function formatDuration(ms?: number | null) {
  if (!ms || ms <= 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

export default function PlaylistBrowser() {
  const [mode, setMode] = useState<Mode>("playlists");
  const [playlistOptions, setPlaylistOptions] = useState<PlaylistOption[]>([
    LIKED_OPTION,
  ]);
  const [artistOptions, setArtistOptions] = useState<ArtistOption[]>([]);
  const [trackOptions, setTrackOptions] = useState<TrackOption[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string>(
    LIKED_OPTION.id
  );
  const [selectedArtistId, setSelectedArtistId] = useState<string>("");
  const [selectedTrackName, setSelectedTrackName] = useState<string>("");
  const [query, setQuery] = useState<string>(LIKED_OPTION.name);
  const [open, setOpen] = useState(false);
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [trackItems, setTrackItems] = useState<TrackItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingPlaylists, setLoadingPlaylists] = useState(true);
  const [loadingArtists, setLoadingArtists] = useState(false);
  const [loadingTracksList, setLoadingTracksList] = useState(false);
  const [loadingTracks, setLoadingTracks] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const suppressCloseRef = useRef(false);

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
              setError("Please connect Spotify to load playlists.");
            } else if (res.status === 429) {
              setError("Rate limited. Please try again in a moment.");
            } else {
              setError("Failed to load playlists.");
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
          if (!selectedPlaylistId) {
            setSelectedPlaylistId(LIKED_OPTION.id);
          }
        }
      } catch {
        if (!cancelled) setError("Failed to load playlists.");
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
              setError("Please connect Spotify to load artists.");
            } else if (res.status === 429) {
              setError("Rate limited. Please try again in a moment.");
            } else {
              setError("Failed to load artists.");
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
          if (!selectedArtistId && list.length) setSelectedArtistId(list[0].id);
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
              setError("Please connect Spotify to load tracks.");
            } else if (res.status === 429) {
              setError("Rate limited. Please try again in a moment.");
            } else {
              setError("Failed to load tracks.");
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
          if (!selectedTrackName && list.length) setSelectedTrackName(list[0].name);
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
    return (
      playlistOptions.find((opt) => opt.id === selectedPlaylistId) ||
      LIKED_OPTION
    );
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
            setError("Please connect Spotify to load tracks.");
          } else {
            setError("Failed to load tracks.");
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
        if (!cancelled) setError("Failed to load tracks.");
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

  return (
    <section style={{ marginTop: 24 }}>
      <h2 className="heading-2">Library</h2>
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
            {value.charAt(0).toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div className="combo" style={{ minWidth: 260 }}>
          <label className="sr-only" htmlFor="playlist-search">
            Select option
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
            aria-label="Select option"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls="playlist-options"
            placeholder={
              mode === "playlists"
                ? "Search playlists..."
                : mode === "artists"
                ? "Search artists..."
                : "Search tracks..."
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
                  setTrackArtists([]);
                }
              }}
            >
              ×
            </button>
          ) : null}
          {open ? (
            <div className="combo-list" role="listbox" id="playlist-options">
              {filteredOptions.length === 0 ? (
                <div className="combo-empty">No matches.</div>
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
                        <img
                          src={opt.coverUrl || undefined}
                          alt=""
                          loading="lazy"
                          className="combo-track-cover"
                        />
                      ) : (
                        <span className="combo-track-cover placeholder" />
                      )}
                      <span className="combo-track-name">{opt.name}</span>
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
        {selectedOption ? (
          <a
            href={selectedOption.spotifyUrl}
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary"
          >
            Open in Spotify
          </a>
        ) : null}
      </div>

      {loadingPlaylists && mode === "playlists" ? (
        <p className="text-body">Loading playlists...</p>
      ) : null}
      {loadingArtists && mode === "artists" ? (
        <p className="text-body">Loading artists...</p>
      ) : null}
      {loadingTracksList && mode === "tracks" ? (
        <p className="text-body">Loading tracks...</p>
      ) : null}
      {error ? (
        <div style={{ color: "#fca5a5" }}>
          <p>{error}</p>
          {authRequired ? (
            <a href="/api/auth/login" className="btn btn-primary">
              Connect Spotify
            </a>
          ) : null}
        </div>
      ) : null}

      {mode !== "tracks" ? (
        <div className="track-list" style={{ marginTop: 16 }}>
          {tracks.map((track, idx) => (
            <div
              key={`${track.itemId || track.trackId || idx}`}
              className="track-row"
            >
              {track.coverUrl || track.albumImageUrl ? (
                <img
                  src={track.coverUrl || track.albumImageUrl || undefined}
                  alt={track.albumName || "Album cover"}
                  loading="lazy"
                  style={{ width: 56, height: 56, borderRadius: 12, objectFit: "cover" }}
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
              <div>
                <div style={{ fontWeight: 600 }}>{track.name || "Unknown"}</div>
                <div className="text-body">
                  {track.artists || "Unknown artist"}
                </div>
                {track.albumName ? (
                  <div className="text-subtle">{track.albumName}</div>
                ) : null}
              </div>
              <div className="text-subtle">
                {formatDuration(track.durationMs)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="track-list" style={{ marginTop: 16 }}>
          {filteredTrackItems.map((track) => {
            const coverUrl = track.album?.images?.[0]?.url ?? null;
            const artistNames = track.artists
              .map((artist) => artist?.name)
              .filter(Boolean)
              .join(", ");
            return (
              <div key={track.id} className="track-row">
                {coverUrl ? (
                  <img
                    src={coverUrl || undefined}
                    alt={track.album?.name || "Album cover"}
                    loading="lazy"
                    style={{ width: 56, height: 56, borderRadius: 12, objectFit: "cover" }}
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
                <div>
                  <div style={{ fontWeight: 600 }}>{track.name}</div>
                  <div className="text-body">
                    {artistNames || "Unknown artist"}
                  </div>
                  {track.album?.name ? (
                    <div className="text-subtle">{track.album.name}</div>
                  ) : null}
                </div>
                <div />
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        {mode === "tracks" ? (
          loadingTracksList ? (
            <span className="text-body">Loading tracks...</span>
          ) : null
        ) : loadingTracks ? (
          <span className="text-body">
            Loading tracks...
          </span>
        ) : null}
        {!loadingTracks && nextCursor && mode !== "tracks" ? (
          <button
            onClick={loadMore}
            className="btn btn-primary"
            style={{ marginLeft: 12 }}
          >
            Load more
          </button>
        ) : null}
      </div>
    </section>
  );
}
