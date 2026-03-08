import fs from "node:fs";

export function normalizeVersion(input) {
  if (typeof input !== "string") return null;
  const value = input.trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+$/.test(value) ? value : null;
}

export function parseVersion(input) {
  const normalized = normalizeVersion(input);
  if (!normalized) return null;
  const [major, minor, patch] = normalized.split(".").map((part) => Number(part));
  return { major, minor, patch };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return 0;
}

export function maxVersion(...values) {
  return values
    .map((value) => normalizeVersion(value))
    .filter(Boolean)
    .sort(compareVersions)
    .at(-1) ?? "0.0.0";
}

export function bumpVersion(version, bump) {
  const parsed = parseVersion(version);
  if (!parsed) {
    throw new Error(`Invalid semver version: ${version}`);
  }
  if (bump === "major") {
    return `${parsed.major + 1}.0.0`;
  }
  if (bump === "minor") {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export function readJsonFile(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

export function writeJsonFile(path, value) {
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
