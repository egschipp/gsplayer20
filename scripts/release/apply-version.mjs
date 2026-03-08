import { normalizeVersion, readJsonFile, writeJsonFile } from "./semver-utils.mjs";

const version = normalizeVersion(process.argv[2] ?? "");

if (!version) {
  throw new Error("Usage: node scripts/release/apply-version.mjs <MAJOR.MINOR.PATCH>");
}

const pkg = readJsonFile("package.json");
pkg.version = version;
writeJsonFile("package.json", pkg);

try {
  const manifest = readJsonFile(".release-please-manifest.json");
  manifest["."] = version;
  writeJsonFile(".release-please-manifest.json", manifest);
} catch {
  // optional manifest
}
