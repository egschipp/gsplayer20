import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sourceRoots = ["app", "components", "lib", "src", "worker"];
const rootSourceFiles = ["worker.js"];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

// These legacy orchestration modules are being reduced incrementally. The fixed
// ceilings prevent regression and must only move downward during extraction.
const legacyLineBudgets = new Map([
  ["app/components/SpotifyPlayer.tsx", 7_400],
  ["app/components/PlaylistBrowser.tsx", 5_430],
  ["app/components/MonitoringDashboard.tsx", 1_960],
  ["worker.js", 1_720],
]);

const defaultComponentBudget = 1_000;
const extractedDomainModuleBudget = 350;
const defaultApiRouteBudget = 500;

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

const files = [
  ...rootSourceFiles,
  ...(await Promise.all(sourceRoots.map(collectFiles))).flat(),
].filter((file) => sourceExtensions.has(path.extname(file)));
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
  } else if (
    file.startsWith("app/api/") &&
    file.endsWith("/route.ts") &&
    !legacyBudget &&
    lineCount > defaultApiRouteBudget
  ) {
    violations.push(
      `${file}: ${lineCount} lines exceeds API route budget ${defaultApiRouteBudget}`
    );
  }

  if (
    (file.startsWith("app/components/player/") ||
      file.startsWith("app/components/playlist/") ||
      file.startsWith("app/components/monitoring/") ||
      file.startsWith("worker/")) &&
    (file.endsWith(".ts") || file.endsWith(".cjs")) &&
    !file.includes(".test.") &&
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

const workerEntry = await readFile(path.join(root, "worker.js"), "utf8");
const dockerfile = await readFile(path.join(root, "Dockerfile"), "utf8");
if (
  /require\(["']\.\/worker\//.test(workerEntry) &&
  !/COPY[^\n]*\/app\/worker\s+\.\/worker/.test(dockerfile)
) {
  violations.push("Dockerfile: worker runtime modules are not copied into the image");
}

if (violations.length > 0) {
  console.error("Architecture quality gate failed:\n" + violations.join("\n"));
  process.exit(1);
}

console.log(`Architecture quality gate passed (${files.length} source modules checked).`);
