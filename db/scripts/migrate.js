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

console.log("Migrations applied");
