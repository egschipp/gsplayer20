export type ApiErrorResult = {
  message: string;
  authRequired?: boolean;
};

export function mapSpotifyApiError(status: number, fallback: string): ApiErrorResult {
  if (status === 401 || status === 403) {
    return {
      message: "Je bent nog niet verbonden met Spotify.",
      authRequired: true,
    };
  }
  if (status === 429) {
    return {
      message: "Je hebt even te veel aanvragen gedaan. Probeer het zo opnieuw.",
    };
  }
  if (status >= 500) {
    return {
      message: "Spotify is tijdelijk niet bereikbaar. Probeer het later opnieuw.",
    };
  }
  return { message: fallback };
}
