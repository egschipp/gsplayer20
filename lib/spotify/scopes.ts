export const SPOTIFY_SCOPES = [
  "streaming",
  // Required by Spotify's Web Playback SDK even though the app does not use email data.
  "user-read-email",
  "user-library-read",
  "user-library-modify",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-top-read",
  "user-read-recently-played",
  "user-read-private",
  "user-read-playback-state",
  "user-read-currently-playing",
  "user-modify-playback-state",
];

export const SPOTIFY_PLAYBACK_SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
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

export const SPOTIFY_SCOPE_CAPABILITIES = {
  playback: SPOTIFY_PLAYBACK_SCOPES,
  libraryRead: ["user-library-read"],
  libraryWrite: ["user-library-modify"],
  playlistsRead: ["playlist-read-private", "playlist-read-collaborative"],
  playlistsWrite: ["playlist-modify-public", "playlist-modify-private"],
  history: ["user-read-recently-played"],
  topItems: ["user-top-read"],
} as const;

export function scopeCapabilities(scope?: string) {
  const granted = parseScopes(scope);
  return Object.fromEntries(
    Object.entries(SPOTIFY_SCOPE_CAPABILITIES).map(([name, required]) => [
      name,
      required.every((value) => granted.has(value)),
    ])
  );
}

export function missingScopes(scope?: string) {
  const granted = parseScopes(scope);
  return SPOTIFY_SCOPES.filter((value) => !granted.has(value));
}
