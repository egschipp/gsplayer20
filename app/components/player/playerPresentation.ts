import {
  getPlayerErrorMessage,
  normalizePlayerError,
} from "../../../lib/playback/playerErrors";

export type PlaybackBootState =
  "idle" | "booting" | "sdk_ready" | "device_ready" | "playable" | "playing";

export function formatPlayerError(message?: string | null) {
  if (!message) return null;
  const normalized = normalizePlayerError({ message });
  if (normalized.code !== "UNKNOWN") {
    return getPlayerErrorMessage(normalized.code, {
      retryAfterSec: normalized.retryAfterSec,
    });
  }
  const lower = String(message).toLowerCase();
  if (
    lower.includes("invalid token scopes") ||
    lower.includes("insufficient_scope") ||
    lower.includes("403")
  ) {
    return "Missing Spotify permissions. Reconnect.";
  }
  if (lower.includes("401")) return "Spotify session expired. Reconnect.";
  if (lower.includes("authentication") || lower.includes("token")) {
    return "Connection to Spotify expired. Reconnect.";
  }
  if (lower.includes("premium")) {
    return "Spotify Premium is required for Web Playback.";
  }
  return message;
}

export function formatPlaybackBootStateLabel(state: PlaybackBootState) {
  if (state === "booting") return "Player is starting";
  if (state === "sdk_ready") return "Player ready, waiting for device";
  if (state === "device_ready") return "Device is activating";
  if (state === "playable") return "Ready to play";
  if (state === "playing") return "Playback active";
  return "Waiting for session";
}

export function formatPlaybackTime(ms?: number) {
  if (!ms || ms < 0 || !Number.isFinite(ms)) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
