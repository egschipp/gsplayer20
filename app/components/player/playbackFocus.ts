export type PlaybackFocusSource =
  | "sdk"
  | "api_sync"
  | "api_poll"
  | "api_verify"
  | "api_bootstrap"
  | "api_stream"
  | "system";

export type PlaybackFocusStatus =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "ended"
  | "error";

export type PlaybackFocus = {
  trackId: string | null;
  isPlaying: boolean | null;
  status: PlaybackFocusStatus;
  stale: boolean;
  source: PlaybackFocusSource;
  confidence: number;
  positionMs: number;
  durationMs: number;
  errorMessage: string | null;
  updatedAt: number;
};

export function resolvePlaybackFocusStatus(
  status: PlaybackFocusStatus | null | undefined,
  isPlaying: boolean | null | undefined,
  hasTrack: boolean
): PlaybackFocusStatus {
  if (status) return status;
  if (isPlaying === true) return "playing";
  if (isPlaying === false) return hasTrack ? "paused" : "ended";
  if (hasTrack) return "loading";
  return "idle";
}

export const DEFAULT_PLAYBACK_FOCUS: PlaybackFocus = {
  trackId: null,
  isPlaying: null,
  status: "idle",
  stale: false,
  source: "system",
  confidence: 0,
  positionMs: 0,
  durationMs: 0,
  errorMessage: null,
  updatedAt: 0,
};
