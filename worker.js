const Database = require("better-sqlite3");
const crypto = require("crypto");

const DB_PATH = process.env.DB_PATH || "/data/gsplayer.sqlite";
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY;
const FETCH_TIMEOUT_MS = Number(process.env.SPOTIFY_FETCH_TIMEOUT_MS || "15000");
const MAX_CONCURRENCY = Number(process.env.SPOTIFY_MAX_CONCURRENCY || "3");
const MAX_RETRY_DELAY_MS = 60_000;
const SCHEDULE_INTERVAL_MS = Number(
  process.env.SYNC_SCHEDULE_MS || "600000"
);

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  console.error("Missing SPOTIFY_CLIENT_ID/SECRET");
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

let inFlight = 0;
const queue = [];

async function withLimiter(fn) {
  if (inFlight >= MAX_CONCURRENCY) {
    await new Promise((resolve) => queue.push(resolve));
  }
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
    const next = queue.shift();
    if (next) next();
  }
}

function hasColumn(table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

db.exec(
  "CREATE TABLE IF NOT EXISTS worker_heartbeat (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))"
);

if (!hasColumn("sync_state", "updated_at")) {
  db.exec("ALTER TABLE sync_state ADD COLUMN updated_at INTEGER");
  db.exec(
    "UPDATE sync_state SET updated_at=(unixepoch() * 1000) WHERE updated_at IS NULL"
  );
}

function sanitizeErrorMessage(message) {
  return String(message)
    .replace(/Bearer\\s+[^\\s]+/g, "Bearer [redacted]")
    .slice(0, 500);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && error.name === "AbortError") {
      const err = new Error("Timeout");
      err.retryable = true;
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function decryptToken(payload) {
  if (!TOKEN_ENCRYPTION_KEY) {
    throw new Error("Missing TOKEN_ENCRYPTION_KEY");
  }
  const key = Buffer.from(TOKEN_ENCRYPTION_KEY, "base64");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  }
  const data = Buffer.from(payload, "base64");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

function encryptToken(value) {
  if (!TOKEN_ENCRYPTION_KEY) {
    throw new Error("Missing TOKEN_ENCRYPTION_KEY");
  }
  const key = Buffer.from(TOKEN_ENCRYPTION_KEY, "base64");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

async function refreshAccessToken(refreshToken) {
  const auth = Buffer.from(
    `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  const res = await withLimiter(() =>
    fetchWithTimeout("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    })
  );

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") || "5");
    const error = new Error("RATE_LIMIT");
    error.retryAfterMs = retryAfter * 1000;
    throw error;
  }

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`RefreshFailed:${res.status}:${text}`);
    if (res.status >= 500) err.retryable = true;
    throw err;
  }

  return res.json();
}

async function spotifyGet(accessToken, url) {
  const res = await withLimiter(() =>
    fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  );

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") || "5");
    const error = new Error("RATE_LIMIT");
    error.retryAfterMs = retryAfter * 1000;
    throw error;
  }

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`SpotifyError:${res.status}:${text}`);
    if (res.status >= 500) err.retryable = true;
    throw err;
  }

  return res.json();
}

let appTokenCache = null;

async function getAppAccessToken() {
  if (appTokenCache && Date.now() < appTokenCache.expiresAt - 60_000) {
    return appTokenCache.accessToken;
  }
  const auth = Buffer.from(
    `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");
  const res = await withLimiter(() =>
    fetchWithTimeout("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    })
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AppTokenFailed:${res.status}:${text}`);
  }
  const json = await res.json();
  appTokenCache = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return appTokenCache.accessToken;
}

async function downloadImage(url) {
  const res = await withLimiter(() =>
    fetchWithTimeout(url, {}, FETCH_TIMEOUT_MS)
  );
  if (!res.ok) {
    const err = new Error(`ImageFetch:${res.status}`);
    if (res.status >= 500) err.retryable = true;
    throw err;
  }
  const mime = res.headers.get("content-type") || "image/jpeg";
  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mime };
}

const statements = {
  takeJob: db.prepare(
    `UPDATE jobs
     SET status='running', attempts=attempts+1, updated_at=?
     WHERE id = (
       SELECT id FROM jobs
       WHERE status='queued' AND run_after <= ?
       ORDER BY created_at ASC
       LIMIT 1
     )
     RETURNING *`
  ),
  markJobDone: db.prepare(
    `UPDATE jobs SET status='done', updated_at=? WHERE id=?`
  ),
  markJobError: db.prepare(
    `UPDATE jobs SET status='error', updated_at=?, payload=? WHERE id=?`
  ),
  requeueJob: db.prepare(
    `UPDATE jobs SET status='queued', run_after=?, updated_at=? WHERE id=?`
  ),
  getRefreshToken: db.prepare(
    `SELECT refresh_token_enc FROM oauth_tokens WHERE user_id=?`
  ),
  updateRefreshToken: db.prepare(
    `UPDATE oauth_tokens SET refresh_token_enc=?, updated_at=? WHERE user_id=?`
  ),
  upsertTrack: db.prepare(
    `INSERT INTO tracks (track_id, name, duration_ms, explicit, album_id, album_name, album_image_url, popularity, updated_at)
     VALUES (@track_id, @name, @duration_ms, @explicit, @album_id, @album_name, @album_image_url, @popularity, @updated_at)
     ON CONFLICT(track_id) DO UPDATE SET
       name=excluded.name,
       duration_ms=excluded.duration_ms,
       explicit=excluded.explicit,
       album_id=excluded.album_id,
       album_name=excluded.album_name,
       album_image_url=excluded.album_image_url,
       popularity=excluded.popularity,
       updated_at=excluded.updated_at`
  ),
  getTrackImage: db.prepare(
    `SELECT album_image_blob FROM tracks WHERE track_id=?`
  ),
  updateTrackImage: db.prepare(
    `UPDATE tracks SET album_image_blob=?, album_image_mime=?, updated_at=? WHERE track_id=?`
  ),
  getTracksMissingCover: db.prepare(
    `SELECT track_id, album_image_url
     FROM tracks
     WHERE album_image_url IS NOT NULL
       AND album_image_blob IS NULL
       AND track_id > ?
     ORDER BY track_id ASC
     LIMIT ?`
  ),
  getTracksMissingMeta: db.prepare(
    `SELECT track_id
     FROM tracks
     WHERE (album_name IS NULL OR album_image_url IS NULL)
       AND track_id > ?
     ORDER BY track_id ASC
     LIMIT ?`
  ),
  updateTrackMeta: db.prepare(
    `UPDATE tracks
     SET album_id=?, album_name=?, album_image_url=?, updated_at=?
     WHERE track_id=?`
  ),
  getUsers: db.prepare(`SELECT id FROM users`),
  countJobsByType: db.prepare(
    `SELECT count(*) as c FROM jobs WHERE type=? AND status IN ('queued','running')`
  ),
  countCoverJobs: db.prepare(
    `SELECT count(*) as c FROM jobs WHERE type='SYNC_COVERS' AND status IN ('queued','running')`
  ),
  upsertArtist: db.prepare(
    `INSERT INTO artists (artist_id, name, genres, popularity, updated_at)
     VALUES (@artist_id, @name, @genres, @popularity, @updated_at)
     ON CONFLICT(artist_id) DO UPDATE SET
       name=excluded.name,
       genres=excluded.genres,
       popularity=excluded.popularity,
       updated_at=excluded.updated_at`
  ),
  upsertTrackArtist: db.prepare(
    `INSERT OR IGNORE INTO track_artists (track_id, artist_id)
     VALUES (?, ?)`
  ),
  upsertUserSavedTrack: db.prepare(
    `INSERT INTO user_saved_tracks (user_id, track_id, added_at, last_seen_at)
     VALUES (@user_id, @track_id, @added_at, @last_seen_at)
     ON CONFLICT(user_id, track_id) DO UPDATE SET
       added_at=excluded.added_at,
       last_seen_at=excluded.last_seen_at`
  ),
  getMaxAddedAt: db.prepare(
    `SELECT added_at FROM user_saved_tracks WHERE user_id=? ORDER BY added_at DESC LIMIT 1`
  ),
  upsertPlaylist: db.prepare(
    `INSERT INTO playlists (playlist_id, name, owner_spotify_user_id, is_public, collaborative, snapshot_id, tracks_total, updated_at)
     VALUES (@playlist_id, @name, @owner_spotify_user_id, @is_public, @collaborative, @snapshot_id, @tracks_total, @updated_at)
     ON CONFLICT(playlist_id) DO UPDATE SET
       name=excluded.name,
       owner_spotify_user_id=excluded.owner_spotify_user_id,
       is_public=excluded.is_public,
       collaborative=excluded.collaborative,
       snapshot_id=excluded.snapshot_id,
       tracks_total=excluded.tracks_total,
      updated_at=excluded.updated_at`
  ),
  getPlaylistSnapshot: db.prepare(
    `SELECT snapshot_id FROM playlists WHERE playlist_id=?`
  ),
  upsertUserPlaylist: db.prepare(
    `INSERT INTO user_playlists (user_id, playlist_id, last_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, playlist_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`
  ),
  insertPlaylistItem: db.prepare(
    `INSERT OR REPLACE INTO playlist_items
     (playlist_id, item_id, track_id, added_at, added_by_spotify_user_id, position, snapshot_id_at_sync, sync_run_id)
     VALUES (@playlist_id, @item_id, @track_id, @added_at, @added_by_spotify_user_id, @position, @snapshot_id_at_sync, @sync_run_id)`
  ),
  deletePlaylistItemsNotRun: db.prepare(
    `DELETE FROM playlist_items WHERE playlist_id=? AND sync_run_id != ?`
  ),
  enqueueJob: db.prepare(
    `INSERT INTO jobs (id, user_id, type, payload, run_after, status, attempts, created_at, updated_at)
     VALUES (@id, @user_id, @type, @payload, @run_after, @status, 0, @created_at, @updated_at)`
  ),
  upsertSyncState: db.prepare(
    `INSERT INTO sync_state (user_id, resource, status, cursor_offset, cursor_limit, last_successful_at, retry_after_at, failure_count, last_error_code, updated_at)
     VALUES (@user_id, @resource, @status, @cursor_offset, @cursor_limit, @last_successful_at, @retry_after_at, @failure_count, @last_error_code, @updated_at)
     ON CONFLICT(user_id, resource) DO UPDATE SET
       status=excluded.status,
       cursor_offset=excluded.cursor_offset,
       cursor_limit=excluded.cursor_limit,
       last_successful_at=excluded.last_successful_at,
       retry_after_at=excluded.retry_after_at,
       failure_count=excluded.failure_count,
       last_error_code=excluded.last_error_code,
       updated_at=excluded.updated_at`
  ),
  upsertHeartbeat: db.prepare(
    `INSERT INTO worker_heartbeat (id, updated_at)
     VALUES ('worker', ?)
     ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`
  ),
  setSyncError: db.prepare(
    `UPDATE sync_state
     SET status='error',
         last_error_code=?,
         failure_count=failure_count+1,
         updated_at=?
     WHERE user_id=? AND resource=?`
  ),
  setSyncBackoff: db.prepare(
    `UPDATE sync_state
     SET status='backoff',
         retry_after_at=?,
         failure_count=failure_count+1,
         last_error_code=?,
         updated_at=?
     WHERE user_id=? AND resource=?`
  ),
};

const writeTracksPage = db.transaction((items, userId, now) => {
  for (const item of items) {
    if (!item.track) continue;
    const track = item.track;
    statements.upsertTrack.run({
      track_id: track.id,
      name: track.name,
      duration_ms: track.duration_ms,
      explicit: track.explicit ? 1 : 0,
      album_id: track.album?.id || null,
      album_name: track.album?.name || null,
      album_image_url:
        track.album?.images?.[track.album?.images?.length - 1]?.url || null,
      popularity: track.popularity ?? null,
      updated_at: now,
    });

    for (const artist of track.artists || []) {
      if (!artist?.id) continue;
      const artistName = artist.name || "Unknown Artist";
      statements.upsertArtist.run({
        artist_id: artist.id,
        name: artistName,
        genres: null,
        popularity: null,
        updated_at: now,
      });
      statements.upsertTrackArtist.run(track.id, artist.id);
    }

    const addedAt = item.added_at ? Date.parse(item.added_at) : now;
    statements.upsertUserSavedTrack.run({
      user_id: userId,
      track_id: track.id,
      added_at: addedAt,
      last_seen_at: now,
    });
  }
});

async function backfillTrackImages(items) {
  for (const item of items) {
    if (!item.track) continue;
    const track = item.track;
    const imageUrl =
      track.album?.images?.[track.album?.images?.length - 1]?.url || null;
    if (!track.id || !imageUrl) continue;
    const existing = statements.getTrackImage.get(track.id);
    if (existing?.album_image_blob) continue;
    try {
      const { buffer, mime } = await downloadImage(imageUrl);
      statements.updateTrackImage.run(buffer, mime, Date.now(), track.id);
    } catch {
      // skip image failures; sync should proceed
    }
  }
}

const writePlaylistItemsPage = db.transaction(
  (items, playlistId, snapshotId, runId, offset, now) => {
    let idx = 0;
    for (const item of items) {
      const track = item.track;
      const trackId = track ? track.id : null;
      if (track) {
        statements.upsertTrack.run({
          track_id: track.id,
          name: track.name,
          duration_ms: track.duration_ms,
          explicit: track.explicit ? 1 : 0,
          album_id: track.album?.id || null,
          album_name: track.album?.name || null,
          album_image_url:
            track.album?.images?.[track.album?.images?.length - 1]?.url || null,
          popularity: track.popularity ?? null,
          updated_at: now,
        });

        for (const artist of track.artists || []) {
          if (!artist?.id) continue;
          const artistName = artist.name || "Unknown Artist";
          statements.upsertArtist.run({
            artist_id: artist.id,
            name: artistName,
            genres: null,
            popularity: null,
            updated_at: now,
          });
          statements.upsertTrackArtist.run(track.id, artist.id);
        }
      }

      const addedAt = item.added_at ? Date.parse(item.added_at) : null;
      const addedBy = item.added_by?.id || null;
      const itemId = crypto
        .createHash("sha1")
        .update(
          `${playlistId}:${trackId || "null"}:${addedAt || 0}:${addedBy || ""}:${offset + idx}:${snapshotId || ""}`
        )
        .digest("hex");

      statements.insertPlaylistItem.run({
        playlist_id: playlistId,
        item_id: itemId,
        track_id: trackId,
        added_at: addedAt,
        added_by_spotify_user_id: addedBy,
        position: offset + idx,
        snapshot_id_at_sync: snapshotId,
        sync_run_id: runId,
      });

      idx += 1;
    }
  }
);

const writePlaylistsPage = db.transaction((items, userId, now) => {
  for (const item of items) {
    const existing = statements.getPlaylistSnapshot.get(item.id);
    statements.upsertPlaylist.run({
      playlist_id: item.id,
      name: item.name,
      owner_spotify_user_id: item.owner?.id || "",
      is_public: item.public === null ? null : item.public ? 1 : 0,
      collaborative: item.collaborative ? 1 : 0,
      snapshot_id: item.snapshot_id || null,
      tracks_total: item.tracks?.total ?? null,
      updated_at: now,
    });
    statements.upsertUserPlaylist.run(userId, item.id, now);

    if (!existing || existing.snapshot_id !== item.snapshot_id) {
      const payload = JSON.stringify({
        playlistId: item.id,
        snapshotId: item.snapshot_id || null,
        offset: 0,
        limit: 50,
        maxPagesPerRun: Number(process.env.SYNC_PLAYLIST_ITEMS_PAGES || "5"),
        runId: crypto.randomUUID(),
      });
      statements.enqueueJob.run({
        id: crypto.randomUUID(),
        user_id: userId,
        type: "SYNC_PLAYLIST_ITEMS",
        payload,
        run_after: Date.now(),
        status: "queued",
        created_at: Date.now(),
        updated_at: Date.now(),
      });
    }
  }
});

async function getAccessTokenForUser(userId) {
  const row = statements.getRefreshToken.get(userId);
  if (!row) throw new Error("NoRefreshToken");
  const refreshToken = decryptToken(row.refresh_token_enc);
  const tokens = await refreshAccessToken(refreshToken);
  if (tokens.refresh_token) {
    const encrypted = encryptToken(tokens.refresh_token);
    statements.updateRefreshToken.run(encrypted, Date.now(), userId);
  }
  return tokens.access_token;
}

async function syncTracksInitial(job) {
  const payload = job.payload ? JSON.parse(job.payload) : {};
  const offset = payload.offset || 0;
  const limit = payload.limit || 50;
  const maxPagesPerRun =
    payload.maxPagesPerRun ||
    Number(process.env.SYNC_TRACKS_INITIAL_PAGES || "50");

  const accessToken = await getAccessTokenForUser(job.user_id);

  let currentOffset = offset;
  let pages = 0;
  while (pages < maxPagesPerRun) {
    const url = `https://api.spotify.com/v1/me/tracks?limit=${limit}&offset=${currentOffset}`;
    const data = await spotifyGet(accessToken, url);
    const items = data.items || [];

    if (items.length === 0) {
      statements.upsertSyncState.run({
        user_id: job.user_id,
        resource: "tracks",
        status: "idle",
        cursor_offset: currentOffset,
        cursor_limit: limit,
        last_successful_at: Date.now(),
        retry_after_at: null,
        failure_count: 0,
        last_error_code: null,
        updated_at: Date.now(),
      });
      return { done: true };
    }

    const now = Date.now();
    writeTracksPage(items, job.user_id, now);
    await backfillTrackImages(items);

    currentOffset += items.length;
    pages += 1;

    statements.upsertSyncState.run({
      user_id: job.user_id,
      resource: "tracks",
      status: "running",
      cursor_offset: currentOffset,
      cursor_limit: limit,
      last_successful_at: Date.now(),
      retry_after_at: null,
      failure_count: 0,
      last_error_code: null,
      updated_at: Date.now(),
    });
  }

  return { done: false, nextOffset: currentOffset };
}

async function syncTracksIncremental(job) {
  const payload = job.payload ? JSON.parse(job.payload) : {};
  const limit = payload.limit || 50;
  const maxPagesPerRun =
    payload.maxPagesPerRun ||
    Number(process.env.SYNC_TRACKS_INCREMENTAL_PAGES || "5");

  const accessToken = await getAccessTokenForUser(job.user_id);
  const maxAddedRow = statements.getMaxAddedAt.get(job.user_id);
  const maxAddedAt = maxAddedRow ? maxAddedRow.added_at : 0;

  let offset = 0;
  let pages = 0;
  let overlapPages = 0;

  while (pages < maxPagesPerRun) {
    const url = `https://api.spotify.com/v1/me/tracks?limit=${limit}&offset=${offset}`;
    const data = await spotifyGet(accessToken, url);
    const items = data.items || [];

    if (items.length === 0) {
      statements.upsertSyncState.run({
        user_id: job.user_id,
        resource: "tracks",
        status: "idle",
        cursor_offset: offset,
        cursor_limit: limit,
        last_successful_at: Date.now(),
        retry_after_at: null,
        failure_count: 0,
        last_error_code: null,
        updated_at: Date.now(),
      });
      return { done: true };
    }

    const now = Date.now();
    let pageHasNew = false;
    for (const item of items) {
      const addedAt = item.added_at ? Date.parse(item.added_at) : now;
      if (addedAt > maxAddedAt) pageHasNew = true;
    }

    writeTracksPage(items, job.user_id, now);
    await backfillTrackImages(items);

    statements.upsertSyncState.run({
      user_id: job.user_id,
      resource: "tracks",
      status: "running",
      cursor_offset: offset,
      cursor_limit: limit,
      last_successful_at: Date.now(),
      retry_after_at: null,
      failure_count: 0,
      last_error_code: null,
      updated_at: Date.now(),
    });

    if (!pageHasNew) {
      overlapPages += 1;
    } else {
      overlapPages = 0;
    }

    if (overlapPages >= 1) {
      statements.upsertSyncState.run({
        user_id: job.user_id,
        resource: "tracks",
        status: "idle",
        cursor_offset: offset,
        cursor_limit: limit,
        last_successful_at: Date.now(),
        retry_after_at: null,
        failure_count: 0,
        last_error_code: null,
        updated_at: Date.now(),
      });
      return { done: true };
    }

    offset += items.length;
    pages += 1;
  }

  return { done: false };
}

async function syncPlaylists(job) {
  const payload = job.payload ? JSON.parse(job.payload) : {};
  const limit = payload.limit || 50;
  const maxPagesPerRun =
    payload.maxPagesPerRun ||
    Number(process.env.SYNC_PLAYLISTS_PAGES || "10");
  const offsetStart = payload.offset || 0;

  const accessToken = await getAccessTokenForUser(job.user_id);

  let offset = offsetStart;
  let pages = 0;

  while (pages < maxPagesPerRun) {
    const url = `https://api.spotify.com/v1/me/playlists?limit=${limit}&offset=${offset}`;
    const data = await spotifyGet(accessToken, url);
    const items = data.items || [];

    if (items.length === 0) {
      statements.upsertSyncState.run({
        user_id: job.user_id,
        resource: "playlists",
        status: "idle",
        cursor_offset: offset,
        cursor_limit: limit,
        last_successful_at: Date.now(),
        retry_after_at: null,
        failure_count: 0,
        last_error_code: null,
        updated_at: Date.now(),
      });
      return { done: true };
    }

    const now = Date.now();
    writePlaylistsPage(items, job.user_id, now);

    offset += items.length;
    pages += 1;

    statements.upsertSyncState.run({
      user_id: job.user_id,
      resource: "playlists",
      status: "running",
      cursor_offset: offset,
      cursor_limit: limit,
      last_successful_at: Date.now(),
      retry_after_at: null,
      failure_count: 0,
      last_error_code: null,
      updated_at: Date.now(),
    });
  }

  return { done: false, nextOffset: offset };
}

async function syncPlaylistItems(job) {
  const payload = job.payload ? JSON.parse(job.payload) : {};
  const playlistId = payload.playlistId;
  const snapshotId = payload.snapshotId || null;
  const limit = payload.limit || 50;
  const offsetStart = payload.offset || 0;
  const maxPagesPerRun =
    payload.maxPagesPerRun ||
    Number(process.env.SYNC_PLAYLIST_ITEMS_PAGES || "5");
  const runId = payload.runId || crypto.randomUUID();

  if (!playlistId) {
    throw new Error("MissingPlaylistId");
  }

  const accessToken = await getAccessTokenForUser(job.user_id);

  let offset = offsetStart;
  let pages = 0;

  while (pages < maxPagesPerRun) {
    const url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=${limit}&offset=${offset}`;
    const data = await spotifyGet(accessToken, url);
    const items = data.items || [];

    if (items.length === 0) {
      statements.upsertSyncState.run({
        user_id: job.user_id,
        resource: `playlist_items:${playlistId}`,
        status: "idle",
        cursor_offset: offset,
        cursor_limit: limit,
        last_successful_at: Date.now(),
        retry_after_at: null,
        failure_count: 0,
        last_error_code: null,
        updated_at: Date.now(),
      });
      statements.deletePlaylistItemsNotRun.run(playlistId, runId);
      return { done: true };
    }

    const now = Date.now();
    writePlaylistItemsPage(items, playlistId, snapshotId, runId, offset, now);
    await backfillTrackImages(items);

    offset += items.length;
    pages += 1;

    statements.upsertSyncState.run({
      user_id: job.user_id,
      resource: `playlist_items:${playlistId}`,
      status: "running",
      cursor_offset: offset,
      cursor_limit: limit,
      last_successful_at: Date.now(),
      retry_after_at: null,
      failure_count: 0,
      last_error_code: null,
      updated_at: Date.now(),
    });
  }

  return { done: false, nextOffset: offset, runId, playlistId, snapshotId };
}

async function syncTrackMetadata(job) {
  const payload = job.payload ? JSON.parse(job.payload) : {};
  const limit = payload.limit || 50;
  const cursor = payload.cursor || "";
  const maxBatches =
    payload.maxBatches || Number(process.env.SYNC_TRACK_METADATA_BATCHES || "20");

  let batches = 0;
  let lastId = cursor;
  const accessToken = await getAppAccessToken();

  while (batches < maxBatches) {
    const rows = statements.getTracksMissingMeta.all(lastId, limit);
    if (!rows.length) {
      statements.upsertSyncState.run({
        user_id: job.user_id,
        resource: "track_metadata",
        status: "idle",
        cursor_offset: null,
        cursor_limit: limit,
        last_successful_at: Date.now(),
        retry_after_at: null,
        failure_count: 0,
        last_error_code: null,
        updated_at: Date.now(),
      });
      return { done: true };
    }

    const ids = rows.map((r) => r.track_id).filter(Boolean);
    const url = `https://api.spotify.com/v1/tracks?ids=${ids.join(",")}`;
    const data = await spotifyGet(accessToken, url);
    const now = Date.now();

    for (const track of data.tracks || []) {
      if (!track?.id) continue;
      const imageUrl =
        track.album?.images?.[track.album?.images?.length - 1]?.url || null;
      statements.updateTrackMeta.run(
        track.album?.id || null,
        track.album?.name || null,
        imageUrl,
        now,
        track.id
      );
      lastId = track.id;
    }

    batches += 1;

    statements.upsertSyncState.run({
      user_id: job.user_id,
      resource: "track_metadata",
      status: "running",
      cursor_offset: null,
      cursor_limit: limit,
      last_successful_at: Date.now(),
      retry_after_at: null,
      failure_count: 0,
      last_error_code: null,
      updated_at: Date.now(),
    });
  }

  return { done: false, nextCursor: lastId };
}

async function syncCovers(job) {
  const payload = job.payload ? JSON.parse(job.payload) : {};
  const limit = payload.limit || 50;
  const cursor = payload.cursor || "";
  const maxBatches =
    payload.maxBatches || Number(process.env.SYNC_COVERS_BATCHES || "20");

  let batches = 0;
  let lastId = cursor;

  while (batches < maxBatches) {
    const rows = statements.getTracksMissingCover.all(lastId, limit);
    if (!rows.length) {
      statements.upsertSyncState.run({
        user_id: job.user_id,
        resource: "covers",
        status: "idle",
        cursor_offset: null,
        cursor_limit: limit,
        last_successful_at: Date.now(),
        retry_after_at: null,
        failure_count: 0,
        last_error_code: null,
        updated_at: Date.now(),
      });
      return { done: true };
    }

    for (const row of rows) {
      if (!row.album_image_url) continue;
      try {
        const { buffer, mime } = await downloadImage(row.album_image_url);
        statements.updateTrackImage.run(buffer, mime, Date.now(), row.track_id);
      } catch {
        // skip; keep for later retry
      }
      lastId = row.track_id;
    }

    batches += 1;

    statements.upsertSyncState.run({
      user_id: job.user_id,
      resource: "covers",
      status: "running",
      cursor_offset: null,
      cursor_limit: limit,
      last_successful_at: Date.now(),
      retry_after_at: null,
      failure_count: 0,
      last_error_code: null,
      updated_at: Date.now(),
    });
  }

  return { done: false, nextCursor: lastId };
}

function enqueueCoversIfMissing(userId) {
  const existing = statements.countCoverJobs.get();
  if (existing && existing.c > 0) return;
  statements.enqueueJob.run({
    id: crypto.randomUUID(),
    user_id: userId,
    type: "SYNC_TRACK_METADATA",
    payload: JSON.stringify({ limit: 50, maxBatches: 30, cursor: "" }),
    run_after: Date.now() + 1000,
    status: "queued",
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  statements.enqueueJob.run({
    id: crypto.randomUUID(),
    user_id: userId,
    type: "SYNC_COVERS",
    payload: JSON.stringify({ limit: 50, maxBatches: 30, cursor: "" }),
    run_after: Date.now() + 2000,
    status: "queued",
    created_at: Date.now(),
    updated_at: Date.now(),
  });
}

let lastScheduledAt = 0;

function schedulePeriodicSync() {
  const now = Date.now();
  if (now - lastScheduledAt < SCHEDULE_INTERVAL_MS) return;
  lastScheduledAt = now;

  const users = statements.getUsers.all();
  for (const user of users) {
    const tracksJobs = statements.countJobsByType.get("SYNC_TRACKS_INCREMENTAL");
    if (!tracksJobs || tracksJobs.c === 0) {
      statements.enqueueJob.run({
        id: crypto.randomUUID(),
        user_id: user.id,
        type: "SYNC_TRACKS_INCREMENTAL",
        payload: JSON.stringify({ limit: 50, maxPagesPerRun: 5 }),
        run_after: Date.now(),
        status: "queued",
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      statements.upsertSyncState.run({
        user_id: user.id,
        resource: "tracks",
        status: "queued",
        cursor_offset: null,
        cursor_limit: null,
        last_successful_at: null,
        retry_after_at: null,
        failure_count: 0,
        last_error_code: null,
        updated_at: Date.now(),
      });
    }

    const playlistJobs = statements.countJobsByType.get("SYNC_PLAYLISTS");
    if (!playlistJobs || playlistJobs.c === 0) {
      statements.enqueueJob.run({
        id: crypto.randomUUID(),
        user_id: user.id,
        type: "SYNC_PLAYLISTS",
        payload: JSON.stringify({ limit: 50, maxPagesPerRun: 10 }),
        run_after: Date.now(),
        status: "queued",
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      statements.upsertSyncState.run({
        user_id: user.id,
        resource: "playlists",
        status: "queued",
        cursor_offset: null,
        cursor_limit: null,
        last_successful_at: null,
        retry_after_at: null,
        failure_count: 0,
        last_error_code: null,
        updated_at: Date.now(),
      });
    }
  }
}

async function handleJob(job) {
  if (job.type === "SYNC_TRACKS_INITIAL") {
    return syncTracksInitial(job);
  }
  if (job.type === "SYNC_TRACKS_INCREMENTAL") {
    return syncTracksIncremental(job);
  }
  if (job.type === "SYNC_PLAYLISTS") {
    return syncPlaylists(job);
  }
  if (job.type === "SYNC_PLAYLIST_ITEMS") {
    return syncPlaylistItems(job);
  }
  if (job.type === "SYNC_TRACK_METADATA") {
    return syncTrackMetadata(job);
  }
  if (job.type === "SYNC_COVERS") {
    return syncCovers(job);
  }
  throw new Error(`UnknownJob:${job.type}`);
}

function getResourceForJob(job) {
  if (job.type === "SYNC_TRACKS_INITIAL" || job.type === "SYNC_TRACKS_INCREMENTAL") {
    return "tracks";
  }
  if (job.type === "SYNC_PLAYLISTS") {
    return "playlists";
  }
  if (job.type === "SYNC_PLAYLIST_ITEMS") {
    try {
      const payload = job.payload ? JSON.parse(job.payload) : {};
      if (payload.playlistId) {
        return `playlist_items:${payload.playlistId}`;
      }
    } catch {}
    return "playlist_items";
  }
  if (job.type === "SYNC_TRACK_METADATA") {
    return "track_metadata";
  }
  if (job.type === "SYNC_COVERS") {
    return "covers";
  }
  return "unknown";
}

async function runLoop() {
  let lastHeartbeatAt = 0;
  while (true) {
    const now = Date.now();
    if (now - lastHeartbeatAt > 10000) {
      statements.upsertHeartbeat.run(now);
      lastHeartbeatAt = now;
    }
    schedulePeriodicSync();
    const job = statements.takeJob.get(now, now);

    if (!job) {
      await sleep(2000);
      continue;
    }

    try {
      const resource = getResourceForJob(job);
      if (resource !== "unknown") {
        statements.upsertSyncState.run({
          user_id: job.user_id,
          resource,
          status: "running",
          cursor_offset: null,
          cursor_limit: null,
          last_successful_at: null,
          retry_after_at: null,
          failure_count: 0,
          last_error_code: null,
          updated_at: Date.now(),
        });
      }
      const result = await handleJob(job);
      if (result && result.done === false) {
        const nextPayload = Object.assign(
          {},
          job.payload ? JSON.parse(job.payload) : {},
          result.nextOffset !== undefined ? { offset: result.nextOffset } : {},
          result.nextCursor !== undefined ? { cursor: result.nextCursor } : {}
        );
        statements.requeueJob.run(
          Date.now() + 2000,
          Date.now(),
          job.id
        );
        db.prepare("UPDATE jobs SET payload=? WHERE id=?").run(
          JSON.stringify(nextPayload),
          job.id
        );
      } else {
        statements.markJobDone.run(Date.now(), job.id);
        if (job.type === "SYNC_PLAYLISTS" || job.type === "SYNC_PLAYLIST_ITEMS") {
          enqueueCoversIfMissing(job.user_id);
        }
      }
    } catch (error) {
      const resource = getResourceForJob(job);
      if (error && error.retryAfterMs) {
        const jitter = Math.floor(Math.random() * 2000);
        const retryAt = Date.now() + error.retryAfterMs + jitter;
        statements.requeueJob.run(retryAt, Date.now(), job.id);
        if (resource !== "unknown") {
          statements.setSyncBackoff.run(
            retryAt,
            "RATE_LIMIT",
            Date.now(),
            job.user_id,
            resource
          );
        }
      } else if (error && error.retryable) {
        const attempt = Math.max(1, Number(job.attempts || 1));
        const backoff = Math.min(
          MAX_RETRY_DELAY_MS,
          1000 * Math.pow(2, Math.min(attempt, 6))
        );
        const jitter = Math.floor(Math.random() * 1000);
        const retryAt = Date.now() + backoff + jitter;
        statements.requeueJob.run(retryAt, Date.now(), job.id);
        if (resource !== "unknown") {
          statements.setSyncBackoff.run(
            retryAt,
            "RETRYABLE_ERROR",
            Date.now(),
            job.user_id,
            resource
          );
        }
      } else {
        const message = sanitizeErrorMessage(error);
        statements.markJobError.run(
          Date.now(),
          JSON.stringify({ error: message }),
          job.id
        );
        if (resource !== "unknown") {
          statements.setSyncError.run(
            message.slice(0, 2000),
            Date.now(),
            job.user_id,
            resource
          );
        }
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

runLoop().catch((err) => {
  console.error(err);
  process.exit(1);
});
