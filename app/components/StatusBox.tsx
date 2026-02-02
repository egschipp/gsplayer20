"use client";

import { useEffect, useState } from "react";

type AppStatus = { status: string } | null;
type UserStatus = { status: string; scope?: string } | null;
type DbStatus = {
  counts: Record<string, number>;
  sync: { running: boolean; lastSuccessfulAt: number | null };
} | null;

type SyncStatus = { resources: any[]; asOf: number } | null;
type PlaylistMap = Record<string, { name: string; spotifyUrl?: string }>;
type WorkerHealth = {
  status: string;
  lastHeartbeat: number | null;
  staleAfterMs: number;
  now: number;
} | null;
type VersionInfo = { name: string; version: string } | null;

function Badge({ label, tone }: { label: string; tone?: "ok" | "warn" }) {
  const cls = tone === "ok" ? "pill pill-success" : "pill pill-warn";
  return <span className={cls}>{label}</span>;
}

export default function StatusBox() {
  const [appStatus, setAppStatus] = useState<AppStatus>(null);
  const [userStatus, setUserStatus] = useState<UserStatus>(null);
  const [dbStatus, setDbStatus] = useState<DbStatus>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(null);
  const [workerHealth, setWorkerHealth] = useState<WorkerHealth>(null);
  const [playlistMap, setPlaylistMap] = useState<PlaylistMap>({});
  const [versionInfo, setVersionInfo] = useState<VersionInfo>(null);
  const [syncing, setSyncing] = useState(false);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);

  async function refresh() {
    try {
      const [dbRes, syncRes, workerRes] = await Promise.all([
        fetch("/api/spotify/db-status"),
        fetch("/api/spotify/sync-status"),
        fetch("/api/spotify/worker-health"),
      ]);

      if (dbRes.ok) setDbStatus(await dbRes.json());
      if (syncRes.ok) setSyncStatus(await syncRes.json());
      if (workerRes.ok) setWorkerHealth(await workerRes.json());
      if (!loadingPlaylists && Object.keys(playlistMap).length === 0) {
        setLoadingPlaylists(true);
        const map: PlaylistMap = {};
        let cursor: string | null = null;
        let safety = 0;
        do {
          const url = new URL("/api/spotify/me/playlists", window.location.origin);
          url.searchParams.set("limit", "50");
          if (cursor) url.searchParams.set("cursor", cursor);
          const res = await fetch(url.toString());
          if (!res.ok) break;
          const data = await res.json();
          const items = Array.isArray(data.items) ? data.items : [];
          for (const item of items) {
            map[item.playlistId] = {
              name: item.name,
              spotifyUrl: `https://open.spotify.com/playlist/${item.playlistId}`,
            };
          }
          cursor = data.nextCursor ?? null;
          safety += 1;
        } while (cursor && safety < 20);
        setPlaylistMap(map);
        setLoadingPlaylists(false);
      }
    } catch {
      // ignore
    }
  }

  async function refreshAuthStatus() {
    try {
      const [appRes, userRes, versionRes] = await Promise.all([
        fetch("/api/spotify/app-status"),
        fetch("/api/spotify/user-status"),
        fetch("/api/version"),
      ]);

      if (appRes.ok) setAppStatus(await appRes.json());
      if (userRes.ok) setUserStatus(await userRes.json());
      if (versionRes.ok) setVersionInfo(await versionRes.json());
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    refresh();
    refreshAuthStatus();
    const fast = setInterval(refresh, 2000);
    const slow = setInterval(refreshAuthStatus, 15000);
    return () => {
      clearInterval(fast);
      clearInterval(slow);
    };
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
      await fetch("/api/spotify/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "covers" }),
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
  const workerStatus = workerHealth?.status ?? "CHECKING";
  const workerLast = workerHealth?.lastHeartbeat
    ? new Date(workerHealth.lastHeartbeat).toLocaleString()
    : "n/a";

  return (
    <section className="card" style={{ marginTop: 24 }}>
      <h2 className="heading-2">Status</h2>
      <div style={{ marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Badge
          label={`App: ${appStatus?.status ?? "CHECKING"}`}
          tone={appStatus?.status === "OK" ? "ok" : "warn"}
        />
        <Badge
          label={`User: ${userStatus?.status ?? "CHECKING"}`}
          tone={userStatus?.status === "OK" ? "ok" : "warn"}
        />
        <Badge label={`Sync: ${running}`} tone={running === "RUNNING" ? "warn" : "ok"} />
        <Badge
          label={`Worker: ${workerStatus}`}
          tone={workerStatus === "OK" ? "ok" : "warn"}
        />
      </div>

      <div className="text-body" style={{ marginBottom: 12 }}>
        <div>Last sync: {lastSync}</div>
        <div>Worker heartbeat: {workerLast}</div>
        <div>Version: {versionInfo?.version ?? "n/a"}</div>
      </div>

      <div className="status-grid" style={{ fontSize: 13, marginBottom: 12 }}>
        {dbStatus?.counts
          ? Object.entries(dbStatus.counts).map(([key, value]) => (
              <div
                key={key}
                className="panel"
              >
                <strong>{key}</strong>: {value}
              </div>
            ))
          : "DB status unavailable"}
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button onClick={forceSync} disabled={syncing} className="btn btn-primary">
          {syncing ? "Syncing..." : "Force sync"}
        </button>
        <button
          onClick={async () => {
            setSyncing(true);
            try {
              await fetch("/api/spotify/sync", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "track_metadata" }),
              });
              await fetch("/api/spotify/sync", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "covers" }),
              });
            } finally {
              setSyncing(false);
              refresh();
            }
          }}
          disabled={syncing}
          className="btn btn-secondary"
        >
          Backfill covers
        </button>
      </div>

      {syncStatus?.resources?.length ? (
        <div style={{ marginTop: 16, fontSize: 13 }}>
          <strong>Resources</strong>
          <div style={{ marginTop: 8 }}>
            {syncStatus.resources.map((row: any) => {
              const isPlaylist = String(row.resource).startsWith("playlist_items:");
              const playlistId = isPlaylist
                ? String(row.resource).split(":")[1]
                : null;
              const displayName =
                playlistId && playlistMap[playlistId]?.name
                  ? playlistMap[playlistId].name
                  : row.resource;
              return (
              <div
                key={row.resource}
                className="panel"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 6,
                }}
              >
                <span>{displayName}</span>
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span>
                    {row.status}
                    {row.lastErrorCode ? ` • ${row.lastErrorCode}` : ""}
                  </span>
                  {playlistId ? (
                    <button
                      className="btn btn-secondary"
                      onClick={async () => {
                        await fetch("/api/spotify/sync", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            type: "playlist_items",
                            payload: {
                              playlistId,
                              offset: 0,
                              limit: 50,
                              maxPagesPerRun: 20,
                              runId: `manual-${Date.now()}`,
                            },
                          }),
                        });
                        refresh();
                      }}
                    >
                      Refresh now
                    </button>
                  ) : null}
                </span>
              </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
