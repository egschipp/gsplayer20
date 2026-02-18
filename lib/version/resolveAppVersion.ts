import { readFile } from "fs/promises";
import path from "path";

export type AppVersionSource = "release" | "env" | "package";

export type AppVersionPayload = {
  name: string;
  version: string;
  source: AppVersionSource;
};

const DEFAULT_REPO = "egschipp/gsplayer20";
const RELEASE_CACHE_TTL_MS = 1000 * 60 * 5;

let cachedReleaseVersion: { value: string; expiresAt: number } | null = null;

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
  const now = Date.now();
  if (cachedReleaseVersion && cachedReleaseVersion.expiresAt > now) {
    return cachedReleaseVersion.value;
  }

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

    cachedReleaseVersion = {
      value: normalized,
      expiresAt: now + RELEASE_CACHE_TTL_MS,
    };
    return normalized;
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

  const repo = options?.repo?.trim() || process.env.GITHUB_RELEASE_REPO?.trim() || DEFAULT_REPO;
  const releaseVersion = await fetchLatestReleaseVersion(repo);
  if (releaseVersion) {
    return {
      name: packageVersion.name,
      version: releaseVersion,
      source: "release",
    };
  }

  return {
    name: packageVersion.name,
    version: packageVersion.version,
    source: "package",
  };
}

