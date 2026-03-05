import { getSqlite } from "@/lib/db/client";
import { evaluateHealth } from "@/src/features/system/domain/health.use-case";
import type { WorkerStatus } from "@/src/features/system/types/system.types";

export const runtime = "nodejs";

const WORKER_STALE_AFTER_MS = 30_000;

function probeSystemHealth() {
  let dbOk = false;
  let workerStatus: WorkerStatus = "UNKNOWN";

  try {
    const sqlite = getSqlite();
    sqlite.prepare("SELECT 1").get();
    dbOk = true;

    const heartbeat = sqlite
      .prepare("SELECT updated_at FROM worker_heartbeat WHERE id='worker'")
      .get() as { updated_at?: number } | undefined;

    if (!heartbeat?.updated_at) {
      workerStatus = "MISSING";
    } else if (Date.now() - heartbeat.updated_at > WORKER_STALE_AFTER_MS) {
      workerStatus = "STALE";
    } else {
      workerStatus = "OK";
    }
  } catch {
    dbOk = false;
    workerStatus = "UNKNOWN";
  }

  return {
    dbOk,
    workerStatus,
  };
}

export async function GET() {
  const payload = evaluateHealth({ probe: probeSystemHealth() });

  if (!payload.ok) {
    return Response.json(payload, { status: 500 });
  }

  return Response.json(payload, { status: 200 });
}
