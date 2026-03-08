import { execSync } from "node:child_process";
import fs from "node:fs";

if (!fs.existsSync(".git")) {
  process.exit(0);
}

execSync("git config core.hooksPath .githooks", { stdio: "inherit" });
execSync("git config pull.rebase true", { stdio: "inherit" });
execSync("git config rebase.autoStash true", { stdio: "inherit" });
execSync("git config fetch.prune true", { stdio: "inherit" });
