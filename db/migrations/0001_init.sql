CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  spotify_user_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  user_id TEXT PRIMARY KEY,
  refresh_token_enc TEXT NOT NULL,
  access_token TEXT,
  access_expires_at INTEGER,
  scope TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  enc_key_version INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tracks (
  track_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  explicit INTEGER NOT NULL,
  album_id TEXT,
  album_name TEXT,
  album_image_url TEXT,
  album_image_blob BLOB,
  album_image_mime TEXT,
  popularity INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS artists (
  artist_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  genres TEXT,
  popularity INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS track_artists (
  track_id TEXT NOT NULL,
  artist_id TEXT NOT NULL,
  PRIMARY KEY (track_id, artist_id),
  FOREIGN KEY (track_id) REFERENCES tracks(track_id) ON DELETE CASCADE,
  FOREIGN KEY (artist_id) REFERENCES artists(artist_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS track_artists_artist_idx ON track_artists(artist_id);

CREATE TABLE IF NOT EXISTS user_saved_tracks (
  user_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (track_id) REFERENCES tracks(track_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS user_saved_tracks_user_added_idx
  ON user_saved_tracks(user_id, added_at, track_id);

CREATE TABLE IF NOT EXISTS playlists (
  playlist_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_spotify_user_id TEXT NOT NULL,
  is_public INTEGER,
  collaborative INTEGER,
  snapshot_id TEXT,
  tracks_total INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS user_playlists (
  user_id TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, playlist_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (playlist_id) REFERENCES playlists(playlist_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS user_playlists_playlist_idx ON user_playlists(playlist_id);

CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  track_id TEXT,
  added_at INTEGER,
  added_by_spotify_user_id TEXT,
  position INTEGER,
  snapshot_id_at_sync TEXT,
  sync_run_id TEXT,
  PRIMARY KEY (playlist_id, item_id),
  FOREIGN KEY (playlist_id) REFERENCES playlists(playlist_id) ON DELETE CASCADE,
  FOREIGN KEY (track_id) REFERENCES tracks(track_id)
);

CREATE INDEX IF NOT EXISTS playlist_items_playlist_pos_idx
  ON playlist_items(playlist_id, position);
CREATE INDEX IF NOT EXISTS playlist_items_playlist_added_idx
  ON playlist_items(playlist_id, added_at);

CREATE TABLE IF NOT EXISTS sync_state (
  user_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  status TEXT NOT NULL,
  cursor_offset INTEGER,
  cursor_limit INTEGER,
  last_successful_at INTEGER,
  retry_after_at INTEGER,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (user_id, resource),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT,
  run_after INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS jobs_status_run_after_idx
  ON jobs(status, run_after);

CREATE TABLE IF NOT EXISTS worker_heartbeat (
  id TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
