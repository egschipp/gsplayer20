# gsplayer20

Georgies Player

## Spotify Auth (server-side)

Required environment variables:

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REDIRECT_URI` (set in Spotify dashboard)
- `AUTH_SECRET` (or `NEXTAUTH_SECRET`)
- `AUTH_URL` (or `NEXTAUTH_URL`)
- `TOKEN_ENCRYPTION_KEY` (base64 32 bytes)
- `ADMIN_SPOTIFY_USER_IDS` (comma-separated Spotify IDs allowed to use operations routes)
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
- `TOKEN_ENCRYPTION_KEYS` and `TOKEN_ENCRYPTION_KEY_VERSION` for key rotation
- `RECENTLY_PLAYED_RETENTION_DAYS` (default 90)
- `JOB_RETENTION_DAYS` (default 30)
- `SPOTIFY_IMAGE_MAX_BYTES` (default 5242880)

Generate the legacy encryption key with `openssl rand -base64 32`. For rotation, set
`TOKEN_ENCRYPTION_KEYS` to comma-separated `version:base64-key` values, set
`TOKEN_ENCRYPTION_KEY_VERSION` to the newest version, deploy, and retain old keys until
all stored tokens have been rewritten or users have reconnected. Never put client
secrets, tokens, PINs, or encryption keys in Git.

Use at least 32 random characters for `AUTH_SECRET` and at least six digits for
`APP_PIN`; `/api/health` rejects weaker production configuration. PIN sessions expire
after 12 hours and are bound to a hash of the browser user agent.

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
- `/api/account/data` (`DELETE`, removes the signed-in user's stored data)

Operations and diagnostic routes require both an authenticated Spotify session and an
ID listed in `ADMIN_SPOTIFY_USER_IDS`. Signing out disconnects Spotify and deletes the
stored OAuth tokens. “Accountdata verwijderen” additionally removes the user's synced
library data. Spotify Dashboard refresh tokens expire after 180 days; the UI warns when
reauthorization is approaching.

## Architecture (Feature Slices)

Nieuwe server-side features staan onder `src/features/<feature>` met vaste lagen:

- `actions`: boundary orchestration (input parsing, use-case calls, output DTOs)
- `domain`: use-cases en policies
- `data`: repository/adapters richting bestaande infrastructuur
- `routes`: Next route adapters die contracten behouden
- `tests`: unit/integration tests zonder Next runtime

Shared infrastructuur staat onder `src/shared`:

- `cache`: centrale Redis-client
- `config`: env-validatie helpers
- `errors`: typed error classes

## How To Add A Feature

1. Maak `src/features/<feature>/{actions,domain,data,types,tests}` aan.
2. Definieer input/output types in `types`.
3. Schrijf pure businesslogica in `domain` (zonder Next of fetch).
4. Implementeer adapters in `data` voor DB/cache/externe services.
5. Orkestreer boundary-validatie in `actions`.
6. Maak route adapter in `routes` en exporteer die in `app/api/.../route.ts` als compat-wrapper.
7. Voeg minimaal een unit test voor domain toe en, waar relevant, een integration test voor action-level.

## Tests

- `npm run test:unit`
- `npm run test:integration`
- `npm test`
- `npm run test:coverage`
- `npm run test:e2e` (Chromium desktop + mobile and axe WCAG checks)
- `npm run lint && npm run typecheck && npm run format:check`

The main CI workflow runs these checks, audits dependencies, builds an ARM64 image,
publishes an immutable SHA candidate with SBOM/provenance, scans it with Trivy, and only
then promotes it to `latest`. CodeQL and Dependabot provide recurring analysis and
updates. Runtime containers are non-root, read-only, capability-free, and use a writable
`/data` volume plus a bounded `/tmp` tmpfs.

## Database operations

Run `npm run db:migrate` before starting a worker outside Compose. Migrations are
transactional and recorded in `schema_migrations`. The worker enforces retention for
recently played data and completed jobs and checkpoints the SQLite WAL. See
[`docs/backup-and-restore.md`](docs/backup-and-restore.md) for backup verification and
restore procedures.

## Releases

Releases use Semantic Versioning in `MAJOR.MINOR.PATCH` format and are tagged as `vMAJOR.MINOR.PATCH`.

- `feat:` bumps `MINOR`
- `fix:`, `perf:`, `refactor:`, `docs:`, `build:`, `ci:`, `chore:`, `test:` and `revert:` bump `PATCH`
- `type(scope)!:` or a `BREAKING CHANGE:` footer bumps `MAJOR`

The automated release workflow:

1. Calculates the next version from Conventional Commit messages since the latest semver tag.
2. Uses the highest of `package.json`, `.release-please-manifest.json`, and the latest git tag as the base version.
3. Writes the resolved version back to `package.json` and `.release-please-manifest.json`.
4. Creates an annotated git tag `vMAJOR.MINOR.PATCH` and a GitHub release.

Useful local commands:

- `npm run release:plan`
- `npm run release:apply -- 3.1.0`

`README.md` is refreshed automatically on every commit through `.githooks/pre-commit`.
Pushes are synchronized automatically through `.githooks/pre-push`, which fetches and rebases onto the tracked remote branch before pushing.

<!-- README:AUTO:START -->

## Repository Snapshot

This section is generated automatically on every commit.

- Package version: `4.0.8`
- Latest release tag: `v4.0.8`
- Branch: `refactor/ui-boundaries`
- Current HEAD before commit: `777610d`
- Updated at (UTC): `2026-08-14T19:14:46.143Z`

Generated by `npm run readme:update` via `.githooks/pre-commit`.
<!-- README:AUTO:END -->
