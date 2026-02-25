import crypto from "crypto";

const TRACK_ID_REGEX = /^[A-Za-z0-9]{22}$/;

export type PlaylistSeedCandidate = {
  trackId: string | null;
  linkedFromTrackId: string | null;
  isLocal: number | null;
  restrictionsReason: string | null;
  position: number | null;
  itemId: string | null;
};

type SeedSelectorResult = {
  seedTrackPool: string[];
  blockedTrackIds: Set<string>;
  snapshotToken: string;
  eligibleCount: number;
};

function hashText(value: string) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

export function normalizeTrackId(value: unknown) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (TRACK_ID_REGEX.test(raw)) return raw;
  if (raw.startsWith("spotify:track:")) {
    const id = raw.split(":").pop() ?? "";
    return TRACK_ID_REGEX.test(id) ? id : null;
  }
  try {
    const parsed = new URL(raw);
    const match = parsed.pathname.match(/\/track\/([A-Za-z0-9]{22})/);
    if (match?.[1]) return match[1];
  } catch {
    // ignore non-url inputs
  }
  return null;
}

export function resolveCanonicalTrackId(candidate: {
  trackId: string | null;
  linkedFromTrackId: string | null;
}) {
  // For recommendation seeds we prefer the concrete playable track id from the playlist item.
  return (
    normalizeTrackId(candidate.trackId) ?? normalizeTrackId(candidate.linkedFromTrackId) ?? null
  );
}

function buildSnapshotToken(args: {
  playlistId: string;
  snapshotId: string | null;
  candidateIds: string[];
}) {
  if (args.snapshotId) return args.snapshotId;
  const fingerprintBase = args.candidateIds.slice(0, 400).join(",");
  return `derived:${hashText(`${args.playlistId}|${fingerprintBase}|v2`)}`;
}

export function selectDeterministicPlaylistSeedPool(args: {
  playlistId: string;
  snapshotId: string | null;
  candidates: PlaylistSeedCandidate[];
  maxSeedPoolSize?: number;
}) {
  const { playlistId, snapshotId, candidates, maxSeedPoolSize = 25 } = args;
  const canonicalById = new Map<
    string,
    {
      position: number;
      itemId: string;
    }
  >();

  for (const candidate of candidates) {
    if (candidate.isLocal === 1) continue;
    if (
      typeof candidate.restrictionsReason === "string" &&
      candidate.restrictionsReason.trim().length > 0
    ) {
      continue;
    }
    const canonicalId = resolveCanonicalTrackId(candidate);
    if (!canonicalId) continue;
    const position =
      typeof candidate.position === "number" && Number.isFinite(candidate.position)
        ? Math.floor(candidate.position)
        : Number.MAX_SAFE_INTEGER;
    const itemId = String(candidate.itemId ?? "");
    const existing = canonicalById.get(canonicalId);
    if (!existing) {
      canonicalById.set(canonicalId, { position, itemId });
      continue;
    }
    if (position < existing.position) {
      canonicalById.set(canonicalId, { position, itemId });
      continue;
    }
    if (position === existing.position && itemId && (!existing.itemId || itemId < existing.itemId)) {
      canonicalById.set(canonicalId, { position, itemId });
    }
  }

  const allCanonicalIds = Array.from(canonicalById.keys());
  const snapshotToken = buildSnapshotToken({
    playlistId,
    snapshotId,
    candidateIds: allCanonicalIds,
  });

  const ordered = allCanonicalIds
    .map((canonicalId) => ({
      canonicalId,
      orderKey: hashText(`${playlistId}|${snapshotToken}|${canonicalId}|seed-v2`),
      position: canonicalById.get(canonicalId)?.position ?? Number.MAX_SAFE_INTEGER,
      itemId: canonicalById.get(canonicalId)?.itemId ?? "",
    }))
    .sort((a, b) => {
      if (a.orderKey !== b.orderKey) return a.orderKey.localeCompare(b.orderKey);
      if (a.position !== b.position) return a.position - b.position;
      if (a.itemId !== b.itemId) return a.itemId.localeCompare(b.itemId);
      return a.canonicalId.localeCompare(b.canonicalId);
    });

  const seedTrackPool = ordered
    .slice(0, Math.max(1, Math.floor(maxSeedPoolSize)))
    .map((entry) => entry.canonicalId);

  const result: SeedSelectorResult = {
    seedTrackPool,
    blockedTrackIds: new Set<string>(seedTrackPool),
    snapshotToken,
    eligibleCount: allCanonicalIds.length,
  };
  return result;
}
