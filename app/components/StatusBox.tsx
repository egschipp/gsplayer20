"use client";

import { useEffect, useState } from "react";

type AppStatus = { status: string } | null;
type UserStatus = { status: string; scope?: string } | null;
type DbStatus = {
  counts: Record<string, number>;
  sync: { running: boolean; lastSuccessfulAt: number | null };
} | null;

type SyncStatus = { resources: any[]; asOf: number } | null;

function Badge({ label, tone }: { label: string; tone?: string }) {
  const bg = tone === "ok" ? "#166534" : tone === "warn" ? "#9a3412" : "#0f172a";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "4px 10px",
        borderRadius: 999,
        background: bg,
        color: "white",
        fontSize: 12,
        marginRight: 8,
      }}
    >
      {label}
    </span>
  );
}

export default function StatusBox() {
  const [appStatus, setAppStatus] = useState<AppStatus>(null);
  const [userStatus, setUserStatus] = useState<UserStatus>(null);
  const [dbStatus, setDbStatus] = useState<DbStatus>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(null);
  const [syncing, setSyncing] = useState(false);

  async function refresh() {
    try {
      const [appRes, userRes, dbRes, syncRes] = await Promise.all([
        fetch("/api/spotify/app-status"),
        fetch("/api/spotify/user-status"),
        fetch("/api/spotify/db-status"),
        fetch("/api/spotify/sync-status"),
      ]);

      if (appRes.ok) setAppStatus(await appRes.json());
      if (userRes.ok) setUserStatus(await userRes.json());
      if (dbRes.ok) setDbStatus(await dbRes.json());
      if (syncRes.ok) setSyncStatus(await syncRes.json());
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function forceSync() {
    setSyncing(true);
    try {
      await fetch("/api/spotify/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "tracks_initial",
          payload: { offset: 0, limit: 50, maxPagesPerRun: 50 },
        }),
      });
      await fetch("/api/spotify/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "playlists" }),
      });
    } finally {
      setSyncing(false);
      refresh();
    }
  }

  const running = dbStatus?.sync?.running ? "RUNNING" : "IDLE";
  const lastSync = dbStatus?.sync?.lastSuccessfulAt
    ? new Date(dbStatus.sync.lastSuccessfulAt).toLocaleString()
    : "n/a";

  return (
    <section
      style={{
        marginTop: 24,
        border: "1px solid #e2e8f0",
        borderRadius: 12,
        padding: 16,
        background: "#f8fafc",
      }}
    >
      <h2 style={{ marginBottom: 12 }}>Status</h2>
      <div style={{ marginBottom: 12 }}>
        <Badge
          label={`App: ${appStatus?.status ?? "CHECKING"}`}
          tone={appStatus?.status === "OK" ? "ok" : "warn"}
        />
        <Badge
          label={`User: ${userStatus?.status ?? "CHECKING"}`}
          tone={userStatus?.status === "OK" ? "ok" : "warn"}
        />
        <Badge label={`Sync: ${running}`} tone={running === "RUNNING" ? "warn" : "ok"} />
      </div>

      <div style={{ fontSize: 13, marginBottom: 12 }}>
        Last sync: {lastSync}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 8,
          fontSize: 13,
          marginBottom: 12,
        }}
      >
        {dbStatus?.counts
          ? Object.entries(dbStatus.counts).map(([key, value]) => (
              <div
                key={key}
                style={{
                  background: "white",
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  padding: 8,
                }}
              >
                <strong>{key}</strong>: {value}
              </div>
            ))
          : "DB status unavailable"}
      </div>

      <button
        onClick={forceSync}
        disabled={syncing}
        style={{
          padding: "10px 14px",
          borderRadius: 8,
          background: syncing ? "#94a3b8" : "#0f172a",
          color: "white",
          border: 0,
          cursor: syncing ? "not-allowed" : "pointer",
        }}
      >
        {syncing ? "Syncing..." : "Force sync"}
      </button>

      {syncStatus?.resources?.length ? (
        <div style={{ marginTop: 16, fontSize: 13 }}>
          <strong>Resources</strong>
          <div style={{ marginTop: 8 }}>
            {syncStatus.resources.map((row: any) => (
              <div
                key={row.resource}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  background: "#fff",
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  padding: "6px 8px",
                  marginBottom: 6,
                }}
              >
                <span>{row.resource}</span>
                <span>
                  {row.status}
                  {row.lastErrorCode ? ` • ${row.lastErrorCode}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
