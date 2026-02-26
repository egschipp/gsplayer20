export type SpotifyRequestPriority = "foreground" | "default" | "background";

type PriorityInput = {
  method?: string;
  url: string;
};

function endpointPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

export function inferSpotifyRequestPriority(input: PriorityInput): SpotifyRequestPriority {
  const method = String(input.method || "GET").toUpperCase();
  const path = endpointPath(input.url);

  if (method !== "GET") {
    return "foreground";
  }

  if (path.startsWith("/v1/me/player")) {
    return "foreground";
  }

  if (
    path.startsWith("/v1/me/tracks") ||
    path.startsWith("/v1/me/playlists") ||
    path.startsWith("/v1/me/top") ||
    path.startsWith("/v1/me/player/recently-played")
  ) {
    return "default";
  }

  return "background";
}
