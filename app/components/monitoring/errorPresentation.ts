export type ErrorTone = "ok" | "warn" | "error";

const ENDPOINT_LABEL_MAP: Record<string, { label: string; description: string }> = {
  me_player: {
    label: "Player controls",
    description: "Play/pause/next/seek and player state.",
  },
  me_tracks: {
    label: "Liked Songs",
    description: "Lezen/schrijven van persoonlijke library-tracks.",
  },
  me_playlists: {
    label: "Playlists",
    description: "Fetch and manage playlist overviews.",
  },
  playlists_items: {
    label: "Playlist tracks",
    description: "Load and modify tracks inside playlists.",
  },
  me_player_devices: {
    label: "Connect devices",
    description: "Fetch available Spotify Connect devices.",
  },
  artists: {
    label: "Artists",
    description: "Artist metadata and related queries.",
  },
  tracks: {
    label: "Tracks",
    description: "Track metadata and track-specific requests.",
  },
  v1_me: {
    label: "Account profile",
    description: "Validation for the signed-in Spotify user.",
  },
};

export function describeEndpoint(endpoint: string) {
  const raw = String(endpoint ?? "").trim();
  const known = ENDPOINT_LABEL_MAP[raw.toLowerCase()];
  if (known) {
    return {
      label: known.label,
      raw,
      title: `${known.label} (${raw}) - ${known.description}`,
    };
  }
  const normalized = raw
    .replace(/^\/+/, "")
    .replace(/^api\/spotify\//i, "")
    .replace(/^v1\//i, "")
    .replace(/^me[_/]/i, "")
    .replace(/[_/]+/g, " ")
    .trim();
  const label =
    normalized
      .split(" ")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || "Unknown endpoint";

  return { label, raw, title: `${label} (${raw})` };
}

export function normalizeEndpointKey(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function normalizeRecentErrorMessage(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text) return "No detail available.";
  try {
    const parsed = JSON.parse(text) as {
      error?: string | { status?: number; message?: string };
    } | null;
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        return parsed.error.trim();
      }
      if (parsed.error && typeof parsed.error === "object") {
        const status =
          typeof parsed.error.status === "number" ? parsed.error.status : null;
        const message =
          typeof parsed.error.message === "string" ? parsed.error.message.trim() : "";
        if (message) return status ? `${message} (${status})` : message;
      }
    }
  } catch {
    // Preserve plain-text upstream errors.
  }
  return text;
}

export function describeErrorCode(code: string): {
  label: string;
  tone: ErrorTone;
  help: string;
} {
  const normalized = String(code ?? "")
    .trim()
    .toUpperCase();
  switch (normalized) {
    case "NO_ACTIVE_DEVICE":
      return {
        label: "No active device",
        tone: "warn",
        help: "Start playback on a Spotify Connect device.",
      };
    case "NO_CONNECT_DEVICE":
      return {
        label: "No devices visible",
        tone: "warn",
        help: "Check whether Spotify is active on your device.",
      };
    case "NETWORK_TIMEOUT":
      return {
        label: "Network timeout",
        tone: "warn",
        help: "Spotify responded too slowly; the app will retry automatically.",
      };
    case "NETWORK_TRANSIENT":
      return {
        label: "Temporary network error",
        tone: "warn",
        help: "Temporary disruption; this usually recovers on its own.",
      };
    case "RATE_LIMIT":
      return {
        label: "Rate limit",
        tone: "warn",
        help: "Too many requests at once; backoff is active.",
      };
    case "UNAUTHENTICATED":
      return {
        label: "Not signed in",
        tone: "error",
        help: "Spotify session expired; reconnect is required.",
      };
    case "SPOTIFY_UPSTREAM":
      return {
        label: "Spotify outage",
        tone: "error",
        help: "The Spotify API returned a server-side error.",
      };
    case "NOT_FOUND":
    case "PLAYER_NOT_FOUND":
      return {
        label: "Not found",
        tone: "warn",
        help: "The requested playback context does not exist right now.",
      };
    case "NETWORK_FATAL":
      return {
        label: "Network error",
        tone: "error",
        help: "Hard network failure; retry the action manually.",
      };
    default:
      return {
        label: normalized || "Unknown",
        tone: "error",
        help: "Unknown error; review the diagnostics export for details.",
      };
  }
}

export function describeRecentErrorMessage(args: {
  code: string;
  endpointRaw: string;
  message: string;
}): string {
  const code = String(args.code ?? "")
    .trim()
    .toUpperCase();
  if (code === "NO_ACTIVE_DEVICE") {
    return "No active player found. Start music on a device and try again.";
  }
  if (code === "NO_CONNECT_DEVICE") {
    return "No Spotify Connect devices are available.";
  }
  if (code === "NOT_FOUND" && args.endpointRaw === "me_player") {
    return "No active player found. Start music on a device and try again.";
  }
  return normalizeRecentErrorMessage(args.message);
}
