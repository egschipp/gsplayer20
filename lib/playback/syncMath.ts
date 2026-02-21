export function clampProgressValue(nextMs: number, maxDuration: number) {
  const raw = Number.isFinite(nextMs) ? Math.floor(nextMs) : 0;
  if (maxDuration > 0) {
    return Math.max(0, Math.min(raw, maxDuration));
  }
  return Math.max(0, raw);
}

export function reconcileProgressValue(
  localMs: number,
  remoteMs: number,
  deadbandMs: number,
  maxStepMs: number,
  hardSync = false
) {
  if (hardSync) return remoteMs;
  const delta = remoteMs - localMs;
  if (Math.abs(delta) <= deadbandMs) {
    return localMs;
  }
  const step = Math.sign(delta) * Math.min(Math.abs(delta), maxStepMs);
  return localMs + step;
}

export function projectRemoteProgressValue(
  progressMs: number,
  isPlaying: boolean,
  timestampMs: number | null | undefined,
  requestStartedAtWallMs: number | undefined,
  responseReceivedAtWallMs: number
) {
  if (!isPlaying) return progressMs;
  const rttMs =
    typeof requestStartedAtWallMs === "number"
      ? Math.max(0, responseReceivedAtWallMs - requestStartedAtWallMs)
      : 0;
  const halfRttMs = rttMs / 2;
  const serverTs =
    typeof timestampMs === "number" && Number.isFinite(timestampMs)
      ? timestampMs
      : responseReceivedAtWallMs;
  const elapsedSinceServer = Math.max(0, responseReceivedAtWallMs - serverTs - halfRttMs);
  return progressMs + elapsedSinceServer;
}
