export type PlaybackExecutionMode =
  | "idle"
  | "local_sdk"
  | "remote_connect"
  | "handoff_pending"
  | "degraded";

type ResolvePlaybackSyncOwnershipInput = {
  executionMode: PlaybackExecutionMode;
  isLeader?: boolean;
  activeDeviceId?: string | null;
  sdkDeviceId?: string | null;
};

type ResolvePlaybackExecutionModeInput = {
  activeDeviceId?: string | null;
  sdkDeviceId?: string | null;
  pendingDeviceId?: string | null;
  sdkReady?: boolean;
};

function normalizeId(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function resolvePlaybackExecutionMode(
  input: ResolvePlaybackExecutionModeInput
): PlaybackExecutionMode {
  const activeDeviceId = normalizeId(input.activeDeviceId);
  const sdkDeviceId = normalizeId(input.sdkDeviceId);
  const pendingDeviceId = normalizeId(input.pendingDeviceId);
  const sdkReady = input.sdkReady === true;

  if (pendingDeviceId) {
    return "handoff_pending";
  }

  if (activeDeviceId && sdkDeviceId) {
    return activeDeviceId === sdkDeviceId ? "local_sdk" : "remote_connect";
  }

  if (activeDeviceId && !sdkDeviceId) {
    return "remote_connect";
  }

  if (!activeDeviceId && sdkDeviceId && sdkReady) {
    return "local_sdk";
  }

  if (!activeDeviceId && !sdkDeviceId && !sdkReady) {
    return "idle";
  }

  return "degraded";
}

export function resolvePlaybackSyncOwnership(
  input: ResolvePlaybackSyncOwnershipInput
) {
  const activeDeviceId = normalizeId(input.activeDeviceId);
  const sdkDeviceId = normalizeId(input.sdkDeviceId);
  const isLeader = input.isLeader === true;
  const executionMode = input.executionMode;

  const localSdkIsActiveDevice =
    executionMode === "local_sdk" &&
    Boolean(activeDeviceId) &&
    Boolean(sdkDeviceId) &&
    activeDeviceId === sdkDeviceId;

  return {
    shouldOwnPlaybackSync: isLeader || localSdkIsActiveDevice,
    shouldRunPlaybackStream:
      (isLeader || localSdkIsActiveDevice) && executionMode !== "local_sdk",
  };
}
