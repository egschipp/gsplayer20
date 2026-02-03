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

type ArtistRow = {
  artistId: string;
  name: string | null;
  genres?: string | null;
  popularity?: number | null;
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
  const [trackArtists, setTrackArtists] = useState<ArtistRow[]>([]);
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
        const all: TrackOption[] = [];
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
              (track: any): TrackOption => ({
                id: String(track.name ?? "").trim().toLowerCase(),
                name: track.name,
                spotifyUrl: `https://open.spotify.com/track/${track.trackId}`,
                coverUrl: track.coverUrl ?? track.albumImageUrl ?? null,
              })
            )
          );
          cursor = data.nextCursor ?? null;
        } while (cursor);
        const unique = new Map<string, TrackOption>();
        for (const option of all) {
          if (!option.id) continue;
          const existing = unique.get(option.id);
          if (!existing) {
            unique.set(option.id, option);
          } else if (!existing.coverUrl && option.coverUrl) {
            unique.set(option.id, option);
          }
        }
        const list = Array.from(unique.values()).sort((a, b) =>
          a.name.localeCompare(b.name, "en", { sensitivity: "base" })
        );
        if (!cancelled) {
          setTrackOptions(list);
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

  const selectedTrackCover = useMemo(() => {
    if (!selectedTrackName) return null;
    const match = trackOptions.find(
      (opt) => opt.name === selectedTrackName && opt.coverUrl
    );
    return match?.coverUrl ?? null;
  }, [trackOptions, selectedTrackName]);

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
  }, [mode]);

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

  useEffect(() => {
    let cancelled = false;
    async function loadTrackArtists() {
      if (!selectedTrack?.name) return;
      setLoadingTracks(true);
      setError(null);
      try {
        const url = new URL("/api/spotify/tracks/by-name", window.location.origin);
        url.searchParams.set("name", selectedTrack.name);
        const res = await fetch(url.toString());
        if (!res.ok) {
          if (res.status === 401) {
            setError("Please connect Spotify to load artists.");
          } else {
            setError("Failed to load artists.");
          }
          return;
        }
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];
        if (!cancelled) {
          setTrackArtists(items);
        }
      } catch {
        if (!cancelled) setError("Failed to load artists.");
      } finally {
        if (!cancelled) setLoadingTracks(false);
      }
    }

    if (mode !== "tracks") return;
    setTrackArtists([]);
    loadTrackArtists();
    return () => {
      cancelled = true;
    };
  }, [mode, selectedTrack?.name]);

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
                        : opt.name === selectedTrackName
                    }
                    className={`combo-item${
                      (mode === "playlists" && opt.id === selectedPlaylistId) ||
                      (mode === "artists" && opt.id === selectedArtistId) ||
                      (mode === "tracks" && opt.name === selectedTrackName)
                        ? " active"
                        : ""
                    }`}
                    onMouseDown={() => {
                      suppressCloseRef.current = true;
                      if (mode === "playlists") setSelectedPlaylistId(opt.id);
                      if (mode === "artists") setSelectedArtistId(opt.id);
                      if (mode === "tracks") setSelectedTrackName(opt.name);
                      setQuery("");
                      setOpen(true);
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
          {selectedTrack ? (
            <div className="track-row">
              {selectedTrackCover ? (
                <img
                  src={selectedTrackCover || undefined}
                  alt={selectedTrack.name || "Track cover"}
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
                <div style={{ fontWeight: 600 }}>{selectedTrack.name}</div>
                <div className="text-subtle">Selected track</div>
              </div>
              <div />
            </div>
          ) : null}
          {trackArtists.map((artist) => (
            <div key={artist.artistId} className="track-row">
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 12,
                  background: "#2a2a2a",
                }}
              />
              <div>
                <div style={{ fontWeight: 600 }}>{artist.name || "Unknown"}</div>
                {artist.genres ? (
                  <div className="text-subtle">{artist.genres}</div>
                ) : null}
              </div>
              <div className="text-subtle">
                {artist.popularity ?? ""}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        {loadingTracks ? (
          <span className="text-body">
            {mode === "tracks" ? "Loading artists..." : "Loading tracks..."}
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
