export function classifySpotifyErrorCode(
  status: number,
  body: string,
  endpointGroup: string,
  method: string
): string {
  const lower = body.toLowerCase();
  const isPlayerEndpoint =
    endpointGroup === "me_player" || endpointGroup.startsWith("me_player_");
  if (status === 401) {
    if (lower.includes("invalid_grant")) return "INVALID_GRANT";
    return "UNAUTHENTICATED";
  }
  if (status === 403) {
    if (isPlayerEndpoint && /restriction\s+violated/i.test(body)) {
      return "RESTRICTION_VIOLATED";
    }
    return "FORBIDDEN";
  }
  if (status === 404) {
    if (isPlayerEndpoint) {
      return method === "GET" ? "NO_ACTIVE_DEVICE" : "PLAYER_NOT_FOUND";
    }
    if (endpointGroup === "me_player_devices") return "NO_CONNECT_DEVICE";
    return "NOT_FOUND";
  }
  if (status === 429) {
    try {
      const parsed = JSON.parse(body) as {
        reason?: unknown;
        error?: { reason?: unknown };
      };
      const reason = parsed?.reason ?? parsed?.error?.reason;
      if (String(reason || "").toUpperCase() === "QUOTA_EXCEEDED") {
        return "QUOTA_EXCEEDED";
      }
    } catch {
      // Spotify can return a non-JSON rate-limit body.
    }
    return "RATE_LIMIT";
  }
  if (status >= 500) return "SPOTIFY_UPSTREAM";
  return "SPOTIFY_REQUEST_FAILED";
}

export function shouldRetrySpotifyRequest(
  status: number,
  method: string,
  code: string
): boolean {
  if (code === "QUOTA_EXCEEDED") return false;
  const normalizedMethod = method.toUpperCase();
  if (!new Set(["GET", "PUT", "DELETE"]).has(normalizedMethod)) return false;
  return [429, 500, 502, 503, 504].includes(status);
}
