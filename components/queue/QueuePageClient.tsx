"use client";

import Image from "next/image";
import { type DragEvent, useEffect, useMemo, useState } from "react";
import { useQueueStore } from "@/lib/queue/QueueProvider";
import { useQueuePlayback } from "@/lib/playback/QueuePlaybackProvider";
import { usePlayer } from "@/app/components/player/PlayerProvider";
import {
  type PlaybackStateSnapshot,
  fetchPlaybackStateSnapshot,
} from "@/lib/spotify/webPlaybackApi";
import styles from "./QueuePageClient.module.css";

function formatDuration(ms: number | null) {
  if (!ms || ms <= 0) return "--:--";
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function QueuePageClient() {
  const queue = useQueueStore();
  const playback = useQueuePlayback();
  const { currentTrackId } = usePlayer();
  const [draggingQueueId, setDraggingQueueId] = useState<string | null>(null);
  const [dragOverQueueId, setDragOverQueueId] = useState<string | null>(null);
  const [currentPlayable, setCurrentPlayable] = useState<PlaybackStateSnapshot | null>(null);
  const [loadingCurrentPlayable, setLoadingCurrentPlayable] = useState(false);

  const currentIndex = useMemo(() => {
    if (!queue.currentQueueId) return -1;
    return queue.items.findIndex((item) => item.queueId === queue.currentQueueId);
  }, [queue.currentQueueId, queue.items]);

  const nextQueueId =
    currentIndex >= 0 && currentIndex + 1 < queue.items.length
      ? queue.items[currentIndex + 1].queueId
      : null;

  const hasItems = queue.items.length > 0;

  async function refreshCurrentPlayable() {
    setLoadingCurrentPlayable(true);
    try {
      const snapshot = await fetchPlaybackStateSnapshot();
      setCurrentPlayable(snapshot);
    } catch {
      setCurrentPlayable(null);
    } finally {
      setLoadingCurrentPlayable(false);
    }
  }

  useEffect(() => {
    void refreshCurrentPlayable();
  }, []);

  function handleDragStart(queueId: string) {
    setDraggingQueueId(queueId);
  }

  function handleDragOver(queueId: string, event: DragEvent<HTMLLIElement>) {
    event.preventDefault();
    if (dragOverQueueId !== queueId) {
      setDragOverQueueId(queueId);
    }
  }

  function handleDrop(targetQueueId: string, event: DragEvent<HTMLLIElement>) {
    event.preventDefault();
    if (!draggingQueueId || draggingQueueId === targetQueueId) {
      setDraggingQueueId(null);
      setDragOverQueueId(null);
      return;
    }

    const fromIndex = queue.items.findIndex((item) => item.queueId === draggingQueueId);
    const toIndex = queue.items.findIndex((item) => item.queueId === targetQueueId);
    if (fromIndex >= 0 && toIndex >= 0) {
      queue.reorderTracks(fromIndex, toIndex);
    }

    setDraggingQueueId(null);
    setDragOverQueueId(null);
  }

  async function handleClearQueue() {
    if (!hasItems) return;
    if (queue.items.length > 1) {
      const approved = window.confirm("Weet je zeker dat je de custom queue wilt leegmaken?");
      if (!approved) return;
    }
    queue.clearQueue();
  }

  function handleAddCurrentTrack() {
    if (!currentPlayable?.trackId || !currentPlayable.itemUri) return;
    queue.addTracks([
      {
        uri: currentPlayable.itemUri,
        trackId: currentPlayable.trackId,
        name: currentPlayable.trackName || "Onbekend nummer",
        artists: currentPlayable.artistNames || "Onbekende artiest",
        durationMs: currentPlayable.durationMs || null,
        artworkUrl: currentPlayable.artworkUrl || null,
      },
    ]);
  }

  return (
    <section className={styles.page} aria-labelledby="queue-title">
      <div className={styles.header}>
        <div>
          <h1 id="queue-title" className="heading-2" style={{ marginBottom: 6 }}>
            Custom Queue
          </h1>
          <p className="text-body" style={{ margin: 0 }}>
            Beheer je eigen afspeelvolgorde los van Spotify Queue.
          </p>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleAddCurrentTrack}
            disabled={!currentPlayable?.trackId || !currentPlayable?.itemUri || playback.busy}
          >
            Voeg Nu Spelend Toe
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              if (queue.currentQueueId) {
                void playback.playFromQueue(queue.currentQueueId);
              } else if (queue.items[0]) {
                void playback.playFromQueue(queue.items[0].queueId);
              }
            }}
            disabled={!hasItems || playback.busy}
          >
            Start Queue
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void playback.playPreviousFromQueue()}
            disabled={!hasItems || playback.busy}
          >
            Vorige
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void playback.playNextFromQueue()}
            disabled={!hasItems || playback.busy}
          >
            Volgende
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleClearQueue}
            disabled={!hasItems || playback.busy}
          >
            Clear Queue
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void refreshCurrentPlayable()}
            disabled={loadingCurrentPlayable}
          >
            {loadingCurrentPlayable ? "Vernieuwen..." : "Vernieuw Track"}
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

      {!queue.hydrated ? (
        <div className={styles.empty} role="status">
          Queue laden...
        </div>
      ) : null}

      {queue.hydrated && !hasItems ? (
        <div className={styles.empty} role="status">
          <div className={styles.emptyTitle}>Je queue is leeg</div>
          <p className="text-body" style={{ margin: 0 }}>
            Start een track en klik op <strong>Voeg Nu Spelend Toe</strong>.
          </p>
        </div>
      ) : null}

      {queue.hydrated && hasItems ? (
        <ol className={styles.list} aria-label="Custom queue tracks">
          {queue.items.map((item) => {
            const isCurrent =
              queue.mode === "queue" &&
              item.queueId === queue.currentQueueId &&
              currentTrackId === item.trackId;
            const isNext = item.queueId === nextQueueId;
            const isDragged = draggingQueueId === item.queueId;
            const isDragOver = dragOverQueueId === item.queueId;

            return (
              <li
                key={item.queueId}
                className={`${styles.item} ${isCurrent ? styles.itemCurrent : ""} ${
                  isNext ? styles.itemNext : ""
                } ${isDragged ? styles.itemDragging : ""} ${
                  isDragOver ? styles.itemDragOver : ""
                }`}
                draggable
                onDragStart={() => handleDragStart(item.queueId)}
                onDragOver={(event) => handleDragOver(item.queueId, event)}
                onDrop={(event) => handleDrop(item.queueId, event)}
                onDragEnd={() => {
                  setDraggingQueueId(null);
                  setDragOverQueueId(null);
                }}
              >
                <div className={styles.itemLeft}>
                  {item.artworkUrl ? (
                    <Image
                      src={item.artworkUrl}
                      alt={item.name}
                      width={52}
                      height={52}
                      className={styles.artwork}
                      unoptimized
                    />
                  ) : (
                    <div className={`${styles.artwork} ${styles.artworkPlaceholder}`} />
                  )}
                  <div className={styles.itemCopy}>
                    <div className={styles.itemName}>{item.name}</div>
                    <div className={styles.itemArtist}>{item.artists || "Onbekende artiest"}</div>
                  </div>
                </div>

                <div className={styles.itemMeta}>
                  {isCurrent ? (
                    <span className={`${styles.pill} ${styles.pillNow}`}>Nu spelend</span>
                  ) : null}
                  {!isCurrent && isNext ? (
                    <span className={`${styles.pill} ${styles.pillNext}`}>Volgende</span>
                  ) : null}
                  <span className={styles.duration}>{formatDuration(item.durationMs)}</span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void playback.playFromQueue(item.queueId)}
                    disabled={playback.busy}
                  >
                    Speel
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => queue.removeTrack(item.queueId)}
                    disabled={playback.busy}
                    aria-label={`Verwijder ${item.name} uit custom queue`}
                  >
                    Verwijder
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
