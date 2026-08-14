"use strict";

const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH;
const maxAgeMs = Number(process.env.WORKER_HEALTH_MAX_AGE_MS || "30000");

if (!dbPath || !Number.isFinite(maxAgeMs) || maxAgeMs < 1) {
  process.exit(1);
}

let db;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const heartbeat = db
    .prepare("SELECT updated_at FROM worker_heartbeat WHERE id = 'worker'")
    .get();
  if (!heartbeat?.updated_at || Date.now() - heartbeat.updated_at > maxAgeMs) {
    process.exitCode = 1;
  }
} catch {
  process.exitCode = 1;
} finally {
  db?.close();
}
