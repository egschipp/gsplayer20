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
const SPOTIFY_TRACK_ID_REGEX = /^[A-Za-z0-9]{22}$/;
const QUEUE_PENDING_STALE_MS = 8_000;

function normalizeTrackId(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (SPOTIFY_TRACK_ID_REGEX.test(raw)) return raw;
  if (raw.startsWith("spotify:track:")) {
    const segment = raw.split(":").pop() ?? "";
    const id = segment.split("?")[0]?.trim() ?? "";
    return SPOTIFY_TRACK_ID_REGEX.test(id) ? id : null;
  }
  const embedded = raw.match(/[A-Za-z0-9]{22}/);
  return embedded?.[0] ?? null;
}

function collectQueueItemTrackIds(item: { trackId?: string | null; uri?: string | null }) {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined) => {
    const normalized = normalizeTrackId(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  push(item.trackId);
  push(item.uri);
  return out;
}

function findQueueIndexByTrackIds(
  items: Array<{ trackId?: string | null; uri?: string | null }>,
  activeIds: Set<string>
) {
  if (!items.length || !activeIds.size) return -1;
  for (let index = 0; index < items.length; index += 1) {
    const matches = collectQueueItemTrackIds(items[index]);
    if (matches.some((candidate) => activeIds.has(candidate))) return index;
  }
  return -1;
}

function mapPlaybackError(error: unknown) {
  const candidate = error as Partial<PlaybackApiError>;
  if (typeof candidate?.status === "number") {
    if (candidate.status === 401) return "Spotify session expired. Sign in again.";
    if (candidate.status === 403) return "Missing Spotify playback permissions.";
    if (candidate.status === 404) return "No active Spotify player found.";
    if (candidate.status === 429) {
      const retryAfter =
        typeof candidate.retryAfterSec === "number" && candidate.retryAfterSec > 0
          ? candidate.retryAfterSec
          : 1;
      return `Spotify is busy. Try again in ${retryAfter}s.`;
    }
  }
  const message =
    typeof (error as { message?: string })?.message === "string"
      ? (error as { message: string }).message
      : "Queue playback could not be completed.";
  return message;
}

export function QueuePlaybackProvider({ children }: { children: React.ReactNode }) {
  const queue = useQueueStore();
  const { api, currentTrackId, playbackState } = usePlayer();
  const commandQueueRef = useRef(new PlaybackCommandQueue());
  const pendingRef = useRef(0);
  const queueRef = useRef(queue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeQueueId, setActiveQueueId] = useState<string | null>(null);
  const [startingQueueId, setStartingQueueId] = useState<string | null>(null);
  const pendingQueueIdRef = useRef<string | null>(null);
  const pendingQueueStartedAtRef = useRef(0);

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
    pendingQueueStartedAtRef.current = 0;

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
      if (!api) throw new Error("Spotify Web Playback SDK is not ready yet.");
      if (captureFallback && snapshot.mode !== "queue") {
        await captureFallbackContext();
      }
      const uris = snapshot.items.map((entry) => entry.uri);
      if (!uris.length) return;
      const offsetIndex = Math.max(0, Math.min(targetIndex, uris.length - 1));
      const targetUri = uris[offsetIndex] ?? item.uri;
      pendingQueueIdRef.current = item.queueId;
      pendingQueueStartedAtRef.current = Date.now();
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
          pendingQueueStartedAtRef.current = 0;
          return;
        }
        await playQueueAtIndex(snapshot, targetIndex, true);
      }).catch((err) => {
        pendingQueueIdRef.current = null;
        pendingQueueStartedAtRef.current = 0;
        setStartingQueueId(null);
        setActiveQueueId((prev) => (prev === queueId ? null : prev));
        setError(mapPlaybackError(err));
      });
    },
    [api, playQueueAtIndex, runCommand]
  );

  const playNextFromQueue = useCallback(async () => {
    if (
      (startingQueueId || pendingQueueIdRef.current) &&
      Date.now() - pendingQueueStartedAtRef.current < QUEUE_PENDING_STALE_MS
    ) {
      return;
    }
    if (Date.now() - pendingQueueStartedAtRef.current >= QUEUE_PENDING_STALE_MS) {
      pendingQueueIdRef.current = null;
      pendingQueueStartedAtRef.current = 0;
      setStartingQueueId(null);
    }
    await runCommand(async () => {
      const snapshot = queueRef.current;
      if (!snapshot.items.length) {
        await resumeFallbackContext();
        return;
      }
      const currentIndexByQueueId = snapshot.currentQueueId
        ? snapshot.items.findIndex((entry) => entry.queueId === snapshot.currentQueueId)
        : -1;
      const activeTrackIds = new Set<string>();
      for (const value of [currentTrackId, ...(playbackState.matchTrackIds ?? [])]) {
        const normalized = normalizeTrackId(value);
        if (normalized) activeTrackIds.add(normalized);
      }
      const currentIndexByTrackId = findQueueIndexByTrackIds(snapshot.items, activeTrackIds);
      const currentIndexByMatchIds = currentIndexByTrackId;
      const currentIndex =
        currentIndexByQueueId >= 0
          ? currentIndexByQueueId
          : currentIndexByTrackId >= 0
          ? currentIndexByTrackId
          : currentIndexByMatchIds;
      const nextIndex = currentIndex + 1;

      if (nextIndex < 0 || nextIndex >= snapshot.items.length) {
        await resumeFallbackContext();
        return;
      }
      await playQueueAtIndex(snapshot, nextIndex);
    }).catch((err) => {
      pendingQueueIdRef.current = null;
      pendingQueueStartedAtRef.current = 0;
      setStartingQueueId(null);
      setError(mapPlaybackError(err));
    });
  }, [
    currentTrackId,
    playbackState.matchTrackIds,
    playQueueAtIndex,
    resumeFallbackContext,
    runCommand,
    startingQueueId,
  ]);

  const playPreviousFromQueue = useCallback(async () => {
    if (
      (startingQueueId || pendingQueueIdRef.current) &&
      Date.now() - pendingQueueStartedAtRef.current < QUEUE_PENDING_STALE_MS
    ) {
      return;
    }
    if (Date.now() - pendingQueueStartedAtRef.current >= QUEUE_PENDING_STALE_MS) {
      pendingQueueIdRef.current = null;
      pendingQueueStartedAtRef.current = 0;
      setStartingQueueId(null);
    }
    await runCommand(async () => {
      const snapshot = queueRef.current;
      if (!snapshot.items.length) return;
      const currentIndexByQueueId = snapshot.currentQueueId
        ? snapshot.items.findIndex((entry) => entry.queueId === snapshot.currentQueueId)
        : -1;
      const activeTrackIds = new Set<string>();
      for (const value of [currentTrackId, ...(playbackState.matchTrackIds ?? [])]) {
        const normalized = normalizeTrackId(value);
        if (normalized) activeTrackIds.add(normalized);
      }
      const currentIndexByTrackId = findQueueIndexByTrackIds(snapshot.items, activeTrackIds);
      const currentIndexByMatchIds = currentIndexByTrackId;
      const currentIndex =
        currentIndexByQueueId >= 0
          ? currentIndexByQueueId
          : currentIndexByTrackId >= 0
          ? currentIndexByTrackId
          : currentIndexByMatchIds >= 0
          ? currentIndexByMatchIds
          : 0;
      const previousIndex = Math.max(0, currentIndex - 1);
      await playQueueAtIndex(snapshot, previousIndex);
    }).catch((err) => {
      pendingQueueIdRef.current = null;
      pendingQueueStartedAtRef.current = 0;
      setStartingQueueId(null);
      setError(mapPlaybackError(err));
    });
  }, [currentTrackId, playbackState.matchTrackIds, playQueueAtIndex, runCommand, startingQueueId]);

  useEffect(() => {
    if (queue.mode !== "queue") {
      setActiveQueueId(null);
      setStartingQueueId(null);
      pendingQueueIdRef.current = null;
      pendingQueueStartedAtRef.current = 0;
      return;
    }

    if (!currentTrackId) {
      setActiveQueueId(startingQueueId ?? queue.currentQueueId ?? null);
      return;
    }

    const pendingTooOld =
      pendingQueueStartedAtRef.current > 0 &&
      Date.now() - pendingQueueStartedAtRef.current >= QUEUE_PENDING_STALE_MS;
    if (pendingTooOld) {
      pendingQueueIdRef.current = null;
      pendingQueueStartedAtRef.current = 0;
      if (startingQueueId) {
        setStartingQueueId(null);
      }
    }
    const preferredQueueId = pendingQueueIdRef.current ?? queue.currentQueueId ?? null;
    const preferredItem = preferredQueueId
      ? queue.items.find((item) => item.queueId === preferredQueueId)
      : null;
    const currentTrackNormalized = normalizeTrackId(currentTrackId);
    const matchIds = new Set<string>();
    if (currentTrackNormalized) matchIds.add(currentTrackNormalized);
    for (const value of playbackState.matchTrackIds ?? []) {
      const normalized = normalizeTrackId(value);
      if (normalized) matchIds.add(normalized);
    }
    const preferredMatches = preferredItem ? collectQueueItemTrackIds(preferredItem) : [];
    const preferredMatchesCurrent = preferredMatches.some((id) => matchIds.has(id));
    const resolvedByMatchIndex = findQueueIndexByTrackIds(queue.items, matchIds);
    const resolvedQueueId =
      preferredMatchesCurrent
        ? preferredItem?.queueId ?? null
        : resolvedByMatchIndex >= 0
        ? queue.items[resolvedByMatchIndex]?.queueId ?? null
        : null;
    if (!resolvedQueueId) return;

    if (queue.currentQueueId !== resolvedQueueId) {
      queue.setCurrentQueueId(resolvedQueueId);
    }

    setActiveQueueId(resolvedQueueId);
    if (startingQueueId === resolvedQueueId) {
      setStartingQueueId(null);
    }
    pendingQueueIdRef.current = null;
    pendingQueueStartedAtRef.current = 0;
  }, [currentTrackId, playbackState.matchTrackIds, queue, startingQueueId]);

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
