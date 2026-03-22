import { execSync } from "node:child_process";
import { maxVersion, bumpVersion, readJsonFile } from "./semver-utils.mjs";

function readPackageVersion() {
  const pkg = readJsonFile("package.json");
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

function readManifestVersion() {
  try {
    const manifest = readJsonFile(".release-please-manifest.json");
    return typeof manifest["."] === "string" ? manifest["."] : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function readLatestTag() {
  const raw = execSync(
    "git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname",
    { encoding: "utf8" }
  )
    .trim()
    .split("\n")
    .filter(Boolean)[0];
  return raw ? raw.replace(/^v/, "") : "0.0.0";
}

function readCommitsSince(tag) {
  const range = tag && tag !== "0.0.0" ? `v${tag}..HEAD` : "HEAD";
  return execSync(`git log --format=%s%x1f%b%x1e ${range}`, { encoding: "utf8" })
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [subject = "", body = ""] = entry.split("\x1f");
      return {
        subject: subject.trim(),
        body: body.trim(),
      };
    });
}

function classifyCommit(subject, body) {
  if (!subject) return null;
  if (/^chore\(release\):/i.test(subject)) return null;
  if (/^release:/i.test(subject)) return null;
  if (/^merge\b/i.test(subject)) return null;
  if (/(^|[a-z]+(\([^)]+\))?)!:/i.test(subject) || /BREAKING CHANGE:/i.test(body)) {
    return "major";
  }
  if (/^feat(\([^)]+\))?:/i.test(subject)) return "minor";
  if (/^(fix|perf|refactor|revert|build|chore|ci|docs|style|test)(\([^)]+\))?:/i.test(subject)) {
    return "patch";
  }
  return "patch";
}

function highestBump(commits) {
  let level = null;
  for (const commit of commits) {
    const next = classifyCommit(commit.subject, commit.body);
    if (next === "major") return "major";
    if (next === "minor") level = level === "major" ? level : "minor";
    if (next === "patch" && !level) level = "patch";
  }
  return level;
}

const packageVersion = readPackageVersion();
const manifestVersion = readManifestVersion();
const latestTagVersion = readLatestTag();
const baseVersion = maxVersion(packageVersion, manifestVersion, latestTagVersion);
const commits = readCommitsSince(latestTagVersion);
const bump = highestBump(commits);
const shouldRelease = Boolean(bump);
const nextVersion = shouldRelease ? bumpVersion(baseVersion, bump) : baseVersion;

const lines = [
  `should_release=${shouldRelease ? "true" : "false"}`,
  `bump=${bump ?? "none"}`,
  `base_version=${baseVersion}`,
  `version=${nextVersion}`,
];

process.stdout.write(`${lines.join("\n")}\n`);
