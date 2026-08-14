import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sourceRoots = ["app", "components", "lib", "src"];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs"]);

// These two orchestration components are being reduced incrementally. The fixed
// ceilings prevent regression and must only move downward during extraction.
const legacyLineBudgets = new Map([
  ["app/components/SpotifyPlayer.tsx", 7_400],
  ["app/components/PlaylistBrowser.tsx", 6_120],
  ["app/components/MonitoringDashboard.tsx", 2_410],
]);

const defaultComponentBudget = 1_000;
const extractedDomainModuleBudget = 350;

async function collectFiles(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.join(directory, entry.name);
      return entry.isDirectory() ? collectFiles(relative) : [relative];
    })
  );
  return files.flat();
}

const files = (await Promise.all(sourceRoots.map(collectFiles)))
  .flat()
  .filter((file) => sourceExtensions.has(path.extname(file)));
const violations = [];

for (const file of files) {
  const content = await readFile(path.join(root, file), "utf8");
  const lineCount = content.split(/\r?\n/).length;
  const legacyBudget = legacyLineBudgets.get(file);

  if (legacyBudget && lineCount > legacyBudget) {
    violations.push(`${file}: ${lineCount} lines exceeds legacy ceiling ${legacyBudget}`);
  } else if (
    (file.startsWith("app/components/") || file.startsWith("components/")) &&
    file.endsWith(".tsx") &&
    !legacyBudget &&
    lineCount > defaultComponentBudget
  ) {
    violations.push(
      `${file}: ${lineCount} lines exceeds component budget ${defaultComponentBudget}`
    );
  }

  if (
    (file.startsWith("app/components/player/") ||
      file.startsWith("app/components/playlist/")) &&
    file.endsWith(".ts") &&
    !file.endsWith(".test.ts") &&
    lineCount > extractedDomainModuleBudget
  ) {
    violations.push(
      `${file}: ${lineCount} lines exceeds extracted module budget ${extractedDomainModuleBudget}`
    );
  }

  if (file.startsWith("lib/") && /from\s+["']@\/app\//.test(content)) {
    violations.push(`${file}: domain/infrastructure code may not import from app/`);
  }
}

if (violations.length > 0) {
  console.error("Architecture quality gate failed:\n" + violations.join("\n"));
  process.exit(1);
}

console.log(`Architecture quality gate passed (${files.length} source modules checked).`);
