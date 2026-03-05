export type WorkerStatus = "OK" | "STALE" | "MISSING" | "UNKNOWN";

export type HealthPayload = {
  ok: boolean;
  missing: string[];
  db: "OK" | "ERROR";
  worker: WorkerStatus;
  now: number;
};

export type HealthProbe = {
  dbOk: boolean;
  workerStatus: WorkerStatus;
};
