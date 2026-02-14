export type QueuePlaybackMode = "idle" | "queue";

export type QueueTrackInput = {
  uri: string;
  trackId: string;
  name: string;
  artists: string;
  durationMs: number | null;
  artworkUrl: string | null;
};

export type QueueItem = QueueTrackInput & {
  queueId: string;
  addedAt: number;
};

export type QueueFallbackContext = {
  contextUri: string | null;
  trackUri: string | null;
  progressMs: number;
  isPlaying: boolean;
  capturedAt: number;
};

export type QueueSnapshot = {
  items: QueueItem[];
  currentQueueId: string | null;
  mode: QueuePlaybackMode;
  fallbackContext: QueueFallbackContext | null;
};

export type QueueActionApi = {
  addTracks: (tracks: QueueTrackInput[]) => void;
  removeTrack: (queueId: string) => void;
  reorderTracks: (fromIndex: number, toIndex: number) => void;
  clearQueue: () => void;
  setCurrentQueueId: (queueId: string | null) => void;
  setMode: (mode: QueuePlaybackMode) => void;
  setFallbackContext: (context: QueueFallbackContext | null) => void;
};

export type QueueStore = QueueSnapshot &
  QueueActionApi & {
    hydrated: boolean;
    currentItem: QueueItem | null;
    nextItem: QueueItem | null;
  };
