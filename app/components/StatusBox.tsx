"use client";

import { useCallback, useEffect, useState } from "react";

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
type ResourceNameMap = Record<string, string>;
function Badge({ label, tone }: { label: string; tone?: "ok" | "warn" }) {
  const cls = tone === "ok" ? "pill pill-success" : "pill pill-warn";
  return <span className={cls}>{label}</span>;
}

const COUNT_LABELS: Record<string, string> = {
  user_saved_tracks: "Opgeslagen tracks",
  playlists: "Playlists",
  tracks: "Tracks",
  artists: "Artiesten",
  playlist_items: "Playlist‑tracks",
  cover_images: "Coverafbeeldingen",
};

function formatSyncStatus(running: boolean) {
  return running
    ? { label: "Bibliotheek wordt bijgewerkt", tone: "warn" as const }
    : { label: "Bibliotheek up‑to‑date", tone: "ok" as const };
}

function formatResourceStatus(status: string | null | undefined) {
  const value = String(status ?? "").toUpperCase();
  if (value === "OK") return "Up-to-date";
  if (value === "RUNNING") return "Bezig";
  if (value === "FAILED") return "Mislukt";
  return value || "Onbekend";
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
  const [resourceNameMap, setResourceNameMap] = useState<ResourceNameMap>({});
  const [resourceUpdateState, setResourceUpdateState] = useState<
    Record<string, { status: "idle" | "running" | "success" | "error"; at: number }>
  >({});

  const refresh = useCallback(async () => {
    try {
      const [dbRes, syncRes, workerRes] = await Promise.all([
        fetch("/api/spotify/db-status"),
        fetch("/api/spotify/sync-status"),
        fetch("/api/spotify/worker-health"),
      ]);

      if (dbRes.ok) setDbStatus(await dbRes.json());
      if (syncRes.ok) {
        const data = await syncRes.json();
        setSyncStatus(data);
        if (data?.resources?.length) {
          setResourceNameMap((prev) => {
            const next: ResourceNameMap = { ...prev };
            for (const row of data.resources) {
              const resource = String(row.resource);
              if (!resource.startsWith("playlist_items:")) {
                if (!next[resource]) next[resource] = resource;
                continue;
              }
              const playlistId = resource.split(":")[1];
              const name = playlistMap[playlistId]?.name;
              if (name) {
                next[resource] = name;
              } else if (!next[resource]) {
                next[resource] = resource;
              }
            }
            return next;
          });
        }
      }
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
  }, [loadingPlaylists, playlistMap]);

  const refreshAuthStatus = useCallback(async () => {
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
  }, []);

  async function logoutPin() {
    await fetch("/api/pin-logout", { method: "POST" });
    window.location.href = "/login";
  }

  useEffect(() => {
    refresh();
    refreshAuthStatus();
    const fast = setInterval(refresh, 5000);
    const slow = setInterval(refreshAuthStatus, 15000);
    return () => {
      clearInterval(fast);
      clearInterval(slow);
    };
  }, [refresh, refreshAuthStatus]);

  useEffect(() => {
    if (!Object.keys(playlistMap).length) return;
    setResourceNameMap((prev) => {
      const next: ResourceNameMap = { ...prev };
      for (const [id, meta] of Object.entries(playlistMap)) {
        const key = `playlist_items:${id}`;
        if (meta?.name) next[key] = meta.name;
      }
      return next;
    });
  }, [playlistMap]);

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
        body: JSON.stringify({ type: "artists" }),
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

  const runningInfo = formatSyncStatus(Boolean(dbStatus?.sync?.running));
  const lastSync = dbStatus?.sync?.lastSuccessfulAt
    ? new Date(dbStatus.sync.lastSuccessfulAt).toLocaleString()
    : "n/a";
  const workerStatus = workerHealth?.status ?? "CHECKING";
  const workerLast = workerHealth?.lastHeartbeat
    ? new Date(workerHealth.lastHeartbeat).toLocaleString()
    : "n/a";
  const importantCounts = dbStatus?.counts
    ? Object.entries(dbStatus.counts)
        .filter(([key]) => COUNT_LABELS[key])
        .map(([key, value]) => ({
          key,
          label: COUNT_LABELS[key],
          value,
        }))
    : [];

  return (
    <section className="card" style={{ marginTop: 24 }}>
      <h2 className="heading-2">Account & Bibliotheek</h2>
      <div className="text-body" style={{ marginBottom: 12 }}>
        Beheer je Spotify‑koppeling en werk je bibliotheek handmatig bij.
      </div>
      <div className="status-badges" style={{ marginBottom: 12 }}>
        <Badge
          label={`App: ${appStatus?.status ?? "CHECKING"}`}
          tone={appStatus?.status === "OK" ? "ok" : "warn"}
        />
        <Badge
          label={`Account: ${userStatus?.status ?? "CHECKING"}`}
          tone={userStatus?.status === "OK" ? "ok" : "warn"}
        />
        <Badge label={runningInfo.label} tone={runningInfo.tone} />
        <Badge
          label={`Synchronisatie: ${workerStatus}`}
          tone={workerStatus === "OK" ? "ok" : "warn"}
        />
      </div>

      <div className="text-body status-summary" style={{ marginBottom: 12 }}>
        <div>Laatst bijgewerkt: {lastSync}</div>
        <div>Worker controle: {workerLast}</div>
        <div>Versie: {versionInfo?.version ?? "n/a"}</div>
      </div>

      <div className="status-grid compact" style={{ marginBottom: 12 }}>
        {importantCounts.length
          ? importantCounts.map((row) => (
              <div key={row.key} className="panel">
                <strong>{row.label}</strong>: {row.value}
              </div>
            ))
          : "Geen statusdata beschikbaar."}
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button
          onClick={async () => {
            setSyncing(true);
            try {
              await forceSync();
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
              setSyncCooldownMessage(null);
              setSyncCooldownUntil(null);
            } finally {
              setSyncing(false);
              refresh();
            }
          }}
          disabled={syncing}
          className="btn btn-primary"
        >
          {syncing ? "Bijwerken..." : "Database bijwerken"}
        </button>
      </div>

      {syncStatus?.resources?.length ? (
        <details className="panel" style={{ marginTop: 16 }}>
          <summary className="details-summary">
            Playlists bijwerken ({syncStatus.resources.length})
          </summary>
          <div style={{ marginTop: 12, fontSize: 13 }}>
            {syncStatus.resources
              .slice()
              .sort((a: any, b: any) => {
                const aName = String(
                  resourceNameMap[String(a.resource)] ?? a.resource
                );
                const bName = String(
                  resourceNameMap[String(b.resource)] ?? b.resource
                );
                return aName.localeCompare(bName, "nl", { sensitivity: "base" });
              })
              .map((row: any) => {
                const isPlaylist = String(row.resource).startsWith("playlist_items:");
                const playlistId = isPlaylist
                  ? String(row.resource).split(":")[1]
                  : null;
                const displayName =
                  resourceNameMap[String(row.resource)] ?? row.resource;
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
                        {formatResourceStatus(row.status)}
                        {row.lastErrorCode ? ` • foutcode ${row.lastErrorCode}` : ""}
                      </span>
                      {playlistId ? (
                        <span className="text-subtle">
                          {resourceUpdateState[playlistId]?.status === "running"
                            ? "Bezig..."
                            : resourceUpdateState[playlistId]?.status === "success"
                            ? "Afgerond"
                            : resourceUpdateState[playlistId]?.status === "error"
                            ? "Mislukt"
                            : ""}
                        </span>
                      ) : null}
                      {playlistId ? (
                        <button
                          className="btn btn-secondary"
                          onClick={async () => {
                            setResourceUpdateState((prev) => ({
                              ...prev,
                              [playlistId]: { status: "running", at: Date.now() },
                            }));
                            try {
                              const res = await fetch("/api/spotify/sync", {
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
                              if (!res.ok) {
                                throw new Error(`SYNC_FAILED_${res.status}`);
                              }
                              refresh();
                              setResourceUpdateState((prev) => ({
                                ...prev,
                                [playlistId]: { status: "success", at: Date.now() },
                              }));
                            setTimeout(() => {
                              setResourceUpdateState((prev) => {
                                const next = { ...prev };
                                if (next[playlistId]?.status === "success") {
                                  delete next[playlistId];
                                }
                                return next;
                              });
                            }, 12000);
                          } catch {
                            setResourceUpdateState((prev) => ({
                              ...prev,
                              [playlistId]: { status: "error", at: Date.now() },
                            }));
                            setTimeout(() => {
                                setResourceUpdateState((prev) => {
                                  const next = { ...prev };
                                  if (next[playlistId]?.status === "error") {
                                    delete next[playlistId];
                                  }
                                  return next;
                                });
                              }, 12000);
                            }
                          }}
                        >
                          Nu bijwerken
                        </button>
                      ) : null}
                    </span>
                  </div>
                );
              })}
          </div>
        </details>
      ) : null}
    </section>
  );
}
