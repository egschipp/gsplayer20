export class SpotifyFetchError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`SpotifyFetchError:${status}:${body}`);
    this.name = "SpotifyFetchError";
    this.status = status;
    this.body = body;
  }

  toString() {
    return this.message;
  }
}
