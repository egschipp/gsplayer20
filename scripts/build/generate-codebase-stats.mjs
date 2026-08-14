import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const roots = [
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
const rootFiles = [
  "package.json",
  "next.config.js",
  "tsconfig.json",
  "eslint.config.js",
  "Dockerfile",
  "README.md",
  "proxy.ts",
  "worker.js",
];
const ignoredDirectories = new Set([".git", ".next", "node_modules", "coverage"]);

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory, output) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
      await walk(target, output);
    } else if (entry.isFile()) {
      output.push(target);
    }
  }
}

const files = [];
for (const root of roots) {
  if (await exists(root)) await walk(root, files);
}
for (const file of rootFiles) {
  if (await exists(file)) files.push(file);
}

const fileTypes = new Map();
let totalLines = 0;
let nonEmptyLines = 0;
for (const file of new Set(files)) {
  const content = await readFile(file, "utf8").catch(() => null);
  if (content == null) continue;
  const rows = content ? content.split(/\r?\n/) : [];
  const nonEmpty = rows.filter((row) => row.trim()).length;
  const type = path.extname(file).slice(1).toLowerCase() || path.basename(file);
  const current = fileTypes.get(type) || { type, files: 0, lines: 0, nonEmptyLines: 0 };
  current.files += 1;
  current.lines += rows.length;
  current.nonEmptyLines += nonEmpty;
  fileTypes.set(type, current);
  totalLines += rows.length;
  nonEmptyLines += nonEmpty;
}

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const result = {
  appName: packageJson.name,
  version: packageJson.version,
  scannedAt: new Date().toISOString(),
  scannedRoots: roots,
  totalFiles: files.length,
  totalLines,
  nonEmptyLines,
  fileTypes: [...fileTypes.values()].sort(
    (left, right) => right.files - left.files || right.lines - left.lines
  ),
};
await mkdir("public", { recursive: true });
await writeFile("public/codebase-stats.json", `${JSON.stringify(result)}\n`, "utf8");
