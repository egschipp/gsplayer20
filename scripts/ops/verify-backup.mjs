import Database from "better-sqlite3";
import path from "node:path";

const backupPath = process.argv[2];
if (!backupPath || path.extname(backupPath) !== ".sqlite") {
  throw new Error("Usage: node scripts/ops/verify-backup.mjs /path/to/backup.sqlite");
}

const database = new Database(path.resolve(backupPath), { readonly: true });
try {
  const result = database.pragma("integrity_check", { simple: true });
  if (result !== "ok") throw new Error(`Backup integrity check failed: ${result}`);
  const migrations = database
    .prepare("SELECT id, applied_at FROM schema_migrations ORDER BY applied_at")
    .all();
  process.stdout.write(`${JSON.stringify({ status: "ok", migrations })}\n`);
} finally {
  database.close();
}
