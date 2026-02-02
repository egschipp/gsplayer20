import {
  integer,
  sqliteTable,
  text,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const nowMs = sql`(unixepoch() * 1000)`;

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    spotifyUserId: text("spotify_user_id").notNull(),
    createdAt: integer("created_at").notNull().default(nowMs),
    deletedAt: integer("deleted_at"),
  },
  (table) => ({
    spotifyUserIdIdx: uniqueIndex("users_spotify_user_id_idx").on(
      table.spotifyUserId
    ),
  })
);

export const oauthTokens = sqliteTable("oauth_tokens", {
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" })
    .primaryKey(),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  accessToken: text("access_token"),
  accessExpiresAt: integer("access_expires_at"),
  scope: text("scope"),
  updatedAt: integer("updated_at").notNull().default(nowMs),
  encKeyVersion: integer("enc_key_version").notNull().default(1),
});

export const tracks = sqliteTable("tracks", {
  trackId: text("track_id").primaryKey(),
  name: text("name").notNull(),
  durationMs: integer("duration_ms").notNull(),
  explicit: integer("explicit").notNull(),
  albumId: text("album_id"),
  albumName: text("album_name"),
  albumImageUrl: text("album_image_url"),
  popularity: integer("popularity"),
  updatedAt: integer("updated_at").notNull().default(nowMs),
});

export const artists = sqliteTable("artists", {
  artistId: text("artist_id").primaryKey(),
  name: text("name").notNull(),
  genres: text("genres"),
  popularity: integer("popularity"),
  updatedAt: integer("updated_at").notNull().default(nowMs),
});

export const trackArtists = sqliteTable(
  "track_artists",
  {
    trackId: text("track_id")
      .notNull()
      .references(() => tracks.trackId, { onDelete: "cascade" }),
    artistId: text("artist_id")
      .notNull()
      .references(() => artists.artistId, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.trackId, table.artistId] }),
    artistIdx: index("track_artists_artist_idx").on(table.artistId),
  })
);

export const userSavedTracks = sqliteTable(
  "user_saved_tracks",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    trackId: text("track_id")
      .notNull()
      .references(() => tracks.trackId, { onDelete: "cascade" }),
    addedAt: integer("added_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.trackId] }),
    byUserAdded: index("user_saved_tracks_user_added_idx").on(
      table.userId,
      table.addedAt,
      table.trackId
    ),
  })
);

export const playlists = sqliteTable("playlists", {
  playlistId: text("playlist_id").primaryKey(),
  name: text("name").notNull(),
  ownerSpotifyUserId: text("owner_spotify_user_id").notNull(),
  isPublic: integer("is_public"),
  collaborative: integer("collaborative"),
  snapshotId: text("snapshot_id"),
  tracksTotal: integer("tracks_total"),
  updatedAt: integer("updated_at").notNull().default(nowMs),
});

export const userPlaylists = sqliteTable(
  "user_playlists",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlists.playlistId, { onDelete: "cascade" }),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.playlistId] }),
    playlistIdx: index("user_playlists_playlist_idx").on(table.playlistId),
  })
);

export const playlistItems = sqliteTable(
  "playlist_items",
  {
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlists.playlistId, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    trackId: text("track_id").references(() => tracks.trackId),
    addedAt: integer("added_at"),
    addedBySpotifyUserId: text("added_by_spotify_user_id"),
    position: integer("position"),
    snapshotIdAtSync: text("snapshot_id_at_sync"),
    syncRunId: text("sync_run_id"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.playlistId, table.itemId] }),
    playlistPositionIdx: index("playlist_items_playlist_pos_idx").on(
      table.playlistId,
      table.position
    ),
    playlistAddedIdx: index("playlist_items_playlist_added_idx").on(
      table.playlistId,
      table.addedAt
    ),
  })
);

export const syncState = sqliteTable(
  "sync_state",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    status: text("status").notNull(),
    cursorOffset: integer("cursor_offset"),
    cursorLimit: integer("cursor_limit"),
    lastSuccessfulAt: integer("last_successful_at"),
    retryAfterAt: integer("retry_after_at"),
    failureCount: integer("failure_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    updatedAt: integer("updated_at").notNull().default(nowMs),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.resource] }),
  })
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: text("payload"),
    runAfter: integer("run_after").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: integer("created_at").notNull().default(nowMs),
    updatedAt: integer("updated_at").notNull().default(nowMs),
  },
  (table) => ({
    statusRunAfterIdx: index("jobs_status_run_after_idx").on(
      table.status,
      table.runAfter
    ),
  })
);

export const workerHeartbeat = sqliteTable("worker_heartbeat", {
  id: text("id").primaryKey(),
  updatedAt: integer("updated_at").notNull().default(nowMs),
});
