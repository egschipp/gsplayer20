export type PlaybackAuthorityMode =
  | "local_primary"
  | "remote_primary"
  | "handoff_pending"
  | "degraded";

export type ResolvePlaybackAuthorityInput = {
  activeDeviceId: string | null;
  sdkDeviceId: string | null;
  pendingDeviceId: string | null;
  snapshotDeviceId?: string | null;
  sdkReady?: boolean;
};

export type PlaybackVersion = {
  deviceEpoch: number;
  serverSeq: number;
  serverTime: number;
  receivedMonoMs: number;
};

export type PlaybackVersionCandidate = {
  deviceEpoch: number;
  seq: number;
  atMs: number;
  receivedMonoMs: number;
};

export const INITIAL_PLAYBACK_VERSION: PlaybackVersion = {
  deviceEpoch: 0,
  serverSeq: 0,
  serverTime: 0,
  receivedMonoMs: 0,
};

function normalizeId(value: string | null | undefined) {
  return value ? String(value) : null;
}

export function resolvePlaybackAuthorityMode(
  input: ResolvePlaybackAuthorityInput
): PlaybackAuthorityMode {
  const activeDeviceId = normalizeId(input.activeDeviceId);
  const sdkDeviceId = normalizeId(input.sdkDeviceId);
  const pendingDeviceId = normalizeId(input.pendingDeviceId);
  const snapshotDeviceId = normalizeId(input.snapshotDeviceId);

  if (pendingDeviceId) {
    return "handoff_pending";
  }

  if (snapshotDeviceId && sdkDeviceId && snapshotDeviceId !== sdkDeviceId) {
    return "remote_primary";
  }

  if (activeDeviceId && sdkDeviceId) {
    return activeDeviceId === sdkDeviceId ? "local_primary" : "remote_primary";
  }

  if (activeDeviceId && !sdkDeviceId) {
    return "remote_primary";
  }

  if (!activeDeviceId && sdkDeviceId && input.sdkReady) {
    return "local_primary";
  }

  return "degraded";
}

export function shouldIngestSourceForAuthority(args: {
  authorityMode: PlaybackAuthorityMode;
  source: "sdk" | "sse" | "poll" | "verify" | "bootstrap" | "command";
  eventDeviceId: string | null;
  activeDeviceId: string | null;
  sdkDeviceId: string | null;
}): { allow: boolean; reason: string } {
  const eventDeviceId = normalizeId(args.eventDeviceId);
  const activeDeviceId = normalizeId(args.activeDeviceId);
  const sdkDeviceId = normalizeId(args.sdkDeviceId);

  if (
    (args.authorityMode === "remote_primary" ||
      args.authorityMode === "handoff_pending") &&
    args.source === "sdk"
  ) {
    return { allow: false, reason: "authority_remote_rejects_sdk" };
  }

  if (
    args.authorityMode === "local_primary" &&
    args.source !== "sdk" &&
    sdkDeviceId &&
    eventDeviceId &&
    eventDeviceId !== sdkDeviceId &&
    (!activeDeviceId || eventDeviceId !== activeDeviceId)
  ) {
    return { allow: false, reason: "authority_local_rejects_foreign_device" };
  }

  return { allow: true, reason: "authority_ok" };
}

function normalizePositiveInt(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function shouldApplyPlaybackVersion(
  current: PlaybackVersion,
  candidateInput: PlaybackVersionCandidate
): { apply: boolean; reason: string; next: PlaybackVersion } {
  const candidate: PlaybackVersionCandidate = {
    deviceEpoch: normalizePositiveInt(candidateInput.deviceEpoch),
    seq: normalizePositiveInt(candidateInput.seq),
    atMs: normalizePositiveInt(candidateInput.atMs),
    receivedMonoMs: normalizePositiveInt(candidateInput.receivedMonoMs),
  };

  if (candidate.deviceEpoch < current.deviceEpoch) {
    return { apply: false, reason: "epoch_older", next: current };
  }

  const effectiveSeq = candidate.seq > 0 ? candidate.seq : current.serverSeq;

  if (candidate.deviceEpoch === current.deviceEpoch && effectiveSeq < current.serverSeq) {
    return { apply: false, reason: "version_seq_older", next: current };
  }

  if (
    candidate.deviceEpoch === current.deviceEpoch &&
    effectiveSeq === current.serverSeq &&
    candidate.atMs + 250 < current.serverTime
  ) {
    return { apply: false, reason: "version_time_older", next: current };
  }

  if (
    candidate.deviceEpoch === current.deviceEpoch &&
    effectiveSeq === current.serverSeq &&
    candidate.atMs === current.serverTime &&
    candidate.receivedMonoMs + 5 < current.receivedMonoMs
  ) {
    return { apply: false, reason: "version_mono_older", next: current };
  }

  const next: PlaybackVersion = {
    deviceEpoch: candidate.deviceEpoch,
    serverSeq: Math.max(current.serverSeq, effectiveSeq),
    serverTime: Math.max(current.serverTime, candidate.atMs),
    receivedMonoMs: Math.max(current.receivedMonoMs, candidate.receivedMonoMs),
  };

  return { apply: true, reason: "version_ok", next };
}
