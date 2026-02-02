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

Routes:
- `/api/auth/login` (start OAuth)
- `/api/auth/logout`
- `/api/spotify/app-status`
- `/api/spotify/user-status`
- `/api/spotify/me/tracks`
- `/api/spotify/me/playlists`
- `/api/spotify/me/top`
- `/api/spotify/sync` (POST: tracks_initial | tracks_incremental | playlists)
- `/api/spotify/sync-status`
