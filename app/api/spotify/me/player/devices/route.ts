import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import {
  jsonNoStore,
  rateLimitResponse,
  requireAppUser,
} from "@/lib/api/guards";

export const runtime = "nodejs";

type SpotifyDevice = {
  id?: string | null;
  is_active?: boolean;
  is_private_session?: boolean;
  is_restricted?: boolean;
  name?: string;
  type?: string;
  volume_percent?: number;
  supports_volume?: boolean;
};

type SpotifyDevicesResponse = {
  devices?: SpotifyDevice[];
};

export async function GET() {
  const { session, response } = await requireAppUser();
  if (response) return response;

  const rl = await rateLimitResponse({
    key: `me-player-devices:${session.appUserId}`,
    limit: 240,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rl) return rl;

  try {
    const data = await spotifyFetch<SpotifyDevicesResponse | undefined>({
      url: "https://api.spotify.com/v1/me/player/devices",
      userLevel: true,
    });
    const devices = Array.isArray(data?.devices) ? data.devices : [];

    return jsonNoStore({
      devices: devices.map((device) => ({
        id: device?.id ?? null,
        is_active: Boolean(device?.is_active),
        is_private_session: Boolean(device?.is_private_session),
        is_restricted: Boolean(device?.is_restricted),
        name: device?.name ?? "Unknown device",
        type: device?.type ?? "Unknown",
        volume_percent:
          typeof device?.volume_percent === "number"
            ? Math.max(0, Math.min(100, Math.floor(device.volume_percent)))
            : null,
        supports_volume: device?.supports_volume !== false,
      })),
      fetchedAt: Date.now(),
    });
  } catch (error) {
    if (error instanceof SpotifyFetchError) {
      if (error.status === 401) return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
      if (error.status === 403) return jsonNoStore({ error: "FORBIDDEN" }, 403);
      if (error.status === 404) return jsonNoStore({ devices: [] }, 200);
      if (error.status === 429) return jsonNoStore({ error: "RATE_LIMIT" }, 429);
      return jsonNoStore({ error: "SPOTIFY_UPSTREAM" }, 502);
    }
    if (String(error).includes("UserNotAuthenticated")) {
      return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
    }
    return jsonNoStore({ error: "PLAYBACK_DEVICES_FAILED" }, 500);
  }
}
