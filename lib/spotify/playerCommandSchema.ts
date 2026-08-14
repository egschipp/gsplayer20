import { z } from "zod";

const deviceId = z.string().trim().min(1).max(128);
const spotifyUri = z
  .string()
  .trim()
  .regex(/^spotify:(track|episode|album|artist|playlist|show):[A-Za-z0-9]+$/);

const commandEnvelope = z.object({
  method: z.enum(["GET", "PUT", "POST"]),
  endpoint: z.enum([
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
  ]),
  search: z.string().max(512),
  payload: z.unknown().optional(),
});

const legalMethodByEndpoint: Record<string, ReadonlySet<string>> = {
  "": new Set(["GET", "PUT"]),
  "/play": new Set(["PUT"]),
  "/pause": new Set(["PUT"]),
  "/next": new Set(["POST"]),
  "/previous": new Set(["POST"]),
  "/seek": new Set(["PUT"]),
  "/shuffle": new Set(["PUT"]),
  "/repeat": new Set(["PUT"]),
  "/volume": new Set(["PUT"]),
  "/queue": new Set(["GET", "POST"]),
};

const allowedQueryByEndpoint: Record<string, ReadonlySet<string>> = {
  "": new Set(),
  "/play": new Set(["device_id"]),
  "/pause": new Set(["device_id"]),
  "/next": new Set(["device_id"]),
  "/previous": new Set(["device_id"]),
  "/seek": new Set(["device_id", "position_ms"]),
  "/shuffle": new Set(["device_id", "state"]),
  "/repeat": new Set(["device_id", "state"]),
  "/volume": new Set(["device_id", "volume_percent"]),
  "/queue": new Set(["device_id", "uri"]),
};

function validateSearch(endpoint: string, method: string, search: string): boolean {
  const query = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const allowed = allowedQueryByEndpoint[endpoint] ?? new Set<string>();
  for (const key of query.keys()) {
    if (!allowed.has(key)) return false;
  }
  const targetDevice = query.get("device_id");
  if (targetDevice && !deviceId.safeParse(targetDevice).success) return false;
  const position = query.get("position_ms");
  if (position != null && (!/^\d+$/.test(position) || Number(position) > 86_400_000)) {
    return false;
  }
  const volume = query.get("volume_percent");
  if (volume != null && (!/^\d+$/.test(volume) || Number(volume) > 100)) return false;
  const state = query.get("state");
  if (endpoint === "/shuffle" && state != null && !["true", "false"].includes(state)) {
    return false;
  }
  if (
    endpoint === "/repeat" &&
    state != null &&
    !["off", "track", "context"].includes(state)
  ) {
    return false;
  }
  const uri = query.get("uri");
  if (endpoint === "/queue" && method === "POST" && !spotifyUri.safeParse(uri).success) {
    return false;
  }
  return true;
}

function validatePayload(endpoint: string, method: string, payload: unknown): boolean {
  if (endpoint === "" && method === "PUT") {
    return z
      .object({
        device_ids: z.array(deviceId).min(1).max(5),
        play: z.boolean().optional(),
      })
      .strict()
      .safeParse(payload).success;
  }
  if (endpoint === "/play" && method === "PUT") {
    return z
      .object({
        context_uri: spotifyUri.optional(),
        uris: z.array(spotifyUri).min(1).max(100).optional(),
        offset: z
          .union([
            z.object({ position: z.number().int().min(0) }).strict(),
            z.object({ uri: spotifyUri }).strict(),
          ])
          .optional(),
        position_ms: z.number().int().min(0).max(86_400_000).optional(),
      })
      .strict()
      .safeParse(payload ?? {}).success;
  }
  return payload == null;
}

export function validatePlayerCommand(
  input: unknown
):
  | { ok: true }
  | { ok: false; error: "INVALID_COMMAND" | "INVALID_QUERY" | "INVALID_PAYLOAD" } {
  const parsed = commandEnvelope.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_COMMAND" };
  const { method, endpoint, search, payload } = parsed.data;
  if (!legalMethodByEndpoint[endpoint]?.has(method)) {
    return { ok: false, error: "INVALID_COMMAND" };
  }
  if (!validateSearch(endpoint, method, search)) {
    return { ok: false, error: "INVALID_QUERY" };
  }
  if (!validatePayload(endpoint, method, payload)) {
    return { ok: false, error: "INVALID_PAYLOAD" };
  }
  return { ok: true };
}
