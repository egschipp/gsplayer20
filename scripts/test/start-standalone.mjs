import { cp, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";

await mkdir(".next/standalone/.next", { recursive: true });
await cp("public", ".next/standalone/public", { recursive: true });
await cp(".next/static", ".next/standalone/.next/static", { recursive: true });

const server = spawn(process.execPath, [".next/standalone/server.js"], {
  env: {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    PORT: "3100",
  },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}

server.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
