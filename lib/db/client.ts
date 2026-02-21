import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";

const dbPath = process.env.DB_PATH || "/data/gsplayer.sqlite";

let sqliteInstance: Database.Database | null = null;
let dbInstance: ReturnType<typeof drizzle> | null = null;

function ensureSqlite() {
  if (!sqliteInstance) {
    sqliteInstance = new Database(dbPath);
    sqliteInstance.pragma("journal_mode = WAL");
    sqliteInstance.pragma("foreign_keys = ON");
    sqliteInstance.pragma("busy_timeout = 5000");
    sqliteInstance.pragma("synchronous = NORMAL");
  }
  return sqliteInstance;
}

export function getSqlite() {
  return ensureSqlite();
}

export function getDb() {
  if (!dbInstance) {
    dbInstance = drizzle(ensureSqlite(), { schema });
  }
  return dbInstance;
}
