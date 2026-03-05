import { NextRequest } from "next/server";
import { SpotifyFetchError } from "@/lib/spotify/errors";
import { spotifyFetch } from "@/lib/spotify/client";
import { nextPlayerSyncSeq } from "@/lib/spotify/playerSyncSeq";
import {
  getCorrelationId,
  jsonError,
  jsonNoStore,
  rateLimitResponse,
  requireAppUser,
  requireSameOrigin,
} from "@/lib/api/guards";
import {
  ephemeralGetJson,
  ephemeralSetJson,
} from "@/lib/server/ephemeralStore";

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
};

function parseSearch(input: unknown) {
  if (typeof input !== "string" || !input) return "";
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (!trimmed.startsWith("?")) return "";
  return trimmed.slice(0, 512);
}

function hasExplicitCommandDeviceTarget(
  endpoint: string,
  search: string,
  payload: unknown
): boolean {
  if (endpoint === "") {
    const body = payload as { device_ids?: unknown } | null | undefined;
    if (
      Array.isArray(body?.device_ids) &&
      body.device_ids.some(
        (value) => typeof value === "string" && value.trim().length > 0
      )
    ) {
      return true;
    }
  }

  if (!search) return false;
  try {
    const query = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    const deviceId = query.get("device_id");
    return Boolean(deviceId && deviceId.trim());
  } catch {
    return false;
  }
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

function commandCacheKey(userKey: string, commandId: string) {
  return `player:command-result:${userKey}:${commandId}`;
}

async function cacheCommandResult(
  userKey: string,
  commandId: string,
  status: number,
  body: Record<string, unknown>
) {
  await ephemeralSetJson(
    commandCacheKey(userKey, commandId),
    {
      status,
      body,
    } satisfies CachedCommandResult,
    COMMAND_IDEMPOTENCY_TTL_MS
  );
}

export async function POST(req: NextRequest) {
  const correlationId = getCorrelationId(req);
  const originError = requireSameOrigin(req);
  if (originError) return originError;

  const { session, response } = await requireAppUser();
  if (response) return response;
  const userKey = String(session.appUserId || "");

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

  const isMutatingCommand = method !== "GET";
  if (isMutatingCommand && commandId) {
    const cached = await ephemeralGetJson<CachedCommandResult>(
      commandCacheKey(userKey, commandId)
    );
    if (cached) {
      return jsonNoStore({ ...cached.body, cached: true }, cached.status);
    }
  }

  const hasExplicitDeviceTarget = hasExplicitCommandDeviceTarget(
    endpoint,
    search,
    payload
  );

  if (isMutatingCommand && expectedDeviceId && !hasExplicitDeviceTarget) {
    try {
      const current = await spotifyFetch<{ device?: { id?: string | null } | null } | undefined>({
        url: "https://api.spotify.com/v1/me/player",
        userLevel: true,
        correlationId,
        priority: "foreground",
        cacheTtlMs: 0,
        dedupeWindowMs: 200,
      });
      const currentDeviceId =
        typeof current?.device?.id === "string" ? current.device.id : null;
      if (currentDeviceId && currentDeviceId !== expectedDeviceId) {
        const conflictBody = {
          error: "DEVICE_CONFLICT",
          expectedDeviceId,
          currentDeviceId,
          commandId,
          intentSeq,
          sync: {
            serverSeq: nextPlayerSyncSeq(userKey),
            serverTime: Date.now(),
            source: "command_conflict",
          },
        };
        if (commandId) {
          await cacheCommandResult(userKey, commandId, 409, conflictBody);
        }
        return jsonNoStore(conflictBody, 409);
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
      priority: method === "GET" ? "foreground" : "foreground",
      cacheTtlMs: method === "GET" ? 0 : 0,
      dedupeWindowMs: method === "GET" ? 200 : 200,
      bypassCache: method !== "GET",
    });
    if (method === "GET") {
      return jsonNoStore(data ?? {});
    }
    const responseBody = {
      ok: true,
      commandId,
      intentSeq,
      appliedAt: Date.now(),
      sync: {
        serverSeq: nextPlayerSyncSeq(userKey),
        serverTime: Date.now(),
        source: "command_ack",
      },
    };
    if (commandId) {
      await cacheCommandResult(userKey, commandId, 200, responseBody);
    }
    return jsonNoStore(responseBody);
  } catch (error) {
    return mapSpotifyError(error);
  }
}
