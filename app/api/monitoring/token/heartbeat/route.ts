import { jsonNoStore, requireAppUser } from "@/lib/api/guards";
import { getValidAccessTokenForUser } from "@/lib/spotify/tokenManager";
import { getAppAccessToken, getAppTokenStatus } from "@/lib/spotify/tokens";
import {
  createCorrelationId,
  readCorrelationId,
} from "@/lib/observability/correlation";

export const runtime = "nodejs";

function mapUserTokenStatus(expiresInSec: number | null) {
  if (expiresInSec == null) return "MISSING_ACCESS";
  if (expiresInSec <= 0) return "EXPIRED";
  if (expiresInSec <= 120) return "EXPIRING";
  return "VALID";
}

export async function POST(req: Request) {
  const { session, response } = await requireAppUser();
  if (response) return response;

  const correlationId = readCorrelationId(req.headers) || createCorrelationId();
  const userResult = await getValidAccessTokenForUser({
    userId: session.appUserId as string,
    correlationId,
  });

  if (!userResult.ok) {
    const status =
      userResult.code === "MISSING_REFRESH_TOKEN" || userResult.code === "INVALID_GRANT"
        ? 401
        : 503;
    return jsonNoStore(
      {
        ok: false,
        error: userResult.code,
        correlationId,
      },
      status,
      { "x-correlation-id": correlationId }
    );
  }

  let appTokenFetchError: string | null = null;
  try {
    await getAppAccessToken();
  } catch (error) {
    appTokenFetchError = String(error).slice(0, 256);
  }

  const now = Date.now();
  const expiresInSec =
    typeof userResult.accessExpiresAt === "number" && userResult.accessExpiresAt > 0
      ? Math.max(0, Math.floor((userResult.accessExpiresAt - now) / 1000))
      : null;
  const appTokenStatus = getAppTokenStatus(now);

  return jsonNoStore(
    {
      ok: !appTokenFetchError,
      correlationId,
      userToken: {
        status: mapUserTokenStatus(expiresInSec),
        expiresAt: userResult.accessExpiresAt,
        expiresInSec,
        scope: userResult.scope,
      },
      appToken: {
        ...appTokenStatus,
        lastError: appTokenFetchError ?? appTokenStatus.lastError,
      },
    },
    200,
    { "x-correlation-id": correlationId }
  );
}
