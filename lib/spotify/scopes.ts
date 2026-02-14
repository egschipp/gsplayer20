export const SPOTIFY_SCOPES = [
  "streaming",
  "user-library-read",
  "user-library-modify",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-top-read",
  "user-read-private",
  "user-read-playback-state",
  "user-read-currently-playing",
  "user-modify-playback-state",
];

export const SPOTIFY_PLAYBACK_SCOPES = [
  "streaming",
  "user-read-playback-state",
  "user-read-currently-playing",
  "user-modify-playback-state",
];

export function scopeString() {
  return SPOTIFY_SCOPES.join(" ");
}

export function parseScopes(scope?: string) {
  if (!scope) return new Set<string>();
  return new Set(scope.split(" ").filter(Boolean));
}

export function hasAllScopes(scope: string | undefined, required = SPOTIFY_SCOPES) {
  const current = parseScopes(scope);
  return required.every((s) => current.has(s));
}

export function hasPlaybackScopes(scope: string | undefined) {
  return hasAllScopes(scope, SPOTIFY_PLAYBACK_SCOPES);
}
