import { readFile } from "fs/promises";
import path from "path";

export type AppVersionSource = "env" | "package";

export type AppVersionPayload = {
  name: string;
  version: string;
  source: AppVersionSource;
};

function normalizeVersionTag(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, "");
}

function isPlaceholderVersion(input: string | null | undefined) {
  if (!input) return true;
  const value = input.trim();
  return value === "0.0.0" || value === "0.0" || value === "0";
}

function parseSemver(input: string | null | undefined) {
  if (!input) return null;
  const normalized = normalizeVersionTag(input);
  if (!normalized) return null;
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(a: string, b: string) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  if (left.major !== right.major) return left.major > right.major ? 1 : -1;
  if (left.minor !== right.minor) return left.minor > right.minor ? 1 : -1;
  if (left.patch !== right.patch) return left.patch > right.patch ? 1 : -1;
  return 0;
}

async function readPackageVersion(): Promise<{ name: string; version: string }> {
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string; name?: string };
    return {
      name: pkg.name ?? process.env.APP_NAME ?? "gsplayer20",
      version:
        normalizeVersionTag(pkg.version) ??
        normalizeVersionTag(process.env.APP_RELEASE_VERSION) ??
        "0.0.0",
    };
  } catch {
    return {
      name: process.env.APP_NAME ?? "gsplayer20",
      version: normalizeVersionTag(process.env.APP_RELEASE_VERSION) ?? "0.0.0",
    };
  }
}

export async function resolveAppVersion(options?: {
  envVersion?: string | null;
}): Promise<AppVersionPayload> {
  const packageVersion = await readPackageVersion();
  const envVersion = normalizeVersionTag(
    options?.envVersion ?? process.env.APP_RELEASE_VERSION
  );
  const hasEnvVersion = Boolean(envVersion && !isPlaceholderVersion(envVersion));
  const hasPackageVersion = !isPlaceholderVersion(packageVersion.version);

  if (hasEnvVersion && hasPackageVersion) {
    const comparison = compareSemver(envVersion!, packageVersion.version);
    if (comparison === null || comparison >= 0) {
      return {
        name: packageVersion.name,
        version: envVersion!,
        source: "env",
      };
    }
    return {
      name: packageVersion.name,
      version: packageVersion.version,
      source: "package",
    };
  }

  if (hasEnvVersion) {
    return {
      name: packageVersion.name,
      version: envVersion!,
      source: "env",
    };
  }

  if (hasPackageVersion) {
    return {
      name: packageVersion.name,
      version: packageVersion.version,
      source: "package",
    };
  }

  return {
    name: packageVersion.name,
    version: "0.0.0",
    source: "package",
  };
}
