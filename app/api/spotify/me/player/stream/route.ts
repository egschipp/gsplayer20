import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { getCorrelationId, requireAppUser } from "@/lib/api/guards";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
const STREAM_MAX_PER_USER = 3;
const streamCountByUser = new Map<string, number>();

type SpotifyPlayerResponse = {
  timestamp?: number;
  currently_playing_type?: "track" | "episode" | "ad" | "unknown";
  actions?: {
    disallows?: Record<string, boolean | null | undefined>;
  };
  device?: {
    id?: string | null;
    name?: string | null;
    is_restricted?: boolean;
    is_private_session?: boolean;
    supports_volume?: boolean;
    volume_percent?: number;
  };
  item?: {
    id?: string | null;
    name?: string | null;
    duration_ms?: number;
    artists?: Array<{ name?: string | null }>;
    album?: {
      name?: string | null;
      images?: Array<{ url?: string | null }>;
    };
  };
  progress_ms?: number;
  is_playing?: boolean;
  shuffle_state?: boolean;
  repeat_state?: "off" | "track" | "context";
};

function normalizeSnapshot(data: SpotifyPlayerResponse | null) {
  const disallowsRaw = data?.actions?.disallows;
  const disallows =
    disallowsRaw && typeof disallowsRaw === "object"
      ? Object.fromEntries(
          Object.entries(disallowsRaw).map(([key, value]) => [key, Boolean(value)])
        )
      : {};
  return {
    device: data?.device ?? null,
    item: data?.item ?? null,
    progress_ms: typeof data?.progress_ms === "number" ? Math.max(0, data.progress_ms) : 0,
    is_playing: Boolean(data?.is_playing),
    shuffle_state: Boolean(data?.shuffle_state),
    repeat_state:
      data?.repeat_state === "track" || data?.repeat_state === "context"
        ? data.repeat_state
        : "off",
    timestamp: typeof data?.timestamp === "number" ? Math.max(0, data.timestamp) : Date.now(),
    currently_playing_type:
      data?.currently_playing_type === "track" ||
      data?.currently_playing_type === "episode" ||
      data?.currently_playing_type === "ad"
        ? data.currently_playing_type
        : "unknown",
    actions: { disallows },
    streamedAt: Date.now(),
  };
}

export async function GET(req: Request) {
  const correlationId = getCorrelationId(req);
  const { session, response } = await requireAppUser();
  if (response) return response;
  const userId = String(session.appUserId || "");
  const active = streamCountByUser.get(userId) || 0;
  if (active >= STREAM_MAX_PER_USER) {
    return new NextResponse(
      JSON.stringify({ error: "RATE_LIMIT", retryAfter: 10 }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Retry-After": "10",
        },
      }
    );
  }
  streamCountByUser.set(userId, active + 1);

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let pingTimer: ReturnType<typeof setInterval> | null = null;
      let hardTimeout: ReturnType<typeof setTimeout> | null = null;
      const writeEvent = (event: string, payload: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
        );
      };

      const writePing = () => {
        controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
      };

      const close = () => {
        if (closed) return;
        closed = true;
        const current = streamCountByUser.get(userId) || 0;
        if (current <= 1) streamCountByUser.delete(userId);
        else streamCountByUser.set(userId, current - 1);
        if (pollTimer) clearInterval(pollTimer);
        if (pingTimer) clearInterval(pingTimer);
        if (hardTimeout) clearTimeout(hardTimeout);
        controller.close();
      };

      const poll = async () => {
        if (closed) return;
        try {
          const data = await spotifyFetch<SpotifyPlayerResponse | undefined>({
            url: "https://api.spotify.com/v1/me/player",
            userLevel: true,
            correlationId,
            priority: "background",
            requestClass: "read",
            cacheTtlMs: 250,
            staleWhileRevalidateMs: 1000,
            maxAttempts: 1,
          });
          writeEvent("snapshot", normalizeSnapshot(data ?? null));
        } catch (error) {
          if (error instanceof SpotifyFetchError) {
            writeEvent("error", {
              code:
                error.status === 401
                  ? "UNAUTHENTICATED"
                  : error.status === 403
                  ? "FORBIDDEN"
                  : error.status === 429
                  ? "RATE_LIMIT"
                  : error.status === 404
                  ? "NO_ACTIVE_PLAYER"
                  : "SPOTIFY_UPSTREAM",
              status: error.status,
              at: Date.now(),
            });
            if (error.status === 401 || error.status === 403) {
              close();
            }
            return;
          }
          writeEvent("error", { code: "STREAM_FAILED", at: Date.now() });
        }
      };

      writeEvent("ready", { ok: true, at: Date.now() });
      void poll();

      pollTimer = setInterval(poll, 3000);
      pingTimer = setInterval(writePing, 15000);
      hardTimeout = setTimeout(close, 120000);

      req.signal.addEventListener("abort", close);
    },
    cancel() {
      closed = true;
      const current = streamCountByUser.get(userId) || 0;
      if (current <= 1) streamCountByUser.delete(userId);
      else streamCountByUser.set(userId, current - 1);
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
