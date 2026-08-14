# Backup and restore

The weekly maintenance workflow creates an online SQLite backup in
`$DEPLOY_DIR/data/backups`, compresses it, and retains 30 days. Backups stay on the
Raspberry Pi, so copy them periodically to encrypted off-device storage.

Before restoring, stop both containers and retain the current database as a rollback
copy. Decompress the selected backup, then verify it:

```sh
npm ci --omit=dev
node scripts/ops/verify-backup.mjs /absolute/path/gsplayer-backup.sqlite
```

Only after the integrity check returns `status: ok`, replace `data/gsplayer.sqlite`
while the services are stopped. Preserve file ownership matching `APP_UID:APP_GID`,
start the web service, wait for its health check, and then start the worker. Perform a
test restore at least quarterly; the existence of a backup alone is not proof that it
is recoverable.
