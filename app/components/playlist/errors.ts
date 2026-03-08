export type ApiErrorResult = {
  message: string;
  authRequired?: boolean;
};

export function mapSpotifyApiError(status: number, fallback: string): ApiErrorResult {
  if (status === 401 || status === 403) {
    return {
      message: "You are not connected to Spotify yet.",
      authRequired: true,
    };
  }
  if (status === 429) {
    return {
      message: "Too many requests. Please try again shortly.",
    };
  }
  if (status >= 500) {
    return {
      message: "Spotify is temporarily unavailable. Try again later.",
    };
  }
  return { message: fallback };
}
