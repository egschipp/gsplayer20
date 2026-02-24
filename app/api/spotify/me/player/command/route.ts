import { NextRequest } from "next/server";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { spotifyFetch } from "@/lib/spotify/client";
import {
  getCorrelationId,
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

const COMMAND_IDEMPOTENCY_TTL_MS = 60_000;

type CachedCommandResult = {
  status: number;
  body: Record<string, unknown>;
  expiresAt: number;
};

const commandResultCache = new Map<string, CachedCommandResult>();

function parseSearch(input: unknown) {
  if (typeof input !== "string" || !input) return "";
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (!trimmed.startsWith("?")) return "";
  return trimmed.slice(0, 512);
}

function mapSpotifyError(error: unknown) {
  if (error instanceof SpotifyFetchError) {
    if (error.status === 401) return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
    if (error.status === 403) {
      if (error.code === "RESTRICTION_VIOLATED") {
        return jsonNoStore(
          {
            error: "RESTRICTION_VIOLATED",
            message: "Player command failed: Restriction violated",
          },
          403
        );
      }
      return jsonNoStore({ error: "FORBIDDEN" }, 403);
    }
    if (error.status === 404) return jsonNoStore({ error: "NOT_FOUND" }, 404);
    if (error.status === 409) {
      return jsonNoStore(
        {
          error: "DEVICE_CONFLICT",
          message: "Spotify Connect staat op een ander apparaat. Kies opnieuw.",
        },
        409
      );
    }
    if (error.status === 429) {
      const retryAfter =
        error.retryAfterMs && error.retryAfterMs > 0
          ? Math.max(1, Math.ceil(error.retryAfterMs / 1000))
          : null;
      return jsonNoStore(
        { error: "RATE_LIMIT", ...(retryAfter ? { retryAfter } : {}) },
        429,
        retryAfter ? { "Retry-After": String(retryAfter) } : undefined
      );
    }
    return jsonNoStore({ error: "SPOTIFY_UPSTREAM" }, 502);
  }
  if (String(error).includes("UserNotAuthenticated")) {
    return jsonNoStore({ error: "UNAUTHENTICATED" }, 401);
  }
  return jsonNoStore({ error: "PLAYER_COMMAND_FAILED" }, 500);
}

function cleanupCommandCache() {
  const now = Date.now();
  for (const [key, entry] of commandResultCache.entries()) {
    if (entry.expiresAt <= now) {
      commandResultCache.delete(key);
    }
  }
}

function parseCommandId(input: unknown) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 128);
}

function parseExpectedDeviceId(input: unknown) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 128);
}

function parseIntentSeq(input: unknown) {
  if (typeof input !== "number" || !Number.isFinite(input)) return null;
  return Math.max(0, Math.floor(input));
}

function parseTargetDeviceIdFromPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  if (typeof data.device_id === "string" && data.device_id.trim()) {
    return data.device_id.trim().slice(0, 128);
  }
  if (Array.isArray(data.device_ids)) {
    const candidate = data.device_ids.find(
      (value): value is string => typeof value === "string" && value.trim().length > 0
    );
    if (candidate) return candidate.trim().slice(0, 128);
  }
  return null;
}

function parseTargetDeviceIdFromSearch(search: string) {
  if (!search) return null;
  try {
    const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    const deviceId = params.get("device_id");
    if (!deviceId) return null;
    const trimmed = deviceId.trim();
    return trimmed ? trimmed.slice(0, 128) : null;
  } catch {
    return null;
  }
}

function cacheCommandResult(commandId: string, status: number, body: Record<string, unknown>) {
  cleanupCommandCache();
  commandResultCache.set(commandId, {
    status,
    body,
    expiresAt: Date.now() + COMMAND_IDEMPOTENCY_TTL_MS,
  });
}

export async function POST(req: NextRequest) {
  const correlationId = getCorrelationId(req);
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
        commandId?: string;
        expectedDeviceId?: string;
        intentSeq?: number;
      }
    | null;

  const method = String(body?.method ?? "GET").toUpperCase();
  const endpoint = String(body?.endpoint ?? "");
  const search = parseSearch(body?.search);
  const commandId = parseCommandId(body?.commandId);
  const expectedDeviceId = parseExpectedDeviceId(body?.expectedDeviceId);
  const intentSeq = parseIntentSeq(body?.intentSeq);

  if (!ALLOWED_METHODS.has(method)) {
    return jsonError("INVALID_METHOD", 400);
  }
  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    return jsonError("INVALID_ENDPOINT", 400);
  }

  const url = `https://api.spotify.com/v1/me/player${endpoint}${search}`;
  const payload = body?.payload;
  const explicitTargetDeviceId =
    parseTargetDeviceIdFromSearch(search) ?? parseTargetDeviceIdFromPayload(payload);

  const isMutatingCommand = method !== "GET";
  if (isMutatingCommand && commandId) {
    cleanupCommandCache();
    const cached = commandResultCache.get(commandId);
    if (cached && cached.expiresAt > Date.now()) {
      return jsonNoStore({ ...cached.body, cached: true }, cached.status);
    }
  }

  if (isMutatingCommand && expectedDeviceId) {
    try {
      const current = await spotifyFetch<{ device?: { id?: string | null } | null } | undefined>({
        url: "https://api.spotify.com/v1/me/player",
        userLevel: true,
        correlationId,
      });
      const currentDeviceId =
        typeof current?.device?.id === "string" ? current.device.id : null;
      if (currentDeviceId && currentDeviceId !== expectedDeviceId) {
        // If the command already carries an explicit target device_id, allow Spotify
        // to resolve that command instead of failing early on a stale local expectation.
        if (explicitTargetDeviceId) {
          // continue
        } else {
          const conflictBody = {
            error: "DEVICE_CONFLICT",
            expectedDeviceId,
            currentDeviceId,
            commandId,
            intentSeq,
          };
          if (commandId) {
            cacheCommandResult(commandId, 409, conflictBody);
          }
          return jsonNoStore(conflictBody, 409);
        }
      }
    } catch (error) {
      if (error instanceof SpotifyFetchError && error.status === 404) {
        // No active player; allow command to continue.
      } else {
        return mapSpotifyError(error);
      }
    }
  }

  try {
    const data = await spotifyFetch({
      url,
      method,
      body: method === "GET" ? undefined : payload,
      userLevel: true,
      correlationId,
    });
    if (method === "GET") {
      return jsonNoStore(data ?? {});
    }
    const responseBody = {
      ok: true,
      commandId,
      intentSeq,
      appliedAt: Date.now(),
    };
    if (commandId) {
      cacheCommandResult(commandId, 200, responseBody);
    }
    return jsonNoStore(responseBody);
  } catch (error) {
    return mapSpotifyError(error);
  }
}
