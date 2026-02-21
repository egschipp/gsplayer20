export class SpotifyFetchError extends Error {
  status: number;
  body: string;
  code: string;
  retryAfterMs: number | null;
  correlationId: string | null;

  constructor(
    status: number,
    body: string,
    options?: {
      code?: string;
      retryAfterMs?: number | null;
      correlationId?: string | null;
    }
  ) {
    super(`SpotifyFetchError:${status}:${body}`);
    this.name = "SpotifyFetchError";
    this.status = status;
    this.body = body;
    this.code = options?.code || "SPOTIFY_FETCH_ERROR";
    this.retryAfterMs = options?.retryAfterMs ?? null;
    this.correlationId = options?.correlationId ?? null;
  }

  toString() {
    return this.message;
  }
}
