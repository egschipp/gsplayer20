import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { deleteAccountData } from "../data/delete-account-data";

test("account deletion cascades private data and redacts shared playlist ownership", () => {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(readFileSync("db/migrations/0001_init.sql", "utf8"));
  const now = Date.now();
  sqlite
    .prepare("INSERT INTO users (id, spotify_user_id, created_at) VALUES (?, ?, ?)")
    .run("user-1", "spotify-1", now);
  sqlite
    .prepare("INSERT INTO users (id, spotify_user_id, created_at) VALUES (?, ?, ?)")
    .run("user-2", "spotify-2", now);
  const insertPlaylist = sqlite.prepare(
    `INSERT INTO playlists
      (playlist_id, name, owner_spotify_user_id, owner_display_name, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  insertPlaylist.run("private", "Private", "spotify-1", "Private owner", now);
  insertPlaylist.run("shared", "Shared", "spotify-1", "Shared owner", now);
  const linkPlaylist = sqlite.prepare(
    "INSERT INTO user_playlists (user_id, playlist_id, last_seen_at) VALUES (?, ?, ?)"
  );
  linkPlaylist.run("user-1", "private", now);
  linkPlaylist.run("user-1", "shared", now);
  linkPlaylist.run("user-2", "shared", now);

  assert.equal(deleteAccountData(sqlite, "user-1"), 1);
  const privateCount = sqlite
    .prepare("SELECT count(*) count FROM playlists WHERE playlist_id='private'")
    .get() as { count: number };
  assert.equal(privateCount.count, 0);
  assert.deepEqual(
    sqlite
      .prepare(
        "SELECT owner_spotify_user_id, owner_display_name FROM playlists WHERE playlist_id='shared'"
      )
      .get(),
    { owner_spotify_user_id: "deleted", owner_display_name: null }
  );
  const remainingUserCount = sqlite
    .prepare("SELECT count(*) count FROM users WHERE id='user-2'")
    .get() as { count: number };
  assert.equal(remainingUserCount.count, 1);
  sqlite.close();
});
