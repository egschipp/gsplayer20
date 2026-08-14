export type PlaybackDeviceControlState = {
  activeDeviceId?: string | null;
  selectedDeviceId?: string | null;
  sdkDeviceId?: string | null;
  restricted: boolean;
};

export function isLocalSdkPlaybackTarget(
  state: Omit<PlaybackDeviceControlState, "restricted">
) {
  const targetDeviceId =
    state.activeDeviceId ?? state.selectedDeviceId ?? state.sdkDeviceId ?? null;
  return Boolean(state.sdkDeviceId && targetDeviceId === state.sdkDeviceId);
}

export function shouldBlockPlayPause(state: PlaybackDeviceControlState) {
  return state.restricted && !isLocalSdkPlaybackTarget(state);
}
