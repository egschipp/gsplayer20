const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH || "/data/gsplayer.sqlite";
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");
sqlite.pragma("synchronous = NORMAL");

const migrationPath = path.join(__dirname, "..", "migrations", "0001_init.sql");
const sql = fs.readFileSync(migrationPath, "utf8");
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )
`);
const applied = new Set(
  sqlite
    .prepare("SELECT id FROM schema_migrations")
    .all()
    .map((row) => row.id)
);

function hasColumn(table, column) {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}

if (!applied.has("0001_init")) {
  sqlite.transaction(() => {
    sqlite.exec(sql);
    sqlite
      .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
      .run("0001_init", Date.now());
  })();
}

if (!applied.has("0002_legacy_columns_and_indexes")) {
  sqlite.transaction(() => {
    // idempotent column additions
    if (!hasColumn("sync_state", "updated_at")) {
      sqlite.exec("ALTER TABLE sync_state ADD COLUMN updated_at INTEGER");
      sqlite.exec(
        "UPDATE sync_state SET updated_at=(unixepoch() * 1000) WHERE updated_at IS NULL"
      );
    }

    if (!hasColumn("tracks", "album_name")) {
      sqlite.exec("ALTER TABLE tracks ADD COLUMN album_name TEXT");
    }

    if (!hasColumn("tracks", "album_release_date")) {
      sqlite.exec("ALTER TABLE tracks ADD COLUMN album_release_date TEXT");
    }

    if (!hasColumn("tracks", "album_release_year")) {
      sqlite.exec("ALTER TABLE tracks ADD COLUMN album_release_year INTEGER");
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

    if (!hasColumn("tracks", "is_local")) {
      sqlite.exec("ALTER TABLE tracks ADD COLUMN is_local INTEGER");
    }

    if (!hasColumn("tracks", "restrictions_reason")) {
      sqlite.exec("ALTER TABLE tracks ADD COLUMN restrictions_reason TEXT");
    }

    if (!hasColumn("tracks", "linked_from_track_id")) {
      sqlite.exec("ALTER TABLE tracks ADD COLUMN linked_from_track_id TEXT");
    }

    if (!hasColumn("artists", "followers_total")) {
      sqlite.exec("ALTER TABLE artists ADD COLUMN followers_total INTEGER");
    }

    if (!hasColumn("artists", "image_url")) {
      sqlite.exec("ALTER TABLE artists ADD COLUMN image_url TEXT");
    }

    if (!hasColumn("playlists", "owner_display_name")) {
      sqlite.exec("ALTER TABLE playlists ADD COLUMN owner_display_name TEXT");
    }

    if (!hasColumn("playlists", "description")) {
      sqlite.exec("ALTER TABLE playlists ADD COLUMN description TEXT");
    }

    if (!hasColumn("playlists", "image_url")) {
      sqlite.exec("ALTER TABLE playlists ADD COLUMN image_url TEXT");
    }

    if (!hasColumn("jobs", "lease_owner")) {
      sqlite.exec("ALTER TABLE jobs ADD COLUMN lease_owner TEXT");
    }

    if (!hasColumn("jobs", "lease_expires_at")) {
      sqlite.exec("ALTER TABLE jobs ADD COLUMN lease_expires_at INTEGER");
    }

    if (!hasColumn("jobs", "started_at")) {
      sqlite.exec("ALTER TABLE jobs ADD COLUMN started_at INTEGER");
    }

    sqlite.exec(`
  CREATE TABLE IF NOT EXISTS user_recently_played (
    user_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    played_at INTEGER NOT NULL,
    track_id TEXT,
    context_uri TEXT,
    track_name TEXT,
    artist_names TEXT,
    album_image_url TEXT,
    duration_ms INTEGER,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, entry_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES tracks(track_id) ON DELETE SET NULL
  )
`);

    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS playlist_items_track_idx ON playlist_items(track_id)"
    );
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS playlist_items_track_playlist_idx ON playlist_items(track_id, playlist_id)"
    );
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS playlist_items_playlist_track_idx ON playlist_items(playlist_id, track_id)"
    );
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS user_playlists_user_seen_idx ON user_playlists(user_id, last_seen_at, playlist_id)"
    );
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS user_recently_played_user_played_idx ON user_recently_played(user_id, played_at)"
    );
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS user_recently_played_track_idx ON user_recently_played(track_id)"
    );
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS jobs_status_lease_exp_idx ON jobs(status, lease_expires_at)"
    );

    sqlite.exec(`
  CREATE TABLE IF NOT EXISTS token_refresh_locks (
    user_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )
`);
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS token_refresh_locks_expires_idx ON token_refresh_locks(expires_at)"
    );

    sqlite
      .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
      .run("0002_legacy_columns_and_indexes", Date.now());
  })();
}

if (!applied.has("0003_refresh_token_expiry")) {
  sqlite.transaction(() => {
    if (!hasColumn("oauth_tokens", "refresh_expires_at")) {
      sqlite.exec("ALTER TABLE oauth_tokens ADD COLUMN refresh_expires_at INTEGER");
    }
    sqlite
      .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
      .run("0003_refresh_token_expiry", Date.now());
  })();
}

console.log("Migrations applied");
