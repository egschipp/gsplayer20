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
  activeQueueId: string | null;
  startingQueueId: string | null;
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
  const [activeQueueId, setActiveQueueId] = useState<string | null>(null);
  const [startingQueueId, setStartingQueueId] = useState<string | null>(null);
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
    setActiveQueueId(null);
    setStartingQueueId(null);
    pendingQueueIdRef.current = null;

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
      setStartingQueueId(queueId);
      setActiveQueueId(queueId);
      await runCommand(async () => {
        const snapshot = queueRef.current;
        const item = snapshot.items.find((entry) => entry.queueId === queueId);
        if (!item) {
          setStartingQueueId(null);
          setActiveQueueId(null);
          return;
        }
        if (!api) throw new Error("Spotify Web Playback SDK is nog niet klaar.");

        if (snapshot.mode !== "queue") {
          await captureFallbackContext();
        }

        pendingQueueIdRef.current = item.queueId;
        await api.playQueue([item.uri], item.uri, 0);
        snapshot.setMode("queue");
        snapshot.setCurrentQueueId(item.queueId);
        lastAutoAdvancedQueueIdRef.current = null;
        setError(null);
      }).catch((err) => {
        pendingQueueIdRef.current = null;
        setStartingQueueId(null);
        setActiveQueueId((prev) => (prev === queueId ? null : prev));
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
      setStartingQueueId(nextItem.queueId);
      setActiveQueueId(nextItem.queueId);
      pendingQueueIdRef.current = nextItem.queueId;
      await api.playQueue([nextItem.uri], nextItem.uri, 0);
      snapshot.setMode("queue");
      snapshot.setCurrentQueueId(nextItem.queueId);
      lastAutoAdvancedQueueIdRef.current = null;
      setError(null);
    }).catch((err) => {
      pendingQueueIdRef.current = null;
      setStartingQueueId(null);
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

      setStartingQueueId(previousItem.queueId);
      setActiveQueueId(previousItem.queueId);
      pendingQueueIdRef.current = previousItem.queueId;
      await api.playQueue([previousItem.uri], previousItem.uri, 0);
      snapshot.setMode("queue");
      snapshot.setCurrentQueueId(previousItem.queueId);
      lastAutoAdvancedQueueIdRef.current = null;
      setError(null);
    }).catch((err) => {
      pendingQueueIdRef.current = null;
      setStartingQueueId(null);
      setError(mapPlaybackError(err));
    });
  }, [api, runCommand]);

  useEffect(() => {
    if (queue.mode !== "queue") {
      setActiveQueueId(null);
      setStartingQueueId(null);
      pendingQueueIdRef.current = null;
      return;
    }

    if (!currentTrackId) {
      setActiveQueueId(startingQueueId ?? queue.currentQueueId ?? null);
      return;
    }

    const preferredQueueId = pendingQueueIdRef.current ?? queue.currentQueueId ?? null;
    const preferredItem = preferredQueueId
      ? queue.items.find((item) => item.queueId === preferredQueueId)
      : null;
    const resolvedQueueId =
      preferredItem?.trackId === currentTrackId
        ? preferredItem.queueId
        : queue.items.find((item) => item.trackId === currentTrackId)?.queueId ?? null;
    if (!resolvedQueueId) return;

    if (queue.currentQueueId !== resolvedQueueId) {
      queue.setCurrentQueueId(resolvedQueueId);
    }

    setActiveQueueId(resolvedQueueId);
    if (startingQueueId === resolvedQueueId) {
      setStartingQueueId(null);
    }
    pendingQueueIdRef.current = null;
    lastAutoAdvancedQueueIdRef.current = null;
  }, [currentTrackId, queue, startingQueueId]);

  useEffect(() => {
    if (!queue.hydrated) return;
    if (queue.mode !== "queue") return;
    if (!api) return;
    if (!queue.currentQueueId) return;
    if (!currentTrackId) return;
    if (pendingQueueIdRef.current === queue.currentQueueId) return;
    const currentInQueue = queue.items.some((item) => item.trackId === currentTrackId);
    if (currentInQueue) return;
    // External track selection should immediately release queue lock instead of forcing a rewind.
    queue.setMode("idle");
    setActiveQueueId(null);
    setStartingQueueId(null);
    pendingQueueIdRef.current = null;
    lastAutoAdvancedQueueIdRef.current = null;
  }, [
    api,
    currentTrackId,
    queue.currentQueueId,
    queue.hydrated,
    queue.items,
    queue.mode,
    queue,
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
            setActiveQueueId(matched.queueId);
            if (startingQueueId === matched.queueId) {
              setStartingQueueId(null);
            }
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
  }, [playNextFromQueue, queue.currentQueueId, queue.hydrated, queue.mode, startingQueueId]);

  const value = useMemo<QueuePlaybackContextValue>(
    () => ({
      playFromQueue,
      playNextFromQueue,
      playPreviousFromQueue,
      activeQueueId,
      startingQueueId,
      busy,
      error,
      clearError: () => setError(null),
    }),
    [
      activeQueueId,
      busy,
      error,
      playFromQueue,
      playNextFromQueue,
      playPreviousFromQueue,
      startingQueueId,
    ]
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
