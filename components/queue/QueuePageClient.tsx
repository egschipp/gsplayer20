"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { useQueueStore } from "@/lib/queue/QueueProvider";
import { useQueuePlayback } from "@/lib/playback/QueuePlaybackProvider";
import { type QueueItem } from "@/lib/queue/types";
import { usePlayer } from "@/app/components/player/PlayerProvider";
import type { PlaybackFocusStatus } from "@/app/components/player/playbackFocus";
import { TRACK_ROW_HEIGHT } from "@/lib/ui/trackLayout";
import { animateScrollTop } from "@/lib/ui/smoothScroll";
import styles from "./QueuePageClient.module.css";

function formatDuration(ms: number | null) {
  if (!ms || ms <= 0) return "--:--";
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function normalizeSpotifyTrackId(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^[0-9A-Za-z]{22}$/.test(raw)) return raw;
  if (raw.startsWith("spotify:track:")) {
    const segment = raw.split(":").pop() ?? "";
    const id = segment.split("?")[0]?.trim() ?? "";
    return /^[0-9A-Za-z]{22}$/.test(id) ? id : null;
  }
  if (
    raw.includes("open.spotify.com/track/") ||
    raw.includes("api.spotify.com/v1/tracks/")
  ) {
    try {
      const url = new URL(raw);
      const segment = (url.pathname.split("/").filter(Boolean).pop() ?? "")
        .split("?")[0]
        .trim();
      return /^[0-9A-Za-z]{22}$/.test(segment) ? segment : null;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeTrackIdCollection(values: Array<string | null | undefined>) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeSpotifyTrackId(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function collectQueueTrackMatchCandidates(item: QueueItem | null | undefined) {
  if (!item) return [] as string[];
  const candidates = new Set<string>();
  const values: Array<string | null | undefined> = [item.trackId, item.uri];
  for (const value of values) {
    const normalized = normalizeSpotifyTrackId(value);
    if (normalized) candidates.add(normalized);
  }
  return Array.from(candidates);
}

function findBestQueueTrackMatchIndex(items: QueueItem[], activeTrackIds: Set<string>) {
  if (!items.length || !activeTrackIds.size) return -1;
  for (let index = 0; index < items.length; index += 1) {
    const matches = collectQueueTrackMatchCandidates(items[index]);
    if (matches.some((candidate) => activeTrackIds.has(candidate))) {
      return index;
    }
  }
  return -1;
}

function readSelectedPlaylistId() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem("gs_playlist_selection");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { mode?: string; playlistId?: string };
    if (parsed.mode !== "playlists") return null;
    if (typeof parsed.playlistId === "string" && parsed.playlistId) {
      return parsed.playlistId;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeTrackName(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("nl");
}

function parsePrimaryArtistName(value: string | null | undefined) {
  return (
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)[0] ?? ""
  );
}

function createAlbumSelectionId(item: QueueItem) {
  const albumId = String(item.albumId ?? "").trim();
  if (albumId) return `id:${albumId}`;
  const albumName = String(item.albumName ?? "").trim();
  const artists = String(item.artists ?? "").trim();
  if (!albumName || !artists) return null;
  return `meta:${normalizeTrackName(albumName)}::${normalizeTrackName(artists)}`;
}

function writeMyMusicSelection(payload: {
  mode: "artists" | "albums";
  artistId?: string | null;
  albumId?: string | null;
}) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      "gs_playlist_selection",
      JSON.stringify({
        mode: payload.mode,
        playlistId: "",
        artistId: payload.artistId ?? "",
        trackId: "",
        albumId: payload.albumId ?? "",
      })
    );
  } catch {
    // ignore storage write failures
  }
}

async function resolveArtistSelection(item: QueueItem) {
  const primaryArtistName = parsePrimaryArtistName(item.artists);
  const storedArtistId = String(item.primaryArtistId ?? "").trim();
  if (storedArtistId) {
    return {
      artistId: storedArtistId,
      artistName: primaryArtistName,
    };
  }
  if (!item.trackId) {
    return {
      artistId: null,
      artistName: primaryArtistName,
    };
  }
  try {
    const res = await fetch(`/api/spotify/tracks/${encodeURIComponent(item.trackId)}/artists`, {
      cache: "no-store",
    });
    if (!res.ok) {
      return {
        artistId: null,
        artistName: primaryArtistName,
      };
    }
    const data = await res.json().catch(() => null);
    const items = (Array.isArray(data?.items) ? data.items : []) as {
      artistId?: string;
      id?: string;
      name?: string;
    }[];
    const artists = items
      .map((entry) => ({
        id: String(entry?.artistId ?? entry?.id ?? "").trim(),
        name: String(entry?.name ?? "").trim(),
      }))
      .filter((artist) => artist.id && artist.name);
    if (!artists.length) {
      return {
        artistId: null,
        artistName: primaryArtistName,
      };
    }
    const matched =
      artists.find(
        (artist) => normalizeTrackName(artist.name) === normalizeTrackName(primaryArtistName)
      ) ?? artists[0];
    return {
      artistId: matched?.id ?? null,
      artistName: matched?.name ?? primaryArtistName,
    };
  } catch {
    return {
      artistId: null,
      artistName: primaryArtistName,
    };
  }
}

export default function QueuePageClient() {
  const router = useRouter();
  const queue = useQueueStore();
  const playback = useQueuePlayback();
  const { playbackState } = usePlayer();
  const [draggingQueueId, setDraggingQueueId] = useState<string | null>(null);
  const [dragOverQueueId, setDragOverQueueId] = useState<string | null>(null);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const queueRowsRef = useRef<HTMLOListElement | null>(null);
  const activeQueueId = playback.startingQueueId ?? playback.activeQueueId ?? queue.currentQueueId;

  const activeTrackIdsOrdered = useMemo(
    () =>
      normalizeTrackIdCollection([
        ...(Array.isArray(playbackState.matchTrackIds) ? playbackState.matchTrackIds : []),
        playbackState.currentTrackId,
      ]),
    [playbackState.currentTrackId, playbackState.matchTrackIds]
  );
  const activeTrackIdSet = useMemo(
    () => new Set(activeTrackIdsOrdered),
    [activeTrackIdsOrdered]
  );
  const activeTrackStatus: PlaybackFocusStatus = playbackState.status;
  const activeTrackIsStale = Boolean(playbackState.stale);
  const activeQueueTrackIndex = useMemo(
    () => findBestQueueTrackMatchIndex(queue.items, activeTrackIdSet),
    [activeTrackIdSet, queue.items]
  );
  const resolvedActiveQueueId =
    activeQueueTrackIndex >= 0
      ? queue.items[activeQueueTrackIndex]?.queueId ?? null
      : activeQueueId;

  const currentIndex = useMemo(() => {
    if (!resolvedActiveQueueId) return -1;
    return queue.items.findIndex((item) => item.queueId === resolvedActiveQueueId);
  }, [resolvedActiveQueueId, queue.items]);

  const nextQueueId =
    currentIndex >= 0 && currentIndex + 1 < queue.items.length
      ? queue.items[currentIndex + 1].queueId
      : null;

  const hasItems = queue.items.length > 0;
  const queueCountLabel = `${queue.items.length} ${
    queue.items.length === 1 ? "track" : "tracks"
  }`;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncSelection = () => {
      setSelectedPlaylistId(readSelectedPlaylistId());
    };
    syncSelection();
    window.addEventListener("storage", syncSelection);
    window.addEventListener("focus", syncSelection);
    return () => {
      window.removeEventListener("storage", syncSelection);
      window.removeEventListener("focus", syncSelection);
    };
  }, []);

  useEffect(() => {
    if (activeQueueTrackIndex < 0) return;
    const container = queueRowsRef.current;
    if (!container) return;
    const targetTop = activeQueueTrackIndex * TRACK_ROW_HEIGHT;
    window.requestAnimationFrame(() => {
      animateScrollTop(container, targetTop, {
        minDurationMs: 360,
        maxDurationMs: 1150,
        pxPerMs: 2.0,
      });
    });
  }, [activeQueueTrackIndex]);

  function handleDragStart(queueId: string, event: DragEvent<HTMLLIElement>) {
    setDraggingQueueId(queueId);
    setDragOverQueueId(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.dropEffect = "move";
    try {
      event.dataTransfer.setData("text/plain", queueId);
    } catch {
      // Some browsers can reject custom drag payloads; reorder still works via state.
    }
  }

  function handleDragOver(queueId: string, event: DragEvent<HTMLLIElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dragOverQueueId !== queueId) {
      setDragOverQueueId(queueId);
    }
  }

  function handleDrop(targetQueueId: string, event: DragEvent<HTMLLIElement>) {
    event.preventDefault();
    const sourceQueueId =
      draggingQueueId || event.dataTransfer.getData("text/plain") || null;
    if (!sourceQueueId || sourceQueueId === targetQueueId) {
      setDraggingQueueId(null);
      setDragOverQueueId(null);
      return;
    }

    const fromIndex = queue.items.findIndex((item) => item.queueId === sourceQueueId);
    const toIndex = queue.items.findIndex((item) => item.queueId === targetQueueId);
    if (fromIndex >= 0 && toIndex >= 0) {
      queue.reorderTracks(fromIndex, toIndex);
    }

    setDraggingQueueId(null);
    setDragOverQueueId(null);
  }

  function handleClearQueue() {
    if (!hasItems) return;
    if (queue.items.length > 1) {
      const approved = window.confirm("Weet je zeker dat je Georgies Queue wilt leegmaken?");
      if (!approved) return;
    }
    queue.clearQueue();
  }

  async function handleSelectArtist(item: QueueItem) {
    const selection = await resolveArtistSelection(item);
    if (!selection.artistId) return;
    writeMyMusicSelection({
      mode: "artists",
      artistId: selection.artistId,
    });
    router.push("/");
  }

  function handleSelectAlbum(item: QueueItem) {
    const albumSelectionId = createAlbumSelectionId(item);
    if (!albumSelectionId) return;
    writeMyMusicSelection({
      mode: "albums",
      albumId: albumSelectionId,
    });
    router.push("/");
  }

  return (
    <section className={styles.page} aria-label="Georgies Queue">
      {queue.hydrated && hasItems ? (
        <div className={`track-list ${styles.tableWrap}`}>
          <div className={`track-header ${styles.queueHeader}`}>
            <div />
            <div>Track</div>
            <div className={styles.statusHeader}>Status</div>
            <div className={styles.durationHeader}>Duur</div>
            <div className={styles.actionsHeader}>Acties</div>
          </div>
          <ol
            className={styles.queueRows}
            aria-label="Georgies Queue tracks"
            ref={queueRowsRef}
          >
            {queue.items.map((item, index) => {
              const isStarting = playback.startingQueueId === item.queueId;
              const isCurrent = index === activeQueueTrackIndex;
              const trackStatus: PlaybackFocusStatus = isCurrent ? activeTrackStatus : "idle";
              const isPaused = trackStatus === "paused";
              const isLoading = trackStatus === "loading";
              const isEnded = trackStatus === "ended";
              const isError = trackStatus === "error";
              const isStale = isCurrent && activeTrackIsStale;
              const rowStateClasses = `${isCurrent ? " playing" : ""}${isPaused ? " paused" : ""}${
                isStale ? " stale" : ""
              }${isLoading ? " loading" : ""}${isEnded ? " ended" : ""}${isError ? " error" : ""}`;
              const isNext = queue.mode === "queue" && !isCurrent && item.queueId === nextQueueId;
              const isDragged = draggingQueueId === item.queueId;
              const isDragOver = dragOverQueueId === item.queueId;
              const selectedPlaylistMembership = selectedPlaylistId
                ? Array.isArray(item.playlists)
                  ? item.playlists.some((playlist) => playlist.id === selectedPlaylistId)
                  : undefined
                : undefined;

              return (
                <li
                  key={item.queueId}
                  data-queue-id={item.queueId}
                  className={`track-row ${styles.queueRow}`}
                  draggable
                  onDragStart={(event) => handleDragStart(item.queueId, event)}
                  onDragOver={(event) => handleDragOver(item.queueId, event)}
                  onDrop={(event) => handleDrop(item.queueId, event)}
                  onDragEnd={() => {
                    setDraggingQueueId(null);
                    setDragOverQueueId(null);
                  }}
                >
                  <div
                    className={`track-row-inner${rowStateClasses} ${
                      styles.queueRowInner
                    } ${isDragged ? styles.queueRowDragging : ""} ${
                      isDragOver ? styles.queueRowDragOver : ""
                    }`}
                  >
                    <div className={styles.coverCell}>
                      <span className={styles.dragHandle} aria-hidden="true">
                        ⋮⋮
                      </span>
                      <button
                        type="button"
                        className={`play-btn ${styles.queueInlinePlayBtn}`}
                        onClick={() => void playback.playFromQueue(item.queueId)}
                        disabled={playback.busy || !playback.ready}
                        aria-label={`Start ${item.name} in queue`}
                        title="Start hier"
                      >
                        ▶
                      </button>
                      {item.artworkUrl ? (
                        <Image
                          src={item.artworkUrl}
                          alt={item.name}
                          width={48}
                          height={48}
                          className={styles.artwork}
                          unoptimized
                        />
                      ) : (
                        <div className={`${styles.artwork} ${styles.artworkPlaceholder}`} />
                      )}
                    </div>

                    <div className="track-col-track">
                      <div className="track-title-line" title={item.name}>
                        <span className="track-title-text">{item.name}</span>
                        {isCurrent ? (
                          <ActiveTrackIndicator status={trackStatus} isStale={isStale} />
                        ) : null}
                        {item.explicit === 1 ? (
                          <span className={styles.explicitBadge} aria-label="Explicit">
                            E
                          </span>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="track-meta-link text-body track-artist-line"
                        title={item.artists || "Onbekende artiest"}
                        onClick={() => void handleSelectArtist(item)}
                      >
                        {item.artists || "Onbekende artiest"}
                      </button>
                      <button
                        type="button"
                        className={`track-meta-link text-subtle track-album-line ${styles.trackMetaUri}`}
                        title={item.albumName || "Onbekend album"}
                        onClick={() => handleSelectAlbum(item)}
                        disabled={!createAlbumSelectionId(item)}
                      >
                        {item.albumName || "Onbekend album"}
                      </button>
                    </div>

                    <div className={`track-col-playlists ${styles.statusCell}`}>
                      <span
                        className={`${styles.statusPill} ${
                          isCurrent
                            ? styles.statusNow
                            : isNext
                            ? styles.statusNext
                            : styles.statusQueued
                        } ${isStarting ? styles.statusStarting : ""}`}
                      >
                        {isCurrent
                          ? isStarting
                            ? "Starten..."
                            : "Nu spelend"
                          : isNext
                          ? "Volgende"
                          : "Queue"}
                      </span>
                      {typeof selectedPlaylistMembership === "boolean" ? (
                        <span
                          className={`${styles.statusPlaylist} ${
                            selectedPlaylistMembership
                              ? styles.statusPlaylistIn
                              : styles.statusPlaylistOut
                          }`}
                        >
                          {selectedPlaylistMembership ? "In selectie" : "Niet in selectie"}
                        </span>
                      ) : null}
                    </div>

                    <div className={`text-subtle track-col-duration ${styles.durationCell}`}>
                      {formatDuration(item.durationMs)}
                    </div>

                    <div className={`track-col-actions track-actions-group ${styles.actionsCell}`}>
                      <button
                        type="button"
                        className={`detail-btn ${styles.queueActionBtn} ${styles.queueRemoveBtn}`}
                        onClick={() => queue.removeTrack(item.queueId)}
                        disabled={playback.busy}
                        aria-label={`Verwijder ${item.name} uit Georgies Queue`}
                        title="Verwijder"
                      >
                        −
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      {!queue.hydrated ? (
        <div className={styles.empty} role="status">
          Queue laden...
        </div>
      ) : null}

      {queue.hydrated && !hasItems ? (
        <div className={styles.empty} role="status">
          <div className={styles.emptyTitle}>Je queue is leeg</div>
          <p className="text-body" style={{ margin: 0 }}>
            Voeg tracks toe met de <strong>＋ Queue</strong> knop in de lijsten.
          </p>
        </div>
      ) : null}

      {queue.hydrated && hasItems ? (
        <div className={styles.footerBar}>
          <div className={styles.count}>{queueCountLabel}</div>
          <div className={styles.headerActions}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleClearQueue}
              disabled={!hasItems || playback.busy}
            >
              Clear Queue
            </button>
          </div>
        </div>
      ) : null}

      {!playback.ready ? (
        <div className={styles.info} role="status">
          Player initialiseren...
        </div>
      ) : null}

      {playback.error ? (
        <div className={styles.error} role="alert">
          <span>{playback.error}</span>
          <button type="button" className="btn btn-ghost" onClick={playback.clearError}>
            Sluiten
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ActiveTrackIndicator({
  status,
  isStale,
}: {
  status: PlaybackFocusStatus;
  isStale: boolean;
}) {
  const ariaLabel =
    status === "playing"
      ? "Now playing"
      : status === "paused"
      ? "Gepauzeerd"
      : status === "loading"
      ? "Buffering"
      : status === "ended"
      ? "Track beëindigd"
      : status === "error"
      ? "Playback fout"
      : "Actieve track";
  return (
    <span
      className={`playing-indicator ${status}${isStale ? " stale" : ""}`}
      aria-label={ariaLabel}
    >
      {status === "playing" ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className="playing-indicator-icon equalizer"
        >
          <rect x="1" y="7" width="2.2" height="8" rx="1" />
          <rect x="6.1" y="3" width="2.2" height="12" rx="1" />
          <rect x="11.2" y="5.5" width="2.2" height="9.5" rx="1" />
        </svg>
      ) : status === "loading" ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className="playing-indicator-icon spinner"
        >
          <circle cx="8" cy="8" r="5.5" fill="none" strokeWidth="2.2" opacity="0.35" />
          <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" fill="none" strokeWidth="2.2" />
        </svg>
      ) : status === "paused" ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className="playing-indicator-icon"
        >
          <path d="M4.2 3.2h2.6v9.6H4.2zM9.2 3.2h2.6v9.6H9.2z" />
        </svg>
      ) : status === "ended" ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className="playing-indicator-icon"
        >
          <path d="M8 2.2a5.8 5.8 0 1 0 5.65 7.1h-1.8A4.2 4.2 0 1 1 8 3.8c1.1 0 2.08.42 2.82 1.1L8.9 6.82h4.9v-4.9l-1.74 1.74A5.73 5.73 0 0 0 8 2.2Z" />
        </svg>
      ) : status === "error" ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className="playing-indicator-icon"
        >
          <path d="M8 1.8 1.6 13.6h12.8L8 1.8Zm-.8 4.1h1.6v4.3H7.2V5.9Zm0 5.3h1.6v1.6H7.2v-1.6Z" />
        </svg>
      ) : (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className="playing-indicator-icon"
        >
          <path d="M4.4 3.2v9.6l8-4.8-8-4.8Z" />
        </svg>
      )}
    </span>
  );
}
