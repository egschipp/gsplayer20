import type { MonitoringTone } from "./presentation";

const ACTIVITY_LABEL_MAP: Record<string, string> = {
  me_player_get_raw_state: "Player state refresh",
  me_player_get_state: "Player state sync",
  me_player_devices: "Device discovery",
  me_player_transfer: "Device handoff",
  me_player_command: "Playback command",
  me_tracks: "Liked Songs",
  me_playlists: "Playlist overview",
  playlists_items: "Playlist tracks",
  artists: "Artist lookup",
  tracks: "Track lookup",
  v1_me: "Account profile",
};

export function fmtPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

export function fmtCompactTime(value: number | null) {
  if (!value) return "n/a";
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function fmtDateTime(value: number | null) {
  if (!value) return "n/a";
  return new Date(value).toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function fmtCount(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US");
}

export function fmtWindow(seconds: number | null | undefined) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return "recent";
  }
  if (seconds % 60 === 0) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

export function fmtAgoShort(seconds: number | null | undefined) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return "n/a";
  }
  if (seconds < 60) return `${Math.max(1, Math.floor(seconds))}s`;
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  return `${Math.max(1, Math.floor(seconds / 3600))}h`;
}

export function formatRateLimitSource(value: string) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "spotify_http_429") return "Spotify 429";
  if (normalized === "spotify_local_limiter") return "Local limiter";
  return value || "Unknown";
}

export function formatImpactLevel(value: "low" | "medium" | "high" | null | undefined) {
  if (value === "high") return "high";
  if (value === "medium") return "medium";
  return "low";
}

export function formatLatencyHealthLabel(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "Waiting for enough samples";
  if (value <= 450) return "User-facing requests feel healthy";
  if (value <= 900) return "User-facing requests are slightly elevated";
  return "User-facing requests feel slow";
}

export function formatMonitoringActivityLabel(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return "No hotspot";
  const mapped = ACTIVITY_LABEL_MAP[raw.toLowerCase()];
  if (mapped) return mapped;

  const normalized = raw
    .replace(/^me_player_/i, "player ")
    .replace(/^me_/i, "account ")
    .replace(/^v1_/i, "")
    .replace(/_/g, " ")
    .replace(/\braw\b/gi, "live")
    .replace(/\bget\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return raw;
  return normalized
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function authTone(status: string): MonitoringTone {
  const normalized = status.trim().toUpperCase();
  if (["OK", "CONNECTED", "AUTHENTICATED", "READY"].includes(normalized)) {
    return "ok";
  }
  if (["CHECKING", "REAUTH_REQUIRED", "PENDING", "UNKNOWN"].includes(normalized)) {
    return "warn";
  }
  return "error";
}

export function formatAuthStatus(status: string) {
  const normalized = status.trim().toUpperCase();
  if (normalized === "CONNECTED" || normalized === "OK") return "Connected";
  if (normalized === "REAUTH_REQUIRED") return "Re-login required";
  if (normalized === "DISCONNECTED") return "Disconnected";
  if (normalized === "CHECKING") return "Checking";
  return status;
}

export function tokenStatusTone(status: string): MonitoringTone {
  const normalized = String(status ?? "")
    .trim()
    .toUpperCase();
  if (["VALID", "CONNECTED", "OK", "REFRESHING"].includes(normalized)) return "ok";
  if (
    ["EXPIRING", "MISSING_ACCESS", "MISSING", "CHECKING", "UNKNOWN"].includes(normalized)
  ) {
    return "warn";
  }
  return "error";
}

export function formatTokenStatus(status: string) {
  const normalized = String(status ?? "")
    .trim()
    .toUpperCase();
  if (normalized === "VALID" || normalized === "OK") return "Valid";
  if (normalized === "REFRESHING") return "Refreshing";
  if (normalized === "EXPIRING") return "Expiring soon";
  if (normalized === "EXPIRED") return "Expired";
  if (normalized === "REAUTH_REQUIRED") return "Re-login required";
  if (normalized === "MISSING" || normalized === "MISSING_ACCESS") return "Missing";
  if (normalized === "ERROR") return "Error";
  return status;
}
