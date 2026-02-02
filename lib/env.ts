export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export function getBaseUrl(): string {
  return process.env.NEXTAUTH_URL || process.env.AUTH_URL || "";
}

export function assertSpotifyEnv() {
  requireEnv("SPOTIFY_CLIENT_ID");
  requireEnv("SPOTIFY_CLIENT_SECRET");
  requireEnv("SPOTIFY_REDIRECT_URI");
}
