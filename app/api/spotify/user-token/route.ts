import { jsonNoStore, requireAppUser } from "@/lib/api/guards";
import { getValidAccessTokenForUser } from "@/lib/spotify/tokenManager";
import {
  createCorrelationId,
  readCorrelationId,
} from "@/lib/observability/correlation";

export const runtime = "nodejs";

function shouldForceRefresh(req: Request) {
  const url = new URL(req.url);
  const raw = (url.searchParams.get("force") || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export async function GET(req: Request) {
  const { session, response } = await requireAppUser();
  if (response) return response;

  const correlationId = readCorrelationId(req.headers) || createCorrelationId();
  const tokenResult = await getValidAccessTokenForUser({
    userId: session.appUserId as string,
    correlationId,
    forceRefresh: shouldForceRefresh(req),
  });

  if (!tokenResult.ok) {
    const status =
      tokenResult.code === "MISSING_REFRESH_TOKEN" || tokenResult.code === "INVALID_GRANT"
        ? 401
        : 503;
    return jsonNoStore(
      {
        ok: false,
        error: tokenResult.code,
        correlationId,
      },
      status,
      { "x-correlation-id": correlationId }
    );
  }

  const now = Date.now();
  const expiresInSec =
    typeof tokenResult.accessExpiresAt === "number" && tokenResult.accessExpiresAt > 0
      ? Math.max(0, Math.floor((tokenResult.accessExpiresAt - now) / 1000))
      : null;

  return jsonNoStore(
    {
      ok: true,
      accessToken: tokenResult.accessToken,
      expiresAt: tokenResult.accessExpiresAt,
      expiresInSec,
      scope: tokenResult.scope,
      correlationId,
    },
    200,
    { "x-correlation-id": correlationId }
  );
}
