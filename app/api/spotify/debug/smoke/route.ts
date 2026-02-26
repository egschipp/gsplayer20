import { jsonNoStore, requireAppUser } from "@/lib/api/guards";
import { spotifyFetch } from "@/lib/spotify/client";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { createCorrelationId, readCorrelationId } from "@/lib/observability/correlation";

export const runtime = "nodejs";

function parseSeeds(value: string | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return [] as string[];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((id) => /^[0-9A-Za-z]{22}$/.test(id))
    .slice(0, 5);
}

export async function GET(req: Request) {
  const { response } = await requireAppUser();
  if (response) return response;

  const correlationId = readCorrelationId(req.headers) || createCorrelationId();
  const url = new URL(req.url);
  const market = String(url.searchParams.get("market") ?? "NL")
    .trim()
    .toUpperCase();
  const seeds = parseSeeds(url.searchParams.get("seed_tracks"));
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? "25") || 25));

  const checks: Array<{
    name: string;
    ok: boolean;
    status: number;
    code?: string;
    message?: string;
    url?: string | null;
    contentType?: string | null;
  }> = [];

  // 1) /v1/me
  try {
    await spotifyFetch({
      url: "https://api.spotify.com/v1/me",
      userLevel: true,
      correlationId,
      priority: "interactive",
      requestClass: "read",
      maxAttempts: 1,
    });
    checks.push({
      name: "me",
      ok: true,
      status: 200,
      url: "https://api.spotify.com/v1/me",
    });
  } catch (error) {
    if (error instanceof SpotifyFetchError) {
      checks.push({
        name: "me",
        ok: false,
        status: error.status,
        code: error.code,
        message: String(error.body ?? "").slice(0, 300),
        url: error.url,
        contentType: error.responseContentType,
      });
    } else {
      checks.push({
        name: "me",
        ok: false,
        status: 500,
        code: "INTERNAL_ERROR",
        message: String(error),
      });
    }
  }

  // 2) /v1/recommendations
  if (seeds.length === 5) {
    const qs = new URLSearchParams({
      limit: String(limit),
      market,
      seed_tracks: seeds.join(","),
    });
    const recoUrl = `https://api.spotify.com/v1/recommendations?${qs.toString()}`;
    try {
      await spotifyFetch({
        url: recoUrl,
        userLevel: true,
        correlationId,
        priority: "interactive",
        requestClass: "read",
        maxAttempts: 1,
      });
      checks.push({
        name: "recommendations",
        ok: true,
        status: 200,
        url: recoUrl,
      });
    } catch (error) {
      if (error instanceof SpotifyFetchError) {
        checks.push({
          name: "recommendations",
          ok: false,
          status: error.status,
          code: error.code,
          message: String(error.body ?? "").slice(0, 300),
          url: error.url ?? recoUrl,
          contentType: error.responseContentType,
        });
      } else {
        checks.push({
          name: "recommendations",
          ok: false,
          status: 500,
          code: "INTERNAL_ERROR",
          message: String(error),
          url: recoUrl,
        });
      }
    }
  } else {
    checks.push({
      name: "recommendations",
      ok: false,
      status: 400,
      code: "INVALID_SEEDS",
      message: "Geef exact 5 geldige track IDs mee in seed_tracks.",
    });
  }

  const hasFailure = checks.some((check) => !check.ok);
  return jsonNoStore(
    {
      ok: !hasFailure,
      correlationId,
      checks,
      note: "Server haalt token zelf op via sessie; tokenwaarde wordt niet geretourneerd.",
    },
    hasFailure ? 502 : 200,
    { "x-correlation-id": correlationId }
  );
}

