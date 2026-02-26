import { readFile } from "fs/promises";
import path from "path";

export type AppVersionSource = "release" | "tag" | "env" | "package";

export type AppVersionPayload = {
  name: string;
  version: string;
  source: AppVersionSource;
};

const DEFAULT_REPO = "egschipp/gsplayer20";
const RELEASE_CACHE_TTL_MS = 1000 * 60 * 5;

let cachedRemoteVersion:
  | { value: string; source: "release" | "tag"; expiresAt: number }
  | null = null;

function normalizeVersionTag(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, "");
}

async function readPackageVersion(): Promise<{ name: string; version: string }> {
  const pkgPath = path.join(process.cwd(), "package.json");
  const raw = await readFile(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as { version?: string; name?: string };
  return {
    name: pkg.name ?? "app",
    version: normalizeVersionTag(pkg.version) ?? "0.0.0",
  };
}

async function fetchLatestReleaseVersion(repo: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "gsplayer20-version-endpoint",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const data = (await res.json()) as { tag_name?: string };
    const normalized = normalizeVersionTag(data.tag_name);
    if (!normalized) return null;
    return normalized;
  } catch {
    return null;
  }
}

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: boolean;
};

function parseSemver(input: string): ParsedSemver | null {
  const match = input.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: input.includes("-"),
  };
}

function compareVersions(a: string, b: string) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return a.localeCompare(b, "en");
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease !== pb.prerelease) return pa.prerelease ? -1 : 1;
  return 0;
}

async function fetchLatestTagVersion(repo: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=100`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "gsplayer20-version-endpoint",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = (await res.json()) as { name?: string }[];
    if (!Array.isArray(data) || data.length === 0) return null;

    const versions = data
      .map((entry) => normalizeVersionTag(entry?.name))
      .filter((value): value is string => Boolean(value));

    if (!versions.length) return null;
    const sorted = versions.sort((a, b) => compareVersions(b, a));
    return sorted[0] ?? null;
  } catch {
    return null;
  }
}

export async function resolveAppVersion(options?: {
  repo?: string | null;
  envVersion?: string | null;
}): Promise<AppVersionPayload> {
  const packageVersion = await readPackageVersion();
  const envVersion = normalizeVersionTag(
    options?.envVersion ?? process.env.APP_RELEASE_VERSION
  );
  if (envVersion) {
    return {
      name: packageVersion.name,
      version: envVersion,
      source: "env",
    };
  }

  // Default to local package version so UI reflects deployed code rollback state.
  // Set APP_VERSION_SOURCE=remote to restore remote release/tag resolution.
  const versionSource = String(process.env.APP_VERSION_SOURCE ?? "package")
    .trim()
    .toLowerCase();
  if (versionSource !== "remote") {
    return {
      name: packageVersion.name,
      version: packageVersion.version,
      source: "package",
    };
  }

  const repo = options?.repo?.trim() || process.env.GITHUB_RELEASE_REPO?.trim() || DEFAULT_REPO;
  const now = Date.now();
  if (cachedRemoteVersion && cachedRemoteVersion.expiresAt > now) {
    return {
      name: packageVersion.name,
      version: cachedRemoteVersion.value,
      source: cachedRemoteVersion.source,
    };
  }

  const [releaseVersion, tagVersion] = await Promise.all([
    fetchLatestReleaseVersion(repo),
    fetchLatestTagVersion(repo),
  ]);

  let selectedVersion: string | null = null;
  let selectedSource: "release" | "tag" | null = null;

  if (releaseVersion && tagVersion) {
    if (compareVersions(tagVersion, releaseVersion) > 0) {
      selectedVersion = tagVersion;
      selectedSource = "tag";
    } else {
      selectedVersion = releaseVersion;
      selectedSource = "release";
    }
  } else if (tagVersion) {
    selectedVersion = tagVersion;
    selectedSource = "tag";
  } else if (releaseVersion) {
    selectedVersion = releaseVersion;
    selectedSource = "release";
  }

  if (selectedVersion && selectedSource) {
    cachedRemoteVersion = {
      value: selectedVersion,
      source: selectedSource,
      expiresAt: now + RELEASE_CACHE_TTL_MS,
    };
    return {
      name: packageVersion.name,
      version: selectedVersion,
      source: selectedSource,
    };
  }

  return {
    name: packageVersion.name,
    version: packageVersion.version,
    source: "package",
  };
}
