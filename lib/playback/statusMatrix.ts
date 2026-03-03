import type { PlaybackFocusStatus } from "@/app/components/player/playbackFocus";

export type PlaybackStatusMatrixInput = {
  status: PlaybackFocusStatus;
  isPlaying: boolean | null;
  isActiveTrack: boolean;
  isRemoteSource: boolean;
  stale: boolean;
  transientGap: boolean;
  errorVisible: boolean;
  hideLoadingForRemoteActiveTrack: boolean;
};

export function projectPlaybackStatusForUi(
  input: PlaybackStatusMatrixInput
): PlaybackFocusStatus {
  if (!input.isActiveTrack) return "idle";

  if (input.status === "error" && !input.errorVisible) {
    return input.isPlaying === false ? "paused" : "loading";
  }

  if (
    input.hideLoadingForRemoteActiveTrack &&
    input.isRemoteSource &&
    input.status === "loading"
  ) {
    return input.isPlaying === false ? "paused" : "playing";
  }

  if (input.transientGap && (input.status === "loading" || input.status === "idle")) {
    return input.isPlaying === false ? "paused" : "playing";
  }

  if (input.stale && input.status === "loading") {
    return input.isPlaying === false ? "paused" : "playing";
  }

  return input.status;
}

