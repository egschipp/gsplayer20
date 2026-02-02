const Database = require("better-sqlite3");
const crypto = require("crypto");

const DB_PATH = process.env.DB_PATH || "/data/gsplayer.sqlite";
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  console.error("Missing SPOTIFY_CLIENT_ID/SECRET");
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

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

async function refreshAccessToken(refreshToken) {
  const auth = Buffer.from(
    `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") || "5");
    const error = new Error("RATE_LIMIT");
    error.retryAfterMs = retryAfter * 1000;
    throw error;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RefreshFailed:${res.status}:${text}`);
  }

  return res.json();
}

async function spotifyGet(accessToken, url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") || "5");
    const error = new Error("RATE_LIMIT");
    error.retryAfterMs = retryAfter * 1000;
    throw error;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SpotifyError:${res.status}:${text}`);
  }

  return res.json();
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
  upsertTrack: db.prepare(
    `INSERT INTO tracks (track_id, name, duration_ms, explicit, album_id, popularity, updated_at)
     VALUES (@track_id, @name, @duration_ms, @explicit, @album_id, @popularity, @updated_at)
     ON CONFLICT(track_id) DO UPDATE SET
       name=excluded.name,
       duration_ms=excluded.duration_ms,
       explicit=excluded.explicit,
       album_id=excluded.album_id,
       popularity=excluded.popularity,
       updated_at=excluded.updated_at`
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
  upsertUserPlaylist: db.prepare(
    `INSERT INTO user_playlists (user_id, playlist_id, last_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, playlist_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`
  ),
  upsertSyncState: db.prepare(
    `INSERT INTO sync_state (user_id, resource, status, cursor_offset, cursor_limit, last_successful_at, retry_after_at, failure_count, last_error_code)
     VALUES (@user_id, @resource, @status, @cursor_offset, @cursor_limit, @last_successful_at, @retry_after_at, @failure_count, @last_error_code)
     ON CONFLICT(user_id, resource) DO UPDATE SET
       status=excluded.status,
       cursor_offset=excluded.cursor_offset,
       cursor_limit=excluded.cursor_limit,
       last_successful_at=excluded.last_successful_at,
       retry_after_at=excluded.retry_after_at,
       failure_count=excluded.failure_count,
       last_error_code=excluded.last_error_code`
  ),
};

async function getAccessTokenForUser(userId) {
  const row = statements.getRefreshToken.get(userId);
  if (!row) throw new Error("NoRefreshToken");
  const refreshToken = decryptToken(row.refresh_token_enc);
  const tokens = await refreshAccessToken(refreshToken);
  return tokens.access_token;
}

async function syncTracksInitial(job) {
  const payload = job.payload ? JSON.parse(job.payload) : {};
  const offset = payload.offset || 0;
  const limit = payload.limit || 50;
  const maxPagesPerRun = payload.maxPagesPerRun || 5;

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
      });
      return { done: true };
    }

    const now = Date.now();
    for (const item of items) {
      if (!item.track) continue;
      const track = item.track;
      statements.upsertTrack.run({
        track_id: track.id,
        name: track.name,
        duration_ms: track.duration_ms,
        explicit: track.explicit ? 1 : 0,
        album_id: track.album?.id || null,
        popularity: track.popularity ?? null,
        updated_at: now,
      });

      for (const artist of track.artists || []) {
        statements.upsertArtist.run({
          artist_id: artist.id,
          name: artist.name,
          genres: null,
          popularity: null,
          updated_at: now,
        });
        statements.upsertTrackArtist.run(track.id, artist.id);
      }

      const addedAt = item.added_at ? Date.parse(item.added_at) : now;
      statements.upsertUserSavedTrack.run({
        user_id: job.user_id,
        track_id: track.id,
        added_at: addedAt,
        last_seen_at: now,
      });
    }

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
    });
  }

  return { done: false, nextOffset: currentOffset };
}

async function syncTracksIncremental(job) {
  const payload = job.payload ? JSON.parse(job.payload) : {};
  const limit = payload.limit || 50;
  const maxPagesPerRun = payload.maxPagesPerRun || 5;

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

    if (items.length === 0) return { done: true };

    const now = Date.now();
    let pageHasNew = false;

    for (const item of items) {
      if (!item.track) continue;
      const track = item.track;
      statements.upsertTrack.run({
        track_id: track.id,
        name: track.name,
        duration_ms: track.duration_ms,
        explicit: track.explicit ? 1 : 0,
        album_id: track.album?.id || null,
        popularity: track.popularity ?? null,
        updated_at: now,
      });

      for (const artist of track.artists || []) {
        statements.upsertArtist.run({
          artist_id: artist.id,
          name: artist.name,
          genres: null,
          popularity: null,
          updated_at: now,
        });
        statements.upsertTrackArtist.run(track.id, artist.id);
      }

      const addedAt = item.added_at ? Date.parse(item.added_at) : now;
      if (addedAt > maxAddedAt) pageHasNew = true;
      statements.upsertUserSavedTrack.run({
        user_id: job.user_id,
        track_id: track.id,
        added_at: addedAt,
        last_seen_at: now,
      });
    }

    if (!pageHasNew) {
      overlapPages += 1;
    } else {
      overlapPages = 0;
    }

    if (overlapPages >= 1) {
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
  const maxPagesPerRun = payload.maxPagesPerRun || 5;
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
      });
      return { done: true };
    }

    const now = Date.now();
    for (const item of items) {
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
      statements.upsertUserPlaylist.run(job.user_id, item.id, now);
    }

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
    });
  }

  return { done: false, nextOffset: offset };
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
  throw new Error(`UnknownJob:${job.type}`);
}

async function runLoop() {
  while (true) {
    const now = Date.now();
    const job = statements.takeJob.get(now, now);

    if (!job) {
      await sleep(2000);
      continue;
    }

    try {
      const result = await handleJob(job);
      if (result && result.done === false) {
        const nextPayload = Object.assign(
          {},
          job.payload ? JSON.parse(job.payload) : {},
          result.nextOffset !== undefined ? { offset: result.nextOffset } : {}
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
      }
    } catch (error) {
      if (error && error.retryAfterMs) {
        const retryAt = Date.now() + error.retryAfterMs;
        statements.requeueJob.run(retryAt, Date.now(), job.id);
      } else {
        statements.markJobError.run(Date.now(), JSON.stringify({
          error: String(error),
        }), job.id);
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
