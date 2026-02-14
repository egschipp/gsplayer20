"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePlayer } from "@/app/components/player/PlayerProvider";
import { useQueueStore } from "@/lib/queue/QueueProvider";
import { PlaybackCommandQueue } from "./commandQueue";
import {
  type PlaybackApiError,
  fetchPlaybackStateSnapshot,
} from "@/lib/spotify/webPlaybackApi";

type QueuePlaybackContextValue = {
  playFromQueue: (queueId: string) => Promise<void>;
  playNextFromQueue: () => Promise<void>;
  playPreviousFromQueue: () => Promise<void>;
  busy: boolean;
  error: string | null;
  clearError: () => void;
};

const QueuePlaybackContext = createContext<QueuePlaybackContextValue | null>(null);

function mapPlaybackError(error: unknown) {
  const candidate = error as Partial<PlaybackApiError>;
  if (typeof candidate?.status === "number") {
    if (candidate.status === 401) return "Spotify-sessie verlopen. Log opnieuw in.";
    if (candidate.status === 403) return "Ontbrekende Spotify-rechten voor playback.";
    if (candidate.status === 404) return "Geen actieve Spotify player gevonden.";
    if (candidate.status === 429) {
      const retryAfter =
        typeof candidate.retryAfterSec === "number" && candidate.retryAfterSec > 0
          ? candidate.retryAfterSec
          : 1;
      return `Spotify is druk. Probeer opnieuw over ${retryAfter}s.`;
    }
  }
  const message =
    typeof (error as { message?: string })?.message === "string"
      ? (error as { message: string }).message
      : "Queue playback kon niet uitgevoerd worden.";
  return message;
}

export function QueuePlaybackProvider({ children }: { children: React.ReactNode }) {
  const queue = useQueueStore();
  const { api, currentTrackId } = usePlayer();
  const commandQueueRef = useRef(new PlaybackCommandQueue());
  const pendingRef = useRef(0);
  const queueRef = useRef(queue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastAutoAdvancedQueueIdRef = useRef<string | null>(null);
  const pendingQueueIdRef = useRef<string | null>(null);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  const runCommand = useCallback(async (task: () => Promise<void>) => {
    pendingRef.current += 1;
    setBusy(true);
    try {
      await commandQueueRef.current.enqueue(task);
    } finally {
      pendingRef.current -= 1;
      if (pendingRef.current <= 0) {
        pendingRef.current = 0;
        setBusy(false);
      }
    }
  }, []);

  const captureFallbackContext = useCallback(async () => {
    try {
      const state = await fetchPlaybackStateSnapshot();
      if (!state) {
        queueRef.current.setFallbackContext(null);
        return;
      }
      queueRef.current.setFallbackContext({
        contextUri: state.contextUri,
        trackUri: state.itemUri,
        progressMs: state.progressMs,
        isPlaying: state.isPlaying,
        capturedAt: Date.now(),
      });
    } catch {
      queueRef.current.setFallbackContext(null);
    }
  }, []);

  const resumeFallbackContext = useCallback(async () => {
    const snapshot = queueRef.current;
    snapshot.setMode("idle");
    snapshot.setCurrentQueueId(null);

    const fallback = snapshot.fallbackContext;
    if (!fallback?.contextUri || !api) {
      snapshot.setFallbackContext(null);
      return;
    }

    await api.playContext(fallback.contextUri, undefined, fallback.trackUri ?? undefined);
    snapshot.setFallbackContext(null);
  }, [api]);

  const playFromQueue = useCallback(
    async (queueId: string) => {
      await runCommand(async () => {
        const snapshot = queueRef.current;
        const item = snapshot.items.find((entry) => entry.queueId === queueId);
        if (!item) return;
        if (!api) throw new Error("Spotify Web Playback SDK is nog niet klaar.");

        if (snapshot.mode !== "queue") {
          await captureFallbackContext();
        }

        await api.playQueue([item.uri], item.uri, 0);
        snapshot.setMode("queue");
        snapshot.setCurrentQueueId(item.queueId);
        pendingQueueIdRef.current = item.queueId;
        lastAutoAdvancedQueueIdRef.current = null;
        setError(null);
      }).catch((err) => {
        setError(mapPlaybackError(err));
      });
    },
    [api, captureFallbackContext, runCommand]
  );

  const playNextFromQueue = useCallback(async () => {
    await runCommand(async () => {
      const snapshot = queueRef.current;
      if (!snapshot.items.length) {
        await resumeFallbackContext();
        return;
      }
      if (!api) throw new Error("Spotify Web Playback SDK is nog niet klaar.");

      const currentIndex = snapshot.currentQueueId
        ? snapshot.items.findIndex((entry) => entry.queueId === snapshot.currentQueueId)
        : -1;
      const nextIndex = currentIndex + 1;

      if (nextIndex < 0 || nextIndex >= snapshot.items.length) {
        await resumeFallbackContext();
        return;
      }

      const nextItem = snapshot.items[nextIndex];
      await api.playQueue([nextItem.uri], nextItem.uri, 0);
      snapshot.setMode("queue");
      snapshot.setCurrentQueueId(nextItem.queueId);
      pendingQueueIdRef.current = nextItem.queueId;
      lastAutoAdvancedQueueIdRef.current = null;
      setError(null);
    }).catch((err) => {
      setError(mapPlaybackError(err));
    });
  }, [api, resumeFallbackContext, runCommand]);

  const playPreviousFromQueue = useCallback(async () => {
    await runCommand(async () => {
      const snapshot = queueRef.current;
      if (!snapshot.items.length) return;
      if (!api) throw new Error("Spotify Web Playback SDK is nog niet klaar.");

      const currentIndex = snapshot.currentQueueId
        ? snapshot.items.findIndex((entry) => entry.queueId === snapshot.currentQueueId)
        : 0;
      const previousIndex = Math.max(0, currentIndex - 1);
      const previousItem = snapshot.items[previousIndex];
      if (!previousItem) return;

      await api.playQueue([previousItem.uri], previousItem.uri, 0);
      snapshot.setMode("queue");
      snapshot.setCurrentQueueId(previousItem.queueId);
      pendingQueueIdRef.current = previousItem.queueId;
      lastAutoAdvancedQueueIdRef.current = null;
      setError(null);
    }).catch((err) => {
      setError(mapPlaybackError(err));
    });
  }, [api, runCommand]);

  useEffect(() => {
    if (!currentTrackId) return;
    if (queue.mode !== "queue") return;
    const matchedItem = queue.items.find((item) => item.trackId === currentTrackId);
    if (!matchedItem) return;
    if (queue.currentQueueId === matchedItem.queueId) {
      pendingQueueIdRef.current = null;
      return;
    }
    queue.setCurrentQueueId(matchedItem.queueId);
    pendingQueueIdRef.current = null;
    lastAutoAdvancedQueueIdRef.current = null;
  }, [currentTrackId, queue]);

  useEffect(() => {
    if (!queue.hydrated) return;
    if (queue.mode !== "queue") return;
    if (!api) return;
    if (!queue.currentQueueId) return;
    if (!currentTrackId) return;
    if (pendingQueueIdRef.current === queue.currentQueueId) return;
    const currentInQueue = queue.items.some((item) => item.trackId === currentTrackId);
    if (currentInQueue) return;
    void playFromQueue(queue.currentQueueId);
  }, [
    api,
    currentTrackId,
    playFromQueue,
    queue.currentQueueId,
    queue.hydrated,
    queue.items,
    queue.mode,
  ]);

  useEffect(() => {
    if (!queue.hydrated) return;
    if (queue.mode !== "queue") return;
    if (queue.items.length === 0) {
      void resumeFallbackContext();
      return;
    }
    if (queue.currentQueueId && queue.items.some((item) => item.queueId === queue.currentQueueId)) {
      return;
    }
    const first = queue.items[0];
    if (!first) return;
    queue.setCurrentQueueId(first.queueId);
    void playFromQueue(first.queueId);
  }, [playFromQueue, queue, resumeFallbackContext]);

  useEffect(() => {
    if (!queue.hydrated) return;
    if (queue.mode !== "queue" || !queue.currentQueueId) return;

    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      try {
        const playback = await fetchPlaybackStateSnapshot();
        if (cancelled || !playback) return;

        const snapshot = queueRef.current;
        const activeItem = snapshot.items.find(
          (item) => item.queueId === snapshot.currentQueueId
        );
        if (!activeItem) return;

        if (playback.trackId && playback.trackId !== activeItem.trackId) {
          const matched = snapshot.items.find((item) => item.trackId === playback.trackId);
          if (matched) {
            snapshot.setCurrentQueueId(matched.queueId);
            pendingQueueIdRef.current = null;
            lastAutoAdvancedQueueIdRef.current = null;
          }
          return;
        }

        const nearEnd =
          playback.durationMs > 0 && playback.progressMs >= playback.durationMs - 900;
        const ended =
          !playback.isPlaying &&
          playback.durationMs > 0 &&
          playback.progressMs >= playback.durationMs - 1200;

        if (
          (nearEnd || ended) &&
          lastAutoAdvancedQueueIdRef.current !== activeItem.queueId
        ) {
          lastAutoAdvancedQueueIdRef.current = activeItem.queueId;
          await playNextFromQueue();
        }
      } catch (err) {
        setError(mapPlaybackError(err));
      }
    };

    const interval = window.setInterval(() => {
      void tick();
    }, 1000);
    void tick();

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [playNextFromQueue, queue.currentQueueId, queue.hydrated, queue.mode]);

  const value = useMemo<QueuePlaybackContextValue>(
    () => ({
      playFromQueue,
      playNextFromQueue,
      playPreviousFromQueue,
      busy,
      error,
      clearError: () => setError(null),
    }),
    [busy, error, playFromQueue, playNextFromQueue, playPreviousFromQueue]
  );

  return (
    <QueuePlaybackContext.Provider value={value}>{children}</QueuePlaybackContext.Provider>
  );
}

export function useQueuePlayback() {
  const value = useContext(QueuePlaybackContext);
  if (!value) {
    throw new Error("useQueuePlayback must be used within QueuePlaybackProvider");
  }
  return value;
}
