import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(".test-dist");
const suite = process.argv[2] || "all";
const coverage = process.argv.includes("--coverage");

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? collect(absolute) : [absolute];
    })
  );
  return nested.flat();
}

const files = (await collect(root))
  .filter((file) => file.endsWith(".test.js"))
  .filter((file) => {
    const integration = file.endsWith(".integration.test.js");
    return suite === "all" || (suite === "integration" ? integration : !integration);
  })
  .sort();

if (files.length === 0) {
  throw new Error(`No compiled tests found for suite: ${suite}`);
}

const args = [
  "--test",
  ...(coverage
    ? [
        "--experimental-test-coverage",
        "--test-coverage-lines=85",
        "--test-coverage-branches=70",
        "--test-coverage-functions=85",
      ]
    : []),
  ...files,
];
const child = spawn(process.execPath, args, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
