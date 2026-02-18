import { NextRequest } from "next/server";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { spotifyFetch } from "@/lib/spotify/client";
import {
  jsonError,
  jsonNoStore,
  rateLimitResponse,
  requireAppUser,
  requireSameOrigin,
} from "@/lib/api/guards";

export const runtime = "nodejs";

const ALLOWED_METHODS = new Set(["GET", "PUT", "POST"]);
const ALLOWED_ENDPOINTS = new Set([
  "",
  "/play",
  "/pause",
  "/next",
  "/previous",
  "/seek",
  "/shuffle",
  "/repeat",
  "/volume",
  "/queue",
]);

function parseSearch(input: unknown) {
  if (typeof input !== "string" || !input) return "";
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (!trimmed.startsWith("?")) return "";
  return trimmed.slice(0, 512);
}

function mapSpotifyError(error: unknown) {
  if (error instanceof SpotifyFetchError) {
    if (error.status === 401) return jsonError("UNAUTHENTICATED", 401);
    if (error.status === 403) return jsonError("FORBIDDEN", 403);
    if (error.status === 404) return jsonError("NOT_FOUND", 404);
    if (error.status === 429) return jsonError("RATE_LIMIT", 429);
    return jsonError("SPOTIFY_UPSTREAM", 502);
  }
  if (String(error).includes("UserNotAuthenticated")) {
    return jsonError("UNAUTHENTICATED", 401);
  }
  return jsonError("PLAYER_COMMAND_FAILED", 500);
}

export async function POST(req: NextRequest) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;

  const { session, response } = await requireAppUser();
  if (response) return response;

  const rl = await rateLimitResponse({
    key: `me-player-command:${session.appUserId}`,
    limit: 300,
    windowMs: 60_000,
    includeRetryAfter: true,
  });
  if (rl) return rl;

  const body = (await req.json().catch(() => null)) as
    | {
        method?: string;
        endpoint?: string;
        search?: string;
        payload?: unknown;
      }
    | null;

  const method = String(body?.method ?? "GET").toUpperCase();
  const endpoint = String(body?.endpoint ?? "");
  const search = parseSearch(body?.search);

  if (!ALLOWED_METHODS.has(method)) {
    return jsonError("INVALID_METHOD", 400);
  }
  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    return jsonError("INVALID_ENDPOINT", 400);
  }

  const url = `https://api.spotify.com/v1/me/player${endpoint}${search}`;
  const payload = body?.payload;

  try {
    const data = await spotifyFetch({
      url,
      method,
      body: method === "GET" ? undefined : payload,
      userLevel: true,
    });
    if (method === "GET") {
      return jsonNoStore(data ?? {});
    }
    return jsonNoStore({ ok: true });
  } catch (error) {
    return mapSpotifyError(error);
  }
}
