"use client";

import Image from "next/image";
import { type DragEvent, useMemo, useState } from "react";
import { useQueueStore } from "@/lib/queue/QueueProvider";
import { useQueuePlayback } from "@/lib/playback/QueuePlaybackProvider";
import { QUEUE_GRID_COLUMNS } from "@/lib/ui/trackLayout";
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
  const [draggingQueueId, setDraggingQueueId] = useState<string | null>(null);
  const [dragOverQueueId, setDragOverQueueId] = useState<string | null>(null);
  const activeQueueId = playback.activeQueueId ?? queue.currentQueueId;

  const currentIndex = useMemo(() => {
    if (!activeQueueId) return -1;
    return queue.items.findIndex((item) => item.queueId === activeQueueId);
  }, [activeQueueId, queue.items]);

  const nextQueueId =
    currentIndex >= 0 && currentIndex + 1 < queue.items.length
      ? queue.items[currentIndex + 1].queueId
      : null;

  const hasItems = queue.items.length > 0;

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
      const approved = window.confirm("Weet je zeker dat je de custom queue wilt leegmaken?");
      if (!approved) return;
    }
    queue.clearQueue();
  }

  return (
    <section className={styles.page} aria-labelledby="queue-title">
      <div className={styles.header}>
        <div>
          <h1 id="queue-title" className="heading-2">
            Custom Queue
          </h1>
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
          <div
            className={`track-header ${styles.queueHeader}`}
            style={{ gridTemplateColumns: QUEUE_GRID_COLUMNS }}
          >
            <div />
            <div>Track</div>
            <div className={styles.statusHeader}>Status</div>
            <div className={styles.durationHeader}>Duur</div>
            <div className={styles.actionsHeader}>Acties</div>
          </div>
          <ol className={styles.queueRows} aria-label="Custom queue tracks">
            {queue.items.map((item) => {
              const isCurrent = queue.mode === "queue" && item.queueId === activeQueueId;
              const isStarting = playback.startingQueueId === item.queueId;
              const isNext = item.queueId === nextQueueId;
              const isDragged = draggingQueueId === item.queueId;
              const isDragOver = dragOverQueueId === item.queueId;

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
                    style={{ gridTemplateColumns: QUEUE_GRID_COLUMNS }}
                  >
                    <div className={styles.coverCell}>
                      <span className={styles.dragHandle} aria-hidden="true">
                        ⋮⋮
                      </span>
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
                      </div>
                      <div
                        className="text-body track-artist-line"
                        title={item.artists || "Onbekende artiest"}
                      >
                        {item.artists || "Onbekende artiest"}
                      </div>
                    </div>

                    <div className={`track-col-playlists ${styles.statusCell}`}>
                      {isCurrent ? (
                        <span
                          className={`${styles.statusPill} ${styles.statusNow} ${
                            isStarting ? styles.statusStarting : ""
                          }`}
                        >
                          {isStarting ? "Starten..." : "Nu spelend"}
                        </span>
                      ) : isNext ? (
                        <span className={`${styles.statusPill} ${styles.statusNext}`}>
                          Volgende
                        </span>
                      ) : (
                        <span className={`${styles.statusPill} ${styles.statusQueued}`}>
                          Queue
                        </span>
                      )}
                    </div>

                    <div className={`text-subtle track-col-duration ${styles.durationCell}`}>
                      {formatDuration(item.durationMs)}
                    </div>

                    <div className={`track-col-actions track-actions-group ${styles.actionsCell}`}>
                      <button
                        type="button"
                        className={`detail-btn ${styles.queueActionBtn} ${styles.queueStartBtn}`}
                        onClick={() => void playback.playFromQueue(item.queueId)}
                        disabled={playback.busy}
                        aria-label={`Start ${item.name} in queue`}
                        title="Start hier"
                      >
                        ▶
                      </button>
                      <button
                        type="button"
                        className={`detail-btn ${styles.queueActionBtn} ${styles.queueRemoveBtn}`}
                        onClick={() => queue.removeTrack(item.queueId)}
                        disabled={playback.busy}
                        aria-label={`Verwijder ${item.name} uit custom queue`}
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
