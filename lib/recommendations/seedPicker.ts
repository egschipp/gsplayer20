import crypto from "crypto";

const TRACK_ID_PATTERN = /^[0-9A-Za-z]{22}$/;
const MAX_SELECTED_TRACK_IDS = 200;

type SeededRng = () => number;

function buildSeededRng(seedHex: string): SeededRng {
  const seedBytes = Buffer.from(seedHex.slice(0, 8), "hex");
  let state = seedBytes.readUInt32BE(0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const normalized = (state >>> 0) / 0x100000000;
    return Math.min(0.999999999, Math.max(0, normalized));
  };
}

function deterministicSampleWithoutReplacement(
  input: string[],
  count: number,
  rng: SeededRng
): string[] {
  const pool = [...input];
  const max = Math.min(count, pool.length);
  for (let i = 0; i < max; i += 1) {
    const offset = Math.floor(rng() * (pool.length - i));
    const j = i + offset;
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, max);
}

function cryptoSampleWithoutReplacement(input: string[], count: number): string[] {
  const pool = [...input];
  const max = Math.min(count, pool.length);
  for (let i = 0; i < max; i += 1) {
    const j = i + crypto.randomInt(0, pool.length - i);
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, max);
}

export function normalizeSelectedIds(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values.slice(0, MAX_SELECTED_TRACK_IDS)) {
    const id = String(raw ?? "").trim();
    if (!TRACK_ID_PATTERN.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function computeSelectionHash(ids: string[]): string {
  const normalized = [...ids].sort().join(",");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export function pickSeeds(args: {
  normalizedIds: string[];
  seedCountMax: number;
  seedNonce?: string | null;
  userId: string;
}): {
  seedTrackIds: string[];
  selectionHash: string;
  deterministic: boolean;
} {
  const seedCount = Math.max(1, Math.min(5, Math.floor(args.seedCountMax || 5)));
  const selectionHash = computeSelectionHash(args.normalizedIds);
  if (args.normalizedIds.length <= seedCount) {
    return {
      seedTrackIds: [...args.normalizedIds],
      selectionHash,
      deterministic: Boolean(args.seedNonce),
    };
  }

  const nonce = String(args.seedNonce ?? "").trim();
  if (nonce) {
    const seededHash = crypto
      .createHash("sha256")
      .update(`${nonce}|${selectionHash}|${args.userId}`)
      .digest("hex");
    return {
      seedTrackIds: deterministicSampleWithoutReplacement(
        args.normalizedIds,
        seedCount,
        buildSeededRng(seededHash)
      ),
      selectionHash,
      deterministic: true,
    };
  }

  return {
    seedTrackIds: cryptoSampleWithoutReplacement(args.normalizedIds, seedCount),
    selectionHash,
    deterministic: false,
  };
}
