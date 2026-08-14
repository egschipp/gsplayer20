import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export default async function globalTeardown() {
  const databasePath = path.join(tmpdir(), "gsplayer20-e2e.sqlite");
  await Promise.all(
    [databasePath, `${databasePath}-shm`, `${databasePath}-wal`].map((file) =>
      rm(file, { force: true })
    )
  );
}
