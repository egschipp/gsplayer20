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
  durationMs?: number | null;
  explicit?: number | null;
  popularity?: number | null;
  albumImageUrl?: string | null;
  playlists: PlaylistLink[];
};

type TrackRow = {
  itemId?: string | null;
  playlistId?: string | null;
  trackId?: string | null;
  name: string | null;
  albumId?: string | null;
  albumName?: string | null;
  albumImageUrl?: string | null;
  coverUrl?: string | null;
  artists?: string | null;
  durationMs?: number | null;
  explicit?: number | null;
  popularity?: number | null;
  addedAt?: number | null;
  addedBySpotifyUserId?: string | null;
  position?: number | null;
  snapshotIdAtSync?: string | null;
  syncRunId?: string | null;
  playlists?: PlaylistLink[];
};

type TrackDetail = {
  id?: string | null;
  itemId?: string | null;
  trackId?: string | null;
  name?: string | null;
  artistsText?: string | null;
  artists?: { id: string; name: string }[];
  albumId?: string | null;
  albumName?: string | null;
  albumImageUrl?: string | null;
  coverUrl?: string | null;
  durationMs?: number | null;
  explicit?: number | null;
  popularity?: number | null;
  addedAt?: number | null;
  addedBySpotifyUserId?: string | null;
  position?: number | null;
  playlistId?: string | null;
  snapshotIdAtSync?: string | null;
  syncRunId?: string | null;
  playlists?: PlaylistLink[];
  spotifyUrl?: string | null;
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

function formatTimestamp(ms?: number | null) {
  if (!ms || ms <= 0) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function formatExplicit(value?: number | null) {
  if (value === null || value === undefined) return "—";
  return value ? "Yes" : "No";
}

function dedupeArtistText(value?: string | null) {
  if (!value) return "";
  const names = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!names.length) return "";
  const unique = Array.from(new Set(names));
  return unique.join(", ");
}

function dedupeArtists(
  artists?: { id: string; name: string }[] | null
): { id: string; name: string }[] {
  if (!artists?.length) return [];
  const seen = new Set<string>();
  const unique: { id: string; name: string }[] = [];
  for (const artist of artists) {
    const key = `${artist.id}:${artist.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(artist);
  }
  return unique;
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
  const [selectedTrackDetail, setSelectedTrackDetail] = useState<TrackDetail | null>(
    null
  );
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
            onClick={(event) => event.stopPropagation()}
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
              <div>Duration / Actions</div>
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
                  {dedupeArtistText(track.artists || "") || "Unknown artist"}
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
                <button
                  type="button"
                  className="detail-btn"
                  aria-label="Show track details"
                  title="Details"
                  onClick={() => openDetailFromRow(track)}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="currentColor"
                  >
                    <path d="M12 7.75a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Zm-1 9.5h2v-7h-2v7Zm1-15C6.48 2.25 2.25 6.48 2.25 12S6.48 21.75 12 21.75 21.75 17.52 21.75 12 17.52 2.25 12 2.25Zm0 17.5c-4.28 0-7.75-3.47-7.75-7.75S7.72 4.25 12 4.25s7.75 3.47 7.75 7.75-3.47 7.75-7.75 7.75Z" />
                  </svg>
                </button>
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
              <div>Actions</div>
            </div>
          ) : null}
          {filteredTrackItems.map((track) => {
            const coverUrl = track.album?.images?.[0]?.url ?? null;
            const artistNames = track.artists
              .map((artist) => artist?.name)
              .filter(Boolean)
              .join(", ");
            const uniqueArtistNames = dedupeArtistText(artistNames);
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
                    {uniqueArtistNames || "Unknown artist"}
                  </div>
                  {track.album?.name ? (
                    <div className="text-subtle">{track.album.name}</div>
                  ) : null}
                </div>
                <div>{renderPlaylistChips(track.playlists)}</div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    className="detail-btn"
                    aria-label="Show track details"
                    title="Details"
                    onClick={() => openDetailFromItem(track)}
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      width="18"
                      height="18"
                      fill="currentColor"
                    >
                      <path d="M12 7.75a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Zm-1 9.5h2v-7h-2v7Zm1-15C6.48 2.25 2.25 6.48 2.25 12S6.48 21.75 12 21.75 21.75 17.52 21.75 12 17.52 2.25 12 2.25Zm0 17.5c-4.28 0-7.75-3.47-7.75-7.75S7.72 4.25 12 4.25s7.75 3.47 7.75 7.75-3.47 7.75-7.75 7.75Z" />
                    </svg>
                  </button>
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

      {selectedTrackDetail ? (
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
                    <img
                      src={
                        selectedTrackDetail.coverUrl ||
                        selectedTrackDetail.albumImageUrl ||
                        undefined
                      }
                      alt={selectedTrackDetail.albumName || "Album cover"}
                      loading="lazy"
                    />
                  ) : (
                    <div className="track-detail-header-cover placeholder" />
                  )}
                </div>
                <div>
                  <div className="text-subtle">Track details</div>
                  <div style={{ fontWeight: 700, fontSize: 20 }}>
                    {selectedTrackDetail.name || "Unknown track"}
                  </div>
                  {selectedTrackDetail.artistsText ? (
                    <div className="text-body">{selectedTrackDetail.artistsText}</div>
                  ) : selectedTrackDetail.artists?.length ? (
                    <div className="text-body">
                      {selectedTrackDetail.artists
                        .map((artist) => artist.name)
                        .filter(Boolean)
                        .join(", ")}
                    </div>
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
                    Open in Spotify
                  </a>
                ) : null}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setSelectedTrackDetail(null)}
                >
                  Close
                </button>
              </div>
            </div>
            <div className="track-detail-body">
              <div className="track-detail-content">
                <div className="track-detail-section">
                  <div className="track-detail-title">Basics</div>
                  <div className="track-detail-grid">
                    <div className="track-detail-field">
                      <div className="text-subtle">Duration</div>
                      <div>{formatDuration(selectedTrackDetail.durationMs)}</div>
                    </div>
                    <div className="track-detail-field">
                      <div className="text-subtle">Explicit</div>
                      <div>{formatExplicit(selectedTrackDetail.explicit)}</div>
                    </div>
                    <div className="track-detail-field">
                      <div className="text-subtle">Popularity</div>
                      <div>
                        {selectedTrackDetail.popularity === null ||
                        selectedTrackDetail.popularity === undefined
                          ? "—"
                          : selectedTrackDetail.popularity}
                      </div>
                    </div>
                    <div className="track-detail-field">
                      <div className="text-subtle">Added at</div>
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
                  <div className="track-detail-title">Artists</div>
                  <div className="track-detail-grid">
                    <div className="track-detail-field">
                      {selectedTrackDetail.artists?.length ? (
                        <div>
                          {selectedTrackDetail.artists.map((artist) => (
                            <div key={artist.id}>
                              {artist.name}{" "}
                              <span className="text-subtle">({artist.id})</span>
                            </div>
                          ))}
                        </div>
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
                              {pl.name || "Untitled playlist"}
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
    </section>
  );
}
