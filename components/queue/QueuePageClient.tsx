"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { type DragEvent, useEffect, useMemo, useState } from "react";
import { useQueueStore } from "@/lib/queue/QueueProvider";
import { useQueuePlayback } from "@/lib/playback/QueuePlaybackProvider";
import { type QueueItem } from "@/lib/queue/types";
import styles from "./QueuePageClient.module.css";

function formatDuration(ms: number | null) {
  if (!ms || ms <= 0) return "--:--";
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
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
  const [draggingQueueId, setDraggingQueueId] = useState<string | null>(null);
  const [dragOverQueueId, setDragOverQueueId] = useState<string | null>(null);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const activeQueueId = playback.startingQueueId ?? playback.activeQueueId ?? queue.currentQueueId;

  const currentIndex = useMemo(() => {
    if (!activeQueueId) return -1;
    return queue.items.findIndex((item) => item.queueId === activeQueueId);
  }, [activeQueueId, queue.items]);

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
    <section className={styles.page} aria-labelledby="queue-title">
      <div className={styles.header}>
        <div>
          <h1 id="queue-title" className="heading-2">
            Georgies Queue
          </h1>
          <div className={styles.count}>{queueCountLabel}</div>
        </div>
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

      {playback.error ? (
        <div className={styles.error} role="alert">
          <span>{playback.error}</span>
          <button type="button" className="btn btn-ghost" onClick={playback.clearError}>
            Sluiten
          </button>
        </div>
      ) : null}

      {!playback.ready ? (
        <div className={styles.info} role="status">
          Player initialiseren...
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
        <div className={`track-list ${styles.tableWrap}`}>
          <div className={`track-header ${styles.queueHeader}`}>
            <div />
            <div>Track</div>
            <div className={styles.statusHeader}>Status</div>
            <div className={styles.durationHeader}>Duur</div>
            <div className={styles.actionsHeader}>Acties</div>
          </div>
          <ol className={styles.queueRows} aria-label="Georgies Queue tracks">
            {queue.items.map((item) => {
              const isStarting = playback.startingQueueId === item.queueId;
              const isCurrent =
                item.queueId === activeQueueId &&
                (queue.mode === "queue" || isStarting || playback.busy);
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
                    className={`track-row-inner${isCurrent ? " playing" : ""} ${
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
    </section>
  );
}
