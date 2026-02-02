const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH || "/data/gsplayer.sqlite";
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const migrationPath = path.join(__dirname, "..", "migrations", "0001_init.sql");
const sql = fs.readFileSync(migrationPath, "utf8");
sqlite.exec(sql);

// idempotent column additions
function hasColumn(table, column) {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

if (!hasColumn("sync_state", "updated_at")) {
  sqlite.exec("ALTER TABLE sync_state ADD COLUMN updated_at INTEGER");
  sqlite.exec(
    "UPDATE sync_state SET updated_at=(unixepoch() * 1000) WHERE updated_at IS NULL"
  );
}

if (!hasColumn("tracks", "album_name")) {
  sqlite.exec("ALTER TABLE tracks ADD COLUMN album_name TEXT");
}

if (!hasColumn("tracks", "album_image_url")) {
  sqlite.exec("ALTER TABLE tracks ADD COLUMN album_image_url TEXT");
}

if (!hasColumn("tracks", "album_image_blob")) {
  sqlite.exec("ALTER TABLE tracks ADD COLUMN album_image_blob BLOB");
}

if (!hasColumn("tracks", "album_image_mime")) {
  sqlite.exec("ALTER TABLE tracks ADD COLUMN album_image_mime TEXT");
}

console.log("Migrations applied");
