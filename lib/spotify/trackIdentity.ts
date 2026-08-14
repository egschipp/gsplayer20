const SPOTIFY_TRACK_ID_PATTERN = /^[0-9A-Za-z]{22}$/;

export function normalizeSpotifyTrackId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (SPOTIFY_TRACK_ID_PATTERN.test(raw)) return raw;
  if (raw.startsWith("spotify:track:")) {
    const id = (raw.split(":").pop() ?? "").split("?")[0]?.trim() ?? "";
    return SPOTIFY_TRACK_ID_PATTERN.test(id) ? id : null;
  }
  if (
    raw.includes("open.spotify.com/track/") ||
    raw.includes("api.spotify.com/v1/tracks/")
  ) {
    try {
      const url = new URL(raw);
      const id = (url.pathname.split("/").filter(Boolean).pop() ?? "")
        .split("?")[0]
        .trim();
      return SPOTIFY_TRACK_ID_PATTERN.test(id) ? id : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function normalizeTrackIdCollection(
  values: Array<string | null | undefined>
): string[] {
  const normalizedIds: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeSpotifyTrackId(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    normalizedIds.push(normalized);
  }
  return normalizedIds;
}
