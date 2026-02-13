"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import {
  CHATGPT_PROMPT_TEMPLATE,
  CHATGPT_PROMPT_TOKENS,
  normalizePromptTemplate,
} from "@/lib/chatgpt/prompt";

type AppStatus = { status: string } | null;
type UserStatus = {
  status: string;
  scope?: string;
  profile?: {
    id?: string;
    display_name?: string;
    email?: string;
    country?: string;
    product?: string;
    images?: { url: string }[];
  };
} | null;
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
  playlists: "Playlists",
  tracks: "Tracks",
  artists: "Artiesten",
};

const COUNT_ICONS: Record<string, string> = {
  playlists: "📂",
  tracks: "🎵",
  artists: "👤",
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
  const [promptTemplate, setPromptTemplate] = useState("");
  const [promptWarning, setPromptWarning] = useState<string | null>(null);
  const [promptSaved, setPromptSaved] = useState<null | "saved" | "error">(null);

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
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem("gs_chatgpt_prompt");
    const base = stored ? normalizePromptTemplate(stored) : CHATGPT_PROMPT_TEMPLATE;
    setPromptTemplate(base);
  }, []);

  function enforceTokens(value: string) {
    let next = value ?? "";
    const unknown = next.match(/\[[^\]]+\]/g)?.filter(
      (match) => !(CHATGPT_PROMPT_TOKENS as readonly string[]).includes(match)
    );
    if (unknown?.length) {
      setPromptWarning(`Onbekende variabelen verwijderd: ${unknown.join(", ")}`);
    } else {
      setPromptWarning(null);
    }
    // Remove any bracketed text that isn't a known token.
    next = next.replace(/\[[^\]]+\]/g, (match) => {
      if ((CHATGPT_PROMPT_TOKENS as readonly string[]).includes(match)) {
        return match;
      }
      return match.replace("[", "").replace("]", "");
    });
    return normalizePromptTemplate(next);
  }

  function handlePromptChange(value: string) {
    setPromptSaved(null);
    setPromptTemplate(enforceTokens(value));
  }

  function savePrompt() {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem("gs_chatgpt_prompt", promptTemplate);
      }
      setPromptSaved("saved");
    } catch {
      setPromptSaved("error");
    }
  }

  function resetPrompt() {
    const base = CHATGPT_PROMPT_TEMPLATE;
    setPromptTemplate(base);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem("gs_chatgpt_prompt", base);
      }
      setPromptSaved("saved");
    } catch {
      setPromptSaved("error");
    }
  }

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
          icon: COUNT_ICONS[key] ?? "•",
          value,
        }))
    : [];

  return (
    <section className="card account-page" style={{ marginTop: 24 }}>
      <div className="account-header">
        <div />
        <div className="account-version">
          <div className="account-panel-title">Versie</div>
          <div className="account-version-value">{versionInfo?.version ?? "n/a"}</div>
        </div>
      </div>

      <div className="account-grid">
        <div className="panel account-panel">
          <div className="account-panel-title">Spotify‑koppeling</div>
          <div className="account-connection">
            {userStatus?.status === "OK" && userStatus.profile ? (
              <div className="account-user">
                <div className="account-user-avatar">
                  {userStatus.profile.images?.[0]?.url ? (
                    <Image
                      src={userStatus.profile.images[0].url}
                      alt={userStatus.profile.display_name ?? "Spotify user"}
                      width={56}
                      height={56}
                      unoptimized
                    />
                  ) : (
                    <div className="account-user-avatar placeholder" />
                  )}
                </div>
                <div className="account-user-meta">
                  <div className="account-user-name">
                    {userStatus.profile.display_name ?? "Spotify gebruiker"}
                  </div>
                  <div className="text-subtle">
                    {userStatus.profile.email ?? "Geen e-mail"} ·{" "}
                    {userStatus.profile.country ?? "—"} ·{" "}
                    {userStatus.profile.product ?? "free"}
                  </div>
                  <div className="text-subtle">
                    Spotify ID: {userStatus.profile.id ?? "—"}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-body">
                {userStatus?.status === "OK"
                  ? "Verbonden met Spotify."
                  : "Niet verbonden met Spotify."}
              </div>
            )}
            <div className="status-badges">
              <Badge
                label={`Koppeling: ${userStatus?.status ?? "CHECKING"}`}
                tone={userStatus?.status === "OK" ? "ok" : "warn"}
              />
            </div>
            <div className="account-actions">
              <button
                type="button"
                className={`btn ${
                  userStatus?.status === "OK"
                    ? "btn-outline-green"
                    : "btn-solid-green"
                }`}
                onClick={() => {
                  window.location.href = "/api/auth/login";
                }}
              >
                Spotify login
              </button>
              <button
                type="button"
                className="btn btn-outline-green"
                onClick={() => {
                  window.location.href = "/api/auth/logout";
                }}
              >
                Spotify logout
              </button>
            </div>
          </div>
        </div>

        <div className="panel account-panel">
          <div className="account-panel-title">Status</div>
          <div className="status-badges">
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

          <div className="text-body status-summary">
            <div>Laatst bijgewerkt: {lastSync}</div>
            <div>Worker controle: {workerLast}</div>
          </div>

          <div className="status-grid compact">
            {importantCounts.length
              ? importantCounts.map((row) => (
                  <div key={row.key} className="panel">
                    <span className="count-icon" aria-hidden="true">
                      {row.icon}
                    </span>
                    <strong>{row.label}</strong>: {row.value}
                  </div>
                ))
              : "Geen statusdata beschikbaar."}
          </div>
        </div>

        <div className="panel account-panel">
          <div className="account-panel-title">Acties</div>
          <div className="account-actions">
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
                } finally {
                  setSyncing(false);
                  refresh();
                }
              }}
              disabled={syncing}
              className="btn btn-outline-green account-action-primary"
            >
              {syncing ? "Bijwerken..." : "Database bijwerken"}
            </button>
            <button onClick={logoutPin} className="btn btn-outline-green">
              Uitloggen App
            </button>
          </div>
        </div>

        <details className="panel account-panel">
          <summary className="details-summary">ChatGPT prompt</summary>
          <div className="text-body" style={{ marginTop: 12 }}>
            Pas de prompt aan die naar het klembord wordt gekopieerd.
          </div>
          <div className="text-subtle" style={{ marginTop: 8 }}>
            Variabelen (niet te bewerken):{" "}
            {CHATGPT_PROMPT_TOKENS.map((token) => (
              <code key={token} style={{ marginRight: 8 }}>
                {token}
              </code>
            ))}
          </div>
          {promptWarning ? (
            <div className="text-subtle" style={{ marginTop: 6, color: "#facc15" }}>
              {promptWarning}
            </div>
          ) : null}
          <textarea
            className="input"
            style={{ marginTop: 12, minHeight: 220, width: "100%" }}
            value={promptTemplate}
            onChange={(event) => handlePromptChange(event.target.value)}
          />
          <div className="account-actions" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-outline-green" onClick={savePrompt}>
              Opslaan
            </button>
            <button type="button" className="btn btn-secondary" onClick={resetPrompt}>
              Herstellen
            </button>
            {promptSaved === "saved" ? (
              <span className="text-subtle">Opgeslagen</span>
            ) : promptSaved === "error" ? (
              <span className="text-subtle">Opslaan mislukt</span>
            ) : null}
          </div>
        </details>
      </div>

      <div className="account-divider" />

      <div className="panel account-panel">
        <div className="account-panel-title">Playlists bijwerken</div>
        <div className="text-body" style={{ marginBottom: 12 }}>
          Werk individuele playlists bij als er iets ontbreekt.
        </div>

        {syncStatus?.resources?.length ? (
          <div className="account-resource-list">
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
                  <div key={row.resource} className="account-resource-row">
                    <div className="account-resource-name">{displayName}</div>
                    <div className="account-resource-meta">
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
                    </div>
                  </div>
                );
              })}
          </div>
        ) : (
          <div className="text-subtle">Geen playlists gevonden.</div>
        )}
      </div>
    </section>
  );
}
