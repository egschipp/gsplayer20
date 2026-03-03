export type PlaybackFeatureFlags = {
  playbackViewModelV1: boolean;
  playbackStatusMatrixV1: boolean;
  trackFocusReducerV1: boolean;
  activeTrackAutoScrollV1: boolean;
  remoteActiveTrackHideLoadingIndicator: boolean;
  delayedActiveTrackErrorIndicator: boolean;
  playbackUiTelemetryV1: boolean;
};

export const PLAYBACK_FEATURE_FLAGS: PlaybackFeatureFlags = {
  playbackViewModelV1: true,
  playbackStatusMatrixV1: true,
  trackFocusReducerV1: true,
  activeTrackAutoScrollV1: true,
  remoteActiveTrackHideLoadingIndicator: true,
  delayedActiveTrackErrorIndicator: true,
  playbackUiTelemetryV1: true,
};

