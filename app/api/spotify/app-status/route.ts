import { jsonNoStore, getCorrelationId, getRequestIp, rateLimitResponse } from "@/lib/api/guards";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { assertSpotifyEnv } from "@/lib/env";
import { getAppAccessToken } from "@/lib/spotify/tokens";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const correlationId = getCorrelationId(req);
  const ip = getRequestIp(req);
  const userAgent = (req.headers.get("user-agent") ?? "unknown").slice(0, 120);
  const rl = await rateLimitResponse({
    key: `app-status:${ip}:${userAgent}`,
    limit: 180,
    windowMs: 60_000,
    body: { status: "ERROR_RATE_LIMIT" },
    includeRetryAfter: true,
  });
  if (rl) return rl;

  try {
    assertSpotifyEnv();
    await getAppAccessToken();
    return jsonNoStore({ status: "OK", correlationId }, 200, {
      "x-correlation-id": correlationId,
    });
  } catch (error) {
    const message = String(error);
    if (message.includes("Missing environment variable")) {
      return jsonNoStore({ status: "ERROR_MISSING_ENV", correlationId }, 500, {
        "x-correlation-id": correlationId,
      });
    }

    if (error instanceof SpotifyFetchError && error.status === 401) {
      return jsonNoStore({ status: "ERROR_AUTH", correlationId }, 401, {
        "x-correlation-id": correlationId,
      });
    }

    return jsonNoStore({ status: "ERROR_NETWORK", correlationId }, 502, {
      "x-correlation-id": correlationId,
    });
  }
}
