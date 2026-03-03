import type { PlaybackFocusStatus } from "@/app/components/player/playbackFocus";
import { projectPlaybackStatusForUi } from "./statusMatrix";

export type QueueActivePresentationInput = {
  hasActiveTrack: boolean;
  status: PlaybackFocusStatus;
  isPlaying: boolean | null;
  source: string;
  stale: boolean;
  errorVisible: boolean;
  commandBusy: boolean;
  handoffPending: boolean;
  hideLoadingForRemoteActiveTrack: boolean;
};

export type QueueActivePresentation = {
  transientGap: boolean;
  status: PlaybackFocusStatus;
  stale: boolean;
  isRemoteSource: boolean;
};

export function deriveQueueActivePresentation(
  input: QueueActivePresentationInput
): QueueActivePresentation {
  const isRemoteSource = input.source !== "sdk";
  const shouldSuppressLoading =
    input.hasActiveTrack &&
    input.status === "loading" &&
    (input.isPlaying === true || isRemoteSource || input.stale);
  const transientGap =
    input.hasActiveTrack &&
    (input.stale ||
      shouldSuppressLoading ||
      input.status === "loading" ||
      input.status === "idle" ||
      input.commandBusy ||
      input.handoffPending);

  const status = projectPlaybackStatusForUi({
    status: input.status,
    isPlaying: input.isPlaying,
    isActiveTrack: input.hasActiveTrack,
    isRemoteSource,
    stale: input.stale,
    transientGap,
    errorVisible: input.errorVisible,
    hideLoadingForRemoteActiveTrack: input.hideLoadingForRemoteActiveTrack,
  });

  return {
    transientGap,
    status,
    stale: input.hasActiveTrack ? Boolean(input.stale && !transientGap) : false,
    isRemoteSource,
  };
}
