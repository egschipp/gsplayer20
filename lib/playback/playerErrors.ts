export type PlayerErrorCode =
  | "PLAYER_NOT_READY"
  | "SEEK_NOT_AVAILABLE"
  | "TRANSFER_NOT_AVAILABLE"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NO_ACTIVE_DEVICE"
  | "RATE_LIMITED"
  | "QUEUE_PLAYBACK_FAILED"
  | "UNKNOWN";

export type PlayerErrorDetails = {
  code: PlayerErrorCode;
  message: string;
  status?: number;
  retryAfterSec?: number;
};

function normalizeCode(input: unknown): PlayerErrorCode {
  const raw = String(input ?? "").trim().toUpperCase();
  if (
    raw === "PLAYER_NOT_READY" ||
    raw === "SEEK_NOT_AVAILABLE" ||
    raw === "TRANSFER_NOT_AVAILABLE" ||
    raw === "UNAUTHENTICATED" ||
    raw === "FORBIDDEN" ||
    raw === "NO_ACTIVE_DEVICE" ||
    raw === "RATE_LIMITED" ||
    raw === "QUEUE_PLAYBACK_FAILED"
  ) {
    return raw;
  }
  return "UNKNOWN";
}

export function getPlayerErrorMessage(
  code: PlayerErrorCode,
  options?: { retryAfterSec?: number }
): string {
  if (code === "PLAYER_NOT_READY") {
    return "Spotify player is not ready yet. Try again in a few seconds.";
  }
  if (code === "SEEK_NOT_AVAILABLE") {
    return "Seeking is not available right now.";
  }
  if (code === "TRANSFER_NOT_AVAILABLE") {
    return "Device transfer is not available right now.";
  }
  if (code === "UNAUTHENTICATED") {
    return "Spotify session expired. Sign in again.";
  }
  if (code === "FORBIDDEN") {
    return "Missing Spotify playback permissions.";
  }
  if (code === "NO_ACTIVE_DEVICE") {
    return "No active Spotify player found.";
  }
  if (code === "RATE_LIMITED") {
    const retryAfter = Math.max(1, Math.floor(options?.retryAfterSec ?? 1));
    return `Spotify is busy. Try again in ${retryAfter}s.`;
  }
  if (code === "QUEUE_PLAYBACK_FAILED") {
    return "Queue playback could not be completed.";
  }
  return "Playback is unavailable right now.";
}

export function normalizePlayerError(error: unknown): PlayerErrorDetails {
  const candidate = error as {
    status?: number;
    retryAfterSec?: number;
    code?: unknown;
    message?: unknown;
  };
  const status = typeof candidate?.status === "number" ? candidate.status : undefined;
  const retryAfterSec =
    typeof candidate?.retryAfterSec === "number" && candidate.retryAfterSec > 0
      ? candidate.retryAfterSec
      : undefined;
  const rawMessage =
    typeof candidate?.message === "string" ? candidate.message.trim() : "";
  const rawMessageCode = normalizeCode(rawMessage);
  const parsedCode =
    normalizeCode(candidate?.code) !== "UNKNOWN"
      ? normalizeCode(candidate?.code)
      : rawMessageCode;

  let code = parsedCode;
  if (code === "UNKNOWN") {
    if (status === 401) code = "UNAUTHENTICATED";
    else if (status === 403) code = "FORBIDDEN";
    else if (status === 404) code = "NO_ACTIVE_DEVICE";
    else if (status === 429) code = "RATE_LIMITED";
    else if (rawMessage.toUpperCase().includes("PLAYER_NOT_READY")) code = "PLAYER_NOT_READY";
    else if (rawMessage.toUpperCase().includes("SEEK_NOT_AVAILABLE")) code = "SEEK_NOT_AVAILABLE";
    else if (rawMessage.toUpperCase().includes("TRANSFER_NOT_AVAILABLE")) {
      code = "TRANSFER_NOT_AVAILABLE";
    }
  }

  return {
    code,
    status,
    retryAfterSec,
    message:
      (rawMessage && rawMessageCode === "UNKNOWN"
        ? rawMessage
        : "") ||
      getPlayerErrorMessage(code, {
        retryAfterSec,
      }),
  };
}
