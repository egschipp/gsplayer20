"use client";

import { useEffect, useMemo, useState } from "react";

type PlaylistOption = {
  id: string;
  name: string;
  type: "liked" | "playlist";
  spotifyUrl: string;
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
  const [options, setOptions] = useState<PlaylistOption[]>([LIKED_OPTION]);
  const [selectedId, setSelectedId] = useState<string>(LIKED_OPTION.id);
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingPlaylists, setLoadingPlaylists] = useState(true);
  const [loadingTracks, setLoadingTracks] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadPlaylists() {
      setLoadingPlaylists(true);
      setError(null);
      setAuthRequired(false);
      try {
        const res = await fetch("/api/spotify/me/playlists?limit=50");
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
        const list: PlaylistOption[] = [LIKED_OPTION].concat(
          items.map((p: any) => ({
            id: p.playlistId,
            name: p.name,
            type: "playlist" as const,
            spotifyUrl: `https://open.spotify.com/playlist/${p.playlistId}`,
          }))
        );
        if (!cancelled) {
          setOptions(list);
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

  const selected = useMemo(
    () => options.find((opt) => opt.id === selectedId) || LIKED_OPTION,
    [options, selectedId]
  );

  useEffect(() => {
    let cancelled = false;
    async function loadTracks(cursor?: string | null, append = false) {
      setLoadingTracks(true);
      setError(null);
      try {
        const baseUrl =
          selected.type === "liked"
            ? "/api/spotify/me/tracks"
            : `/api/spotify/playlists/${selected.id}/items`;
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

    setTracks([]);
    setNextCursor(null);
    loadTracks(null, false);

    return () => {
      cancelled = true;
    };
  }, [selected.id, selected.type]);

  async function loadMore() {
    if (!nextCursor) return;
    const cursor = nextCursor;
    const baseUrl =
      selected.type === "liked"
        ? "/api/spotify/me/tracks"
        : `/api/spotify/playlists/${selected.id}/items`;
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
      <h2 className="heading-2">Playlists</h2>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="input"
          aria-label="Select playlist"
          disabled={loadingPlaylists}
        >
          {options.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.name}
            </option>
          ))}
        </select>
        <a href={selected.spotifyUrl} target="_blank" rel="noreferrer" className="btn btn-secondary">
          Open in Spotify
        </a>
      </div>

      {loadingPlaylists ? (
        <p className="text-body">Loading playlists...</p>
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

      <div style={{ marginTop: 12 }}>
        {loadingTracks ? <span className="text-body">Loading tracks...</span> : null}
        {!loadingTracks && nextCursor ? (
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
