export type PlaybackFocusSource =
  | "sdk"
  | "api_sync"
  | "api_poll"
  | "api_verify"
  | "api_bootstrap"
  | "api_stream"
  | "system";

export type PlaybackFocus = {
  trackId: string | null;
  isPlaying: boolean | null;
  stale: boolean;
  source: PlaybackFocusSource;
  confidence: number;
  updatedAt: number;
};

export const DEFAULT_PLAYBACK_FOCUS: PlaybackFocus = {
  trackId: null,
  isPlaying: null,
  stale: false,
  source: "system",
  confidence: 0,
  updatedAt: 0,
};
