import { jsonNoStore, requireAppUser } from "@/lib/api/guards";
import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import {
  createCorrelationId,
  readCorrelationId,
} from "@/lib/observability/correlation";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { response } = await requireAppUser();
  if (response) return response;

  const correlationId = readCorrelationId(req.headers) || createCorrelationId();

  try {
    const profile = await spotifyFetch<{ id?: string; display_name?: string }>({
      url: "https://api.spotify.com/v1/me",
      userLevel: true,
      correlationId,
    });

    return jsonNoStore(
      {
        ok: true,
        correlationId,
        profile: {
          id: profile?.id ?? null,
          displayName: profile?.display_name ?? null,
        },
      },
      200,
      { "x-correlation-id": correlationId }
    );
  } catch (error) {
    if (error instanceof SpotifyFetchError) {
      const retryAfter =
        error.retryAfterMs && error.retryAfterMs > 0
          ? Math.max(1, Math.ceil(error.retryAfterMs / 1000))
          : null;
      return jsonNoStore(
        {
          ok: false,
          error: error.code,
          status: error.status,
          correlationId: error.correlationId || correlationId,
        },
        error.status >= 400 ? error.status : 502,
        {
          ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
          "x-correlation-id": error.correlationId || correlationId,
        }
      );
    }

    return jsonNoStore(
      {
        ok: false,
        error: "TEST_API_FAILED",
        correlationId,
      },
      500,
      { "x-correlation-id": correlationId }
    );
  }
}

