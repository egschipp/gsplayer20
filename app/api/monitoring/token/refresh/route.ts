import { jsonNoStore, requireAppUser } from "@/lib/api/guards";
import { getValidAccessTokenForUser } from "@/lib/spotify/tokenManager";
import {
  createCorrelationId,
  readCorrelationId,
} from "@/lib/observability/correlation";

export const runtime = "nodejs";

export async function POST(req: Request) {
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

  return jsonNoStore(
    {
      ok: true,
      expiresAt: refreshed.accessExpiresAt,
      scope: refreshed.scope,
      correlationId,
    },
    200,
    { "x-correlation-id": correlationId }
  );
}

