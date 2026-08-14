import { readFile } from "node:fs/promises";
import path from "node:path";
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

export async function getCodebaseStats(): Promise<CodebaseStats> {
  const statsPath = path.join(process.cwd(), "public", "codebase-stats.json");
  try {
    return JSON.parse(await readFile(statsPath, "utf8")) as CodebaseStats;
  } catch {
    const version = await resolveAppVersion();
    return {
      appName: version.name,
      version: version.version,
      scannedAt: new Date(0).toISOString(),
      scannedRoots: [],
      totalFiles: 0,
      totalLines: 0,
      nonEmptyLines: 0,
      fileTypes: [],
    };
  }
}
