import { SpotifyFetchError } from "./errors";

type SpotifyRouteErrorOptions = {
  notFoundCode?: string;
  forbiddenCode?: string;
};

export function mapSpotifyRouteError(
  error: unknown,
  options: SpotifyRouteErrorOptions = {}
) {
  if (error instanceof SpotifyFetchError) {
    if (error.status === 401) return { code: "UNAUTHENTICATED", status: 401 };
    if (error.status === 403) {
      return { code: options.forbiddenCode ?? "FORBIDDEN", status: 403 };
    }
    if (error.status === 404) {
      return { code: options.notFoundCode ?? "NOT_FOUND", status: 404 };
    }
    if (error.status === 429) return { code: "SPOTIFY_RATE_LIMIT", status: 429 };
    return { code: "SPOTIFY_UPSTREAM", status: 502 };
  }
  if (String(error).includes("UserNotAuthenticated")) {
    return { code: "UNAUTHENTICATED", status: 401 };
  }
  return { code: "SPOTIFY_UPSTREAM", status: 502 };
}
