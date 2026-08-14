type NavigatorSnapshot = {
  userAgent?: string;
  maxTouchPoints?: number;
};

type PlaybackWindowSnapshot = {
  isSecureContext?: boolean;
  AudioContext?: unknown;
  webkitAudioContext?: unknown;
  MediaSource?: unknown;
};

export function detectWebplayerPlatform(
  source: NavigatorSnapshot | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator
) {
  if (!source) return "";
  const userAgent = String(source.userAgent ?? "").toLowerCase();
  const maxTouchPoints = Number(source.maxTouchPoints ?? 0);
  if (/ipad/.test(userAgent)) return "iPad";
  if (/macintosh/.test(userAgent) && maxTouchPoints > 1) return "iPad";
  if (/iphone/.test(userAgent)) return "iPhone";
  if (/android/.test(userAgent)) return "Android";
  if (/macintosh|mac os x/.test(userAgent)) return "Mac";
  if (/windows/.test(userAgent)) return "Windows";
  return "";
}

export function getWebPlaybackSdkSupport(
  source: PlaybackWindowSnapshot | undefined = typeof window === "undefined"
    ? undefined
    : window
) {
  if (!source) {
    return { supported: false, reason: "Web player requires a browser context." };
  }
  if (!source.isSecureContext) {
    return {
      supported: false,
      reason: "Web player requires HTTPS (secure context).",
    };
  }
  const hasAudioContext =
    typeof source.AudioContext !== "undefined" ||
    typeof source.webkitAudioContext !== "undefined";
  const hasMediaSource = typeof source.MediaSource !== "undefined";
  if (!hasAudioContext || !hasMediaSource) {
    return {
      supported: false,
      reason: "This browser does not fully support Spotify Web Playback.",
    };
  }
  return { supported: true, reason: null };
}

export function resolveDeviceTypeIcon(type: string | null | undefined) {
  const normalized = String(type ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return "🎵";
  if (normalized.includes("headphone") || normalized.includes("headset")) {
    return "🎧";
  }
  if (
    normalized.includes("smartphone") ||
    normalized.includes("phone") ||
    normalized.includes("tablet")
  ) {
    return "📱";
  }
  if (
    normalized.includes("computer") ||
    normalized.includes("webplayer") ||
    normalized.includes("desktop")
  ) {
    return "💻";
  }
  if (normalized.includes("speaker") || normalized.includes("castaudio")) {
    return "🔊";
  }
  if (
    normalized.includes("tv") ||
    normalized.includes("stb") ||
    normalized.includes("console")
  ) {
    return "📺";
  }
  if (normalized.includes("avr") || normalized.includes("receiver")) return "📻";
  if (normalized.includes("audiodongle") || normalized.includes("dongle")) {
    return "🎛️";
  }
  return "🎵";
}
