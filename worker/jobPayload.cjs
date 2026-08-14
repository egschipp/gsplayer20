const crypto = require("node:crypto");

const SPOTIFY_ID_REGEX = /^[A-Za-z0-9]{22}$/;

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function parseJobPayload(rawPayload) {
  if (!rawPayload) return {};
  try {
    const parsed = JSON.parse(rawPayload);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Malformed queue payloads are handled as empty, bounded job input.
  }
  return {};
}

function normalizeCursor(value) {
  return typeof value === "string" ? value.slice(0, 128) : "";
}

function normalizePlaylistId(value) {
  if (typeof value !== "string") return null;
  return SPOTIFY_ID_REGEX.test(value) ? value : null;
}

function envInt(name, min, max, fallback, environment = process.env) {
  return clampInt(environment[name], min, max, fallback);
}

function sanitizeRequeuePayload(type, payload, result) {
  const next = { ...payload };
  if (result.nextOffset !== undefined) {
    next.offset = clampInt(result.nextOffset, 0, 100_000, 0);
  }
  if (result.nextCursor !== undefined) {
    next.cursor = normalizeCursor(result.nextCursor);
  }

  if (next.limit !== undefined) {
    next.limit = clampInt(next.limit, 1, 50, 50);
  }
  if (next.maxPagesPerRun !== undefined) {
    next.maxPagesPerRun = clampInt(next.maxPagesPerRun, 1, 200, 10);
  }
  if (next.maxBatches !== undefined) {
    next.maxBatches = clampInt(next.maxBatches, 1, 200, 20);
  }

  if (type === "SYNC_PLAYLIST_ITEMS") {
    const playlistId = normalizePlaylistId(next.playlistId);
    if (playlistId) next.playlistId = playlistId;
    else delete next.playlistId;

    next.runId =
      typeof next.runId === "string" && next.runId.length <= 128
        ? next.runId
        : crypto.randomUUID();
    next.snapshotId =
      typeof next.snapshotId === "string" && next.snapshotId.length <= 256
        ? next.snapshotId
        : null;
  }

  return next;
}

module.exports = {
  clampInt,
  envInt,
  normalizeCursor,
  normalizePlaylistId,
  parseJobPayload,
  sanitizeRequeuePayload,
};
