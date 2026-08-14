import { jsonNoStore, requireAppUser, requireSameOrigin } from "@/lib/api/guards";
import { getValidAccessTokenForUser } from "@/lib/spotify/tokenManager";
import { getAppAccessToken, getAppTokenStatus } from "@/lib/spotify/tokens";
import { createCorrelationId, readCorrelationId } from "@/lib/observability/correlation";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;
  const { session, response } = await requireAppUser();
  if (response) return response;

  const correlationId = readCorrelationId(req.headers) || createCorrelationId();
  const refreshed = await getValidAccessTokenForUser({
    userId: session.appUserId as string,
    correlationId,
    forceRefresh: true,
  });

  if (!refreshed.ok) {
    const status =
      refreshed.code === "MISSING_REFRESH_TOKEN" || refreshed.code === "INVALID_GRANT"
        ? 401
        : 503;
    return jsonNoStore(
      {
        ok: false,
        error: refreshed.code,
        correlationId,
      },
      status,
      { "x-correlation-id": correlationId }
    );
  }

  let appTokenError: string | null = null;
  try {
    await getAppAccessToken();
  } catch (error) {
    appTokenError = String(error).slice(0, 256);
  }
  const now = Date.now();
  const appTokenStatus = getAppTokenStatus(now);
  const userExpiresInSec =
    typeof refreshed.accessExpiresAt === "number" && refreshed.accessExpiresAt > 0
      ? Math.max(0, Math.floor((refreshed.accessExpiresAt - now) / 1000))
      : null;

  return jsonNoStore(
    {
      ok: !appTokenError,
      expiresAt: refreshed.accessExpiresAt,
      expiresInSec: userExpiresInSec,
      scope: refreshed.scope,
      appToken: {
        ...appTokenStatus,
        lastError: appTokenError ?? appTokenStatus.lastError,
      },
      correlationId,
    },
    200,
    { "x-correlation-id": correlationId }
  );
}
