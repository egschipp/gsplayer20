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

type PlaylistLink = { id: string; name: string; spotifyUrl: string };

type TrackItem = {
  id: string;
  trackId?: string | null;
  name: string;
  artists: { id: string; name: string }[];
  album: { id: string | null; name: string | null; images: { url: string }[] };
  playlists: PlaylistLink[];
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
  playlists?: PlaylistLink[];
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
  const MAX_PLAYLIST_CHIPS = 2;

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

  function renderPlaylistChips(playlists: PlaylistLink[] | undefined) {
    if (!playlists || playlists.length === 0) return <span className="text-subtle">—</span>;
    const visible = playlists.slice(0, MAX_PLAYLIST_CHIPS);
    const remaining = playlists.length - visible.length;
    return (
      <>
        {visible.map((pl) => (
          <a
            key={pl.id}
            href={pl.spotifyUrl}
            target="_blank"
            rel="noreferrer"
            className="playlist-chip"
          >
            {pl.name || "Untitled playlist"}
          </a>
        ))}
        {remaining > 0 ? (
          <span className="playlist-more">+{remaining} more</span>
        ) : null}
      </>
    );
  }

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
          {mode === "playlists" && !selectedPlaylist?.id ? (
            <div className="empty-state">
              <div style={{ fontWeight: 600 }}>Select a playlist</div>
              <div className="text-body">
                Choose a playlist to see its tracks.
              </div>
            </div>
          ) : null}
          {mode === "artists" && !selectedArtist?.id ? (
            <div className="empty-state">
              <div style={{ fontWeight: 600 }}>Select an artist</div>
              <div className="text-body">
                Pick an artist to see their tracks and playlists.
              </div>
            </div>
          ) : null}
          {mode === "playlists" && selectedPlaylist?.name ? (
            <div className="text-body" style={{ marginBottom: 6 }}>
              Showing tracks for: <strong>{selectedPlaylist.name}</strong>
            </div>
          ) : null}
          {mode === "artists" && selectedArtist?.name ? (
            <div className="text-body" style={{ marginBottom: 6 }}>
              Showing tracks for: <strong>{selectedArtist.name}</strong>
            </div>
          ) : null}
          {tracks.length ? (
            <div
              className={`track-header${mode === "artists" ? " columns-4" : ""}`}
            >
              <div />
              <div>Track</div>
              {mode === "artists" ? <div>Playlists</div> : null}
              <div>{mode === "artists" ? "Duration" : "Duration"}</div>
            </div>
          ) : null}
          {tracks.map((track, idx) => (
            <div
              key={`${track.itemId || track.trackId || idx}`}
              className="track-row"
              style={
                mode === "artists"
                  ? { gridTemplateColumns: "56px 1fr 1fr auto" }
                  : undefined
              }
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
              {mode === "artists" ? (
                <div>{renderPlaylistChips(track.playlists)}</div>
              ) : null}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div className="text-subtle">
                  {formatDuration(track.durationMs)}
                </div>
                {track.trackId ? (
                  <a
                    href={`https://open.spotify.com/track/${track.trackId}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open in Spotify"
                    title="Open in Spotify"
                    style={{ color: "var(--text-primary)", display: "inline-flex" }}
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
                {track.trackId ? (
                  <span className="text-subtle">Spotify</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="track-list" style={{ marginTop: 16 }}>
          {selectedTrackName ? (
            <div className="text-body" style={{ marginBottom: 6 }}>
              Tracks named: <strong>{selectedTrackName}</strong>
            </div>
          ) : null}
          {filteredTrackItems.length ? (
            <div className="track-header columns-4">
              <div />
              <div>Track</div>
              <div>Playlists</div>
              <div>Open</div>
            </div>
          ) : null}
          {filteredTrackItems.map((track) => {
            const coverUrl = track.album?.images?.[0]?.url ?? null;
            const artistNames = track.artists
              .map((artist) => artist?.name)
              .filter(Boolean)
              .join(", ");
            return (
              <div
                key={track.id}
                className="track-row"
                style={{ gridTemplateColumns: "56px 1fr 1fr auto" }}
              >
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
                <div>{renderPlaylistChips(track.playlists)}</div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <a
                    href={`https://open.spotify.com/track/${track.id}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open in Spotify"
                    title="Open in Spotify"
                    style={{ color: "var(--text-primary)", display: "inline-flex" }}
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
