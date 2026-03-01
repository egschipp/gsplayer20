export type PlayerPlaybackStatus =
  | "empty"
  | "loading"
  | "ready"
  | "error";

export type PlayerCommandType =
  | "play"
  | "pause"
  | "toggle"
  | "seek"
  | "transfer";

export type PlayerRuntimeState = {
  deviceId: string | null;
  isActiveDevice: boolean;
  sdkReady: boolean;
  lastError: string | null;
};

export type PlayTrackRequest = {
  trackId: string;
  mode: "playlists" | "artists" | "tracks" | "albums";
  queueUris: string[];
  queueContainsTrack: boolean;
  rowIndex?: number | null;
  trackPosition?: number | null;
  selectedPlaylistId?: string | null;
  selectedPlaylistType?: "liked" | "all_music" | "playlist" | null;
};

export type PlayerCommandHandlers = {
  primePlaybackGesture?: () => void;
  playQueue: (
    uris: string[],
    offsetUri?: string,
    offsetIndex?: number | null
  ) => Promise<void>;
  playContext: (
    contextUri: string,
    offsetPosition?: number | null,
    offsetUri?: string
  ) => Promise<void>;
  togglePlay: () => Promise<void>;
  pause?: () => Promise<void>;
  resume?: () => Promise<void>;
  seek?: (ms: number) => Promise<void>;
  transfer?: (deviceId: string, play?: boolean) => Promise<void>;
};
