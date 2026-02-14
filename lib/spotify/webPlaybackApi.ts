export type PlaybackStateSnapshot = {
  deviceId: string | null;
  deviceName: string | null;
  contextUri: string | null;
  itemUri: string | null;
  trackId: string | null;
  trackName: string | null;
  artistNames: string | null;
  artworkUrl: string | null;
  progressMs: number;
  durationMs: number;
  isPlaying: boolean;
  shuffleState: boolean;
  repeatState: "off" | "track" | "context";
  fetchedAt: number;
};

export type PlaybackApiError = {
  status: number;
  message: string;
  retryAfterSec?: number;
};

export async function fetchPlaybackStateSnapshot(): Promise<PlaybackStateSnapshot | null> {
  const res = await fetch("/api/spotify/me/player", {
    method: "GET",
    cache: "no-store",
  });

  if (res.status === 204) {
    return null;
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const error: PlaybackApiError = {
      status: res.status,
      message: typeof body?.error === "string" ? body.error : "PLAYBACK_FETCH_FAILED",
      retryAfterSec:
        typeof body?.retryAfter === "number"
          ? body.retryAfter
          : body?.retryAfter
          ? Number(body.retryAfter)
          : undefined,
    };
    throw error;
  }

  const data = (await res.json()) as PlaybackStateSnapshot;
  return data;
}
