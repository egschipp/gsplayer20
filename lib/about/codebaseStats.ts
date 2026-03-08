import { readFile, readdir, stat } from "fs/promises";
import path from "path";
import { resolveAppVersion } from "@/lib/version/resolveAppVersion";

export type FileTypeStat = {
  type: string;
  files: number;
  lines: number;
  nonEmptyLines: number;
};

export type CodebaseStats = {
  appName: string;
  version: string;
  scannedAt: string;
  scannedRoots: string[];
  totalFiles: number;
  totalLines: number;
  nonEmptyLines: number;
  fileTypes: FileTypeStat[];
};

const SCAN_ROOTS = [
  "app",
  "lib",
  "components",
  "db",
  "pages",
  "types",
  ".github",
  "docs",
  "infra",
];

const ROOT_FILES = [
  "package.json",
  "next.config.js",
  "tsconfig.json",
  "eslint.config.js",
  "drizzle.config.js",
  "Dockerfile",
  "README.md",
  "proxy.ts",
  "worker.js",
];

const SKIP_DIRS = new Set([
  ".git",
  ".next",
  "node_modules",
  ".turbo",
  "coverage",
  "dist",
  "build",
  "out",
]);

const CACHE_TTL_MS = 60_000;
let cached: { at: number; value: CodebaseStats } | null = null;

async function pathExists(targetPath: string) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(dirPath: string, output: string[]) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkFiles(entryPath, output);
      continue;
    }
    if (!entry.isFile()) continue;
    output.push(entryPath);
  }
}

function countLines(text: string) {
  if (!text) return { lines: 0, nonEmptyLines: 0 };
  const rows = text.split(/\r?\n/);
  const nonEmptyLines = rows.filter((row) => row.trim().length > 0).length;
  return { lines: rows.length, nonEmptyLines };
}

function resolveType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext) return ext.slice(1);
  return path.basename(filePath).toLowerCase();
}

export async function getCodebaseStats(): Promise<CodebaseStats> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const absolute = path.join(process.cwd(), root);
    if (!(await pathExists(absolute))) continue;
    await walkFiles(absolute, files);
  }
  for (const fileName of ROOT_FILES) {
    const absolute = path.join(process.cwd(), fileName);
    if (await pathExists(absolute)) files.push(absolute);
  }

  const uniqueFiles = Array.from(new Set(files));
  const fileTypeMap = new Map<string, FileTypeStat>();
  let totalLines = 0;
  let nonEmptyLines = 0;

  for (const filePath of uniqueFiles) {
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const counts = countLines(content);
    totalLines += counts.lines;
    nonEmptyLines += counts.nonEmptyLines;

    const type = resolveType(filePath);
    const existing = fileTypeMap.get(type);
    if (existing) {
      existing.files += 1;
      existing.lines += counts.lines;
      existing.nonEmptyLines += counts.nonEmptyLines;
    } else {
      fileTypeMap.set(type, {
        type,
        files: 1,
        lines: counts.lines,
        nonEmptyLines: counts.nonEmptyLines,
      });
    }
  }

  const versionInfo = await resolveAppVersion();
  const value: CodebaseStats = {
    appName: versionInfo.name,
    version: versionInfo.version,
    scannedAt: new Date().toISOString(),
    scannedRoots: SCAN_ROOTS,
    totalFiles: uniqueFiles.length,
    totalLines,
    nonEmptyLines,
    fileTypes: Array.from(fileTypeMap.values()).sort((a, b) => {
      if (b.files !== a.files) return b.files - a.files;
      if (b.lines !== a.lines) return b.lines - a.lines;
      return a.type.localeCompare(b.type);
    }),
  };

  cached = { at: now, value };
  return value;
}
