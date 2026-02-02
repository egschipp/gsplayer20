export const SPOTIFY_SCOPES = [
  "user-library-read",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-top-read",
  "user-read-private",
  "user-read-email",
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
