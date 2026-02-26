# gsplayer20
Georgies Spotify Player 2.0

## Spotify Auth (server-side)

Required environment variables:
- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REDIRECT_URI` (set in Spotify dashboard)
- `AUTH_SECRET` (or `NEXTAUTH_SECRET`)
- `AUTH_URL` (or `NEXTAUTH_URL`)
- `TOKEN_ENCRYPTION_KEY` (base64 32 bytes)
- `DB_PATH` (e.g. `/data/gsplayer.sqlite`)
Optional tuning:
- `SPOTIFY_FETCH_TIMEOUT_MS` (default 15000)
- `SPOTIFY_GLOBAL_CONCURRENCY` (default 8)
- `SPOTIFY_PER_USER_CONCURRENCY` (default 3)
- `SPOTIFY_PER_USER_BURST` (default 12)
- `SPOTIFY_PER_USER_REFILL_PER_SEC` (default 4)
- `SPOTIFY_QUEUE_MAX_SIZE` (default 500)
- `SPOTIFY_QUEUE_TIMEOUT_MS` (default 12000)
- `SPOTIFY_CIRCUIT_FAILURE_THRESHOLD` (default 6)
- `SPOTIFY_CIRCUIT_OPEN_MS` (default 12000)
- `SPOTIFY_RETRY_AFTER_MAX_MS` (default 120000)
- `SYNC_TRACKS_INITIAL_PAGES` (default 50)
- `SYNC_TRACKS_INCREMENTAL_PAGES` (default 5)
- `SYNC_PLAYLISTS_PAGES` (default 10)
- `SYNC_PLAYLIST_ITEMS_PAGES` (default 5)
- `SYNC_SCHEDULE_MS` (default 600000)
- `SYNC_MIN_INTERVAL_MS` (default 1800000)
- `AUTH_LOG_ENABLED` (default false)
- `TRUST_PROXY` (set to `true` when behind a trusted reverse proxy)
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Routes:
- `/api/auth/login` (start OAuth)
- `/api/auth/logout`
- `/api/spotify/app-status`
- `/api/spotify/user-status`
- `/api/spotify/me/tracks`
- `/api/spotify/me/playlists`
- `/api/spotify/me/top`
- `/api/spotify/me/library`
- `/api/spotify/playlists/:playlistId/items`
- `/api/spotify/sync` (POST: tracks_initial | tracks_incremental | playlists)
- `/api/spotify/sync-status`
- `/api/spotify/worker-health`
