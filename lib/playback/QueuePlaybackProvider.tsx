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
  ready: boolean;
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

  const playQueueAtIndex = useCallback(
    async (
      snapshot: typeof queueRef.current,
      targetIndex: number,
      captureFallback = false
    ) => {
      const item = snapshot.items[targetIndex];
      if (!item) return;
      if (!api) throw new Error("Spotify Web Playback SDK is nog niet klaar.");
      if (captureFallback && snapshot.mode !== "queue") {
        await captureFallbackContext();
      }
      const uris = snapshot.items.map((entry) => entry.uri);
      if (!uris.length) return;
      const offsetIndex = Math.max(0, Math.min(targetIndex, uris.length - 1));
      const targetUri = uris[offsetIndex] ?? item.uri;
      pendingQueueIdRef.current = item.queueId;
      setStartingQueueId(item.queueId);
      setActiveQueueId(item.queueId);
      snapshot.setMode("queue");
      snapshot.setCurrentQueueId(item.queueId);
      await api.playQueue(uris, targetUri, offsetIndex);
      setError(null);
    },
    [api, captureFallbackContext]
  );

  const playFromQueue = useCallback(
    async (queueId: string) => {
      api?.primePlaybackGesture?.();
      setStartingQueueId(queueId);
      setActiveQueueId(queueId);
      await runCommand(async () => {
        const snapshot = queueRef.current;
        const targetIndex = snapshot.items.findIndex(
          (entry) => entry.queueId === queueId
        );
        if (targetIndex < 0) {
          setStartingQueueId(null);
          setActiveQueueId(null);
          pendingQueueIdRef.current = null;
          return;
        }
        await playQueueAtIndex(snapshot, targetIndex, true);
      }).catch((err) => {
        pendingQueueIdRef.current = null;
        setStartingQueueId(null);
        setActiveQueueId((prev) => (prev === queueId ? null : prev));
        setError(mapPlaybackError(err));
      });
    },
    [api, playQueueAtIndex, runCommand]
  );

  const playNextFromQueue = useCallback(async () => {
    if (startingQueueId || pendingQueueIdRef.current) return;
    await runCommand(async () => {
      const snapshot = queueRef.current;
      if (!snapshot.items.length) {
        await resumeFallbackContext();
        return;
      }
      const currentIndexByQueueId = snapshot.currentQueueId
        ? snapshot.items.findIndex((entry) => entry.queueId === snapshot.currentQueueId)
        : -1;
      const currentIndexByTrackId = currentTrackId
        ? snapshot.items.findIndex((entry) => entry.trackId === currentTrackId)
        : -1;
      const currentIndex =
        currentIndexByQueueId >= 0 ? currentIndexByQueueId : currentIndexByTrackId;
      const nextIndex = currentIndex + 1;

      if (nextIndex < 0 || nextIndex >= snapshot.items.length) {
        await resumeFallbackContext();
        return;
      }
      await playQueueAtIndex(snapshot, nextIndex);
    }).catch((err) => {
      pendingQueueIdRef.current = null;
      setStartingQueueId(null);
      setError(mapPlaybackError(err));
    });
  }, [currentTrackId, playQueueAtIndex, resumeFallbackContext, runCommand, startingQueueId]);

  const playPreviousFromQueue = useCallback(async () => {
    if (startingQueueId || pendingQueueIdRef.current) return;
    await runCommand(async () => {
      const snapshot = queueRef.current;
      if (!snapshot.items.length) return;
      const currentIndexByQueueId = snapshot.currentQueueId
        ? snapshot.items.findIndex((entry) => entry.queueId === snapshot.currentQueueId)
        : -1;
      const currentIndexByTrackId = currentTrackId
        ? snapshot.items.findIndex((entry) => entry.trackId === currentTrackId)
        : -1;
      const currentIndex =
        currentIndexByQueueId >= 0
          ? currentIndexByQueueId
          : currentIndexByTrackId >= 0
          ? currentIndexByTrackId
          : 0;
      const previousIndex = Math.max(0, currentIndex - 1);
      await playQueueAtIndex(snapshot, previousIndex);
    }).catch((err) => {
      pendingQueueIdRef.current = null;
      setStartingQueueId(null);
      setError(mapPlaybackError(err));
    });
  }, [currentTrackId, playQueueAtIndex, runCommand, startingQueueId]);

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
  }, [currentTrackId, queue, startingQueueId]);

  useEffect(() => {
    if (!queue.hydrated) return;
    if (queue.mode !== "queue") return;
    if (busy || startingQueueId || pendingQueueIdRef.current) return;
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
  }, [busy, playFromQueue, queue, resumeFallbackContext, startingQueueId]);

  const value = useMemo<QueuePlaybackContextValue>(
    () => ({
      playFromQueue,
      playNextFromQueue,
      playPreviousFromQueue,
      activeQueueId,
      startingQueueId,
      ready: Boolean(api),
      busy,
      error,
      clearError: () => setError(null),
    }),
    [
      api,
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
