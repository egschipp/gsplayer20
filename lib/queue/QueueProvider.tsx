"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type QueueActionApi,
  type QueueFallbackContext,
  type QueueItem,
  type QueuePlaybackMode,
  type QueueSnapshot,
  type QueueStore,
  type QueueTrackInput,
} from "./types";

const STORAGE_KEY = "gs_custom_queue_v1";

const initialSnapshot: QueueSnapshot = {
  items: [],
  currentQueueId: null,
  mode: "idle",
  fallbackContext: null,
};

const QueueContext = createContext<QueueStore | null>(null);

function createQueueId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isQueueItem(value: unknown): value is QueueItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<QueueItem>;
  return Boolean(
    typeof item.queueId === "string" &&
      typeof item.uri === "string" &&
      typeof item.trackId === "string" &&
      typeof item.name === "string" &&
      typeof item.artists === "string" &&
      (typeof item.durationMs === "number" || item.durationMs === null) &&
      (typeof item.artworkUrl === "string" || item.artworkUrl === null) &&
      typeof item.addedAt === "number"
  );
}

function isFallbackContext(value: unknown): value is QueueFallbackContext {
  if (!value || typeof value !== "object") return false;
  const ctx = value as Partial<QueueFallbackContext>;
  return Boolean(
    (typeof ctx.contextUri === "string" || ctx.contextUri === null) &&
      (typeof ctx.trackUri === "string" || ctx.trackUri === null) &&
      typeof ctx.progressMs === "number" &&
      typeof ctx.isPlaying === "boolean" &&
      typeof ctx.capturedAt === "number"
  );
}

function parsePersistedSnapshot(raw: string | null): QueueSnapshot {
  if (!raw) return initialSnapshot;
  try {
    const parsed = JSON.parse(raw) as Partial<QueueSnapshot>;
    const items = Array.isArray(parsed.items)
      ? parsed.items.filter(isQueueItem)
      : [];
    const currentQueueId =
      typeof parsed.currentQueueId === "string" ? parsed.currentQueueId : null;
    const currentExists = currentQueueId
      ? items.some((item) => item.queueId === currentQueueId)
      : false;
    const mode: QueuePlaybackMode = parsed.mode === "queue" ? "queue" : "idle";
    const fallbackContext = isFallbackContext(parsed.fallbackContext)
      ? parsed.fallbackContext
      : null;

    return {
      items,
      currentQueueId: currentExists ? currentQueueId : null,
      mode: items.length > 0 && mode === "queue" ? "queue" : "idle",
      fallbackContext,
    };
  } catch {
    return initialSnapshot;
  }
}

function getNextQueueId(items: QueueItem[], currentQueueId: string | null) {
  if (!items.length) return null;
  if (!currentQueueId) return items[0].queueId;
  const index = items.findIndex((item) => item.queueId === currentQueueId);
  if (index < 0) return items[0].queueId;
  if (index >= items.length - 1) return null;
  return items[index + 1].queueId;
}

export function QueueProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<QueueSnapshot>(initialSnapshot);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const next = parsePersistedSnapshot(window.localStorage.getItem(STORAGE_KEY));
    // Hydrate persisted queue state after mount to keep SSR deterministic.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSnapshot(next);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  }, [hydrated, snapshot]);

  const addTracks = useCallback((tracks: QueueTrackInput[]) => {
    const sanitized = tracks
      .filter((track) => Boolean(track.trackId && track.uri))
      .map((track): QueueItem => ({
        queueId: createQueueId(),
        uri: track.uri,
        trackId: track.trackId,
        name: track.name,
        artists: track.artists,
        durationMs: track.durationMs,
        artworkUrl: track.artworkUrl,
        addedAt: Date.now(),
      }));
    if (!sanitized.length) return;

    setSnapshot((prev) => {
      const items = [...prev.items, ...sanitized];
      return {
        ...prev,
        items,
        currentQueueId: prev.currentQueueId ?? items[0]?.queueId ?? null,
      };
    });
  }, []);

  const removeTrack = useCallback((queueId: string) => {
    setSnapshot((prev) => {
      const index = prev.items.findIndex((item) => item.queueId === queueId);
      if (index < 0) return prev;
      const nextItems = prev.items.filter((item) => item.queueId !== queueId);
      if (!nextItems.length) {
        return {
          ...prev,
          items: [],
          currentQueueId: null,
          mode: "idle",
        };
      }

      if (prev.currentQueueId !== queueId) {
        return {
          ...prev,
          items: nextItems,
        };
      }

      const nextCurrent = nextItems[index]?.queueId ?? nextItems[index - 1]?.queueId ?? null;
      return {
        ...prev,
        items: nextItems,
        currentQueueId: nextCurrent,
      };
    });
  }, []);

  const reorderTracks = useCallback((fromIndex: number, toIndex: number) => {
    setSnapshot((prev) => {
      const size = prev.items.length;
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= size ||
        toIndex >= size ||
        fromIndex === toIndex
      ) {
        return prev;
      }
      const nextItems = [...prev.items];
      const [moved] = nextItems.splice(fromIndex, 1);
      if (!moved) return prev;
      nextItems.splice(toIndex, 0, moved);
      return {
        ...prev,
        items: nextItems,
      };
    });
  }, []);

  const clearQueue = useCallback(() => {
    setSnapshot((prev) => ({
      ...prev,
      items: [],
      currentQueueId: null,
      mode: "idle",
    }));
  }, []);

  const setCurrentQueueId = useCallback((queueId: string | null) => {
    setSnapshot((prev) => {
      if (!queueId) {
        return {
          ...prev,
          currentQueueId: null,
        };
      }
      const exists = prev.items.some((item) => item.queueId === queueId);
      if (!exists) {
        return {
          ...prev,
          currentQueueId: getNextQueueId(prev.items, prev.currentQueueId),
        };
      }
      if (prev.currentQueueId === queueId) return prev;
      return {
        ...prev,
        currentQueueId: queueId,
      };
    });
  }, []);

  const setMode = useCallback((mode: QueuePlaybackMode) => {
    setSnapshot((prev) => {
      if (prev.mode === mode) return prev;
      return {
        ...prev,
        mode,
      };
    });
  }, []);

  const setFallbackContext = useCallback((context: QueueFallbackContext | null) => {
    setSnapshot((prev) => ({
      ...prev,
      fallbackContext: context,
    }));
  }, []);

  const currentItem = useMemo(() => {
    if (!snapshot.currentQueueId) return null;
    return snapshot.items.find((item) => item.queueId === snapshot.currentQueueId) ?? null;
  }, [snapshot.currentQueueId, snapshot.items]);

  const nextItem = useMemo(() => {
    if (!snapshot.items.length) return null;
    if (!snapshot.currentQueueId) return snapshot.items[0] ?? null;
    const index = snapshot.items.findIndex((item) => item.queueId === snapshot.currentQueueId);
    if (index < 0) return snapshot.items[0] ?? null;
    return snapshot.items[index + 1] ?? null;
  }, [snapshot.currentQueueId, snapshot.items]);

  const actions: QueueActionApi = useMemo(
    () => ({
      addTracks,
      removeTrack,
      reorderTracks,
      clearQueue,
      setCurrentQueueId,
      setMode,
      setFallbackContext,
    }),
    [addTracks, clearQueue, removeTrack, reorderTracks, setCurrentQueueId, setFallbackContext, setMode]
  );

  const value = useMemo<QueueStore>(
    () => ({
      ...snapshot,
      ...actions,
      hydrated,
      currentItem,
      nextItem,
    }),
    [actions, currentItem, hydrated, nextItem, snapshot]
  );

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}

export function useQueueStore() {
  const value = useContext(QueueContext);
  if (!value) {
    throw new Error("useQueueStore must be used within QueueProvider");
  }
  return value;
}
