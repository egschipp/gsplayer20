"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHATGPT_PROMPT_TEMPLATE,
  CHATGPT_PROMPT_TOKEN_LABELS,
  finalizePromptTemplate,
  normalizePromptTemplate,
  sanitizePromptTemplateInput,
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
type BadgeTone = "ok" | "warn" | "error" | "info";
type SyncResourceRow = {
  resource: string;
  status?: string | null;
  lastSuccessfulAt?: number | null;
  lastErrorCode?: string | null;
  updatedAt?: number | null;
  retryAfterAt?: number | null;
};

function Badge({ label, tone }: { label: string; tone?: BadgeTone }) {
  const cls =
    tone === "ok"
      ? "pill pill-success"
      : tone === "error"
      ? "pill pill-error"
      : tone === "info"
      ? "pill pill-info"
      : "pill pill-warn";
  const icon =
    tone === "ok"
      ? "✔"
      : tone === "error"
      ? "✖"
      : tone === "info"
      ? "ℹ"
      : "⚠";
  return (
    <span className={cls}>
      <span aria-hidden="true">{icon}</span>
      {label}
    </span>
  );
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

function toneFromStatus(value: string | null | undefined): BadgeTone {
  const status = String(value ?? "").toUpperCase();
  if (status === "OK") return "ok";
  if (status === "RUNNING") return "warn";
  if (status.startsWith("ERROR") || status === "FAILED") return "error";
  if (status === "CHECKING") return "info";
  return "warn";
}

function buildApiUrl(
  path: string,
  params?: Record<string, string | null | undefined>
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value == null || value === "") continue;
    query.set(key, value);
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

function parseRetryAfterMs(res: Response) {
  const retryAfter = Number(res.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(Math.round(retryAfter * 1000), 60_000);
  }
  return 5_000;
}

type StatusBoxProps = {
  embedded?: boolean;
  mode?: "full" | "basic-core";
  showOverviewCounts?: boolean;
};

export default function StatusBox({
  embedded = false,
  mode = "full",
  showOverviewCounts = true,
}: StatusBoxProps) {
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
  const [selectedSyncResource, setSelectedSyncResource] = useState<string>("");
  const [promptTemplate, setPromptTemplate] = useState("");
  const [promptWarning, setPromptWarning] = useState<string | null>(null);
  const [promptSaved, setPromptSaved] = useState<null | "saved" | "error">(null);
  const authRateLimitedUntilRef = useRef(0);
  const showStatusPanel = mode === "full" || showOverviewCounts;
  const shouldLoadDbStatus = showStatusPanel;

  const refresh = useCallback(async () => {
    try {
      const [dbRes, syncRes, workerRes] = await Promise.all([
        shouldLoadDbStatus
          ? fetch("/api/spotify/db-status", { cache: "no-store" })
          : Promise.resolve(null),
        fetch("/api/spotify/sync-status", { cache: "no-store" }),
        fetch("/api/spotify/worker-health", { cache: "no-store" }),
      ]);

      if (dbRes?.ok) {
        setDbStatus(await dbRes.json());
      } else if (!shouldLoadDbStatus) {
        setDbStatus(null);
      }
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
          const res: Response = await fetch(
            buildApiUrl("/api/spotify/me/playlists", { limit: "50", cursor }),
            { cache: "no-store" }
          );
          if (!res.ok) break;
          const data = (await res.json().catch(() => null)) as
            | {
                items?: Array<{ playlistId?: string; name?: string }>;
                nextCursor?: string | null;
              }
            | null;
          const items = Array.isArray(data?.items) ? data.items : [];
          for (const item of items) {
            const playlistId =
              typeof item?.playlistId === "string" ? item.playlistId : "";
            if (!playlistId) continue;
            map[playlistId] = {
              name:
                typeof item?.name === "string" && item.name
                  ? item.name
                  : "Untitled playlist",
              spotifyUrl: `https://open.spotify.com/playlist/${playlistId}`,
            };
          }
          cursor = data?.nextCursor ?? null;
          safety += 1;
        } while (cursor && safety < 20);
        setPlaylistMap(map);
        setLoadingPlaylists(false);
      }
    } catch {
      // ignore
    }
  }, [loadingPlaylists, playlistMap, shouldLoadDbStatus]);

  const refreshAuthStatus = useCallback(async () => {
    if (Date.now() < authRateLimitedUntilRef.current) return;
    try {
      const [appRes, userRes, versionRes] = await Promise.all([
        fetch("/api/spotify/app-status", { cache: "no-store" }),
        fetch("/api/spotify/user-status", { cache: "no-store" }),
        fetch("/api/version", { cache: "no-store" }),
      ]);

      if (appRes.status === 429 || userRes.status === 429) {
        const retryMs = Math.max(
          appRes.status === 429 ? parseRetryAfterMs(appRes) : 0,
          userRes.status === 429 ? parseRetryAfterMs(userRes) : 0
        );
        authRateLimitedUntilRef.current = Date.now() + retryMs;
        setAppStatus((prev) => prev ?? { status: "CHECKING" });
        setUserStatus((prev) => prev ?? { status: "CHECKING" });
        return;
      }

      const appPayload = (await appRes.json().catch(() => null)) as
        | { status?: string }
        | null;
      if (appPayload?.status) {
        setAppStatus(appPayload as AppStatus);
      } else if (!appRes.ok) {
        setAppStatus({
          status: appRes.status === 429 ? "ERROR_RATE_LIMIT" : "ERROR_NETWORK",
        });
      }

      const userPayload = (await userRes.json().catch(() => null)) as
        | UserStatus
        | { status?: string }
        | null;
      if (userPayload?.status) {
        setUserStatus(userPayload as UserStatus);
      } else {
        if (userRes.status === 401) {
          setUserStatus({ status: "LOGGED_OUT" });
        } else if (userRes.status === 403) {
          setUserStatus({ status: "ERROR_SCOPES" });
        } else if (userRes.status === 429) {
          setUserStatus({ status: "ERROR_RATE_LIMIT" });
        } else if (!userRes.ok) {
          setUserStatus({ status: "ERROR_NETWORK" });
        }
      }

      if (versionRes.ok) {
        setVersionInfo(await versionRes.json().catch(() => null));
      }
    } catch {
      setAppStatus({ status: "ERROR_NETWORK" });
      setUserStatus({ status: "ERROR_NETWORK" });
    }
  }, []);

  async function logoutPin() {
    await fetch("/api/pin-logout", { method: "POST" });
    window.location.href = "/login";
  }

  useEffect(() => {
    refresh();
    refreshAuthStatus();
    const fast = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      refresh();
    }, 5000);
    const slow = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      refreshAuthStatus();
    }, 15000);
    return () => {
      clearInterval(fast);
      clearInterval(slow);
    };
  }, [refresh, refreshAuthStatus]);

  useEffect(() => {
    const refreshNow = () => {
      refreshAuthStatus();
    };
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      refreshNow();
    };
    if (typeof window === "undefined") return;
    window.addEventListener("focus", refreshNow);
    window.addEventListener("pageshow", refreshNow);
    window.addEventListener("online", refreshNow);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", refreshNow);
      window.removeEventListener("pageshow", refreshNow);
      window.removeEventListener("online", refreshNow);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refreshAuthStatus]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem("gs_chatgpt_prompt");
    const base = stored ? normalizePromptTemplate(stored) : CHATGPT_PROMPT_TEMPLATE;
    setPromptTemplate(base);
  }, []);

  function enforceTokens(value: string) {
    const { template, unknownTokens: unknown } = sanitizePromptTemplateInput(value);
    if (unknown?.length) {
      setPromptWarning(`Onbekende variabelen verwijderd: ${unknown.join(", ")}`);
    } else {
      setPromptWarning(null);
    }
    return template;
  }

  function handlePromptChange(value: string) {
    setPromptSaved(null);
    setPromptTemplate(enforceTokens(value));
  }

  function savePrompt() {
    try {
      const next = finalizePromptTemplate(promptTemplate);
      setPromptTemplate(next);
      if (typeof window !== "undefined") {
        window.localStorage.setItem("gs_chatgpt_prompt", next);
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

  const statusBadgeItems = [
    {
      label: `App: ${appStatus?.status ?? "CHECKING"}`,
      tone: toneFromStatus(appStatus?.status),
    },
    {
      label: `Account: ${userStatus?.status ?? "CHECKING"}`,
      tone: toneFromStatus(userStatus?.status),
    },
    { label: runningInfo.label, tone: runningInfo.tone },
    {
      label: `Synchronisatie: ${workerStatus}`,
      tone: toneFromStatus(workerStatus),
    },
  ];
  const connectionMessage =
    userStatus?.status === "OK"
      ? "Verbonden met Spotify."
      : userStatus?.status === "ERROR_SCOPES"
      ? "Spotify-rechten ontbreken. Log opnieuw in."
      : userStatus?.status === "ERROR_REVOKED"
      ? "Spotify-toegang is ingetrokken. Log opnieuw in."
      : userStatus?.status === "ERROR_RATE_LIMIT"
      ? "Inlogstatus wordt te vaak opgevraagd. Even wachten."
      : userStatus?.status === "ERROR_NETWORK"
      ? "Spotify is tijdelijk niet bereikbaar."
      : "Niet verbonden met Spotify.";
  const showConnectionPanel = mode === "full";
  const showActionPanel = mode === "full";
  const showResourcePanel = true;
  const showHeader = mode !== "basic-core";
  const showStatusMeta = mode !== "basic-core";
  const statusPanelSpan = showConnectionPanel || showActionPanel ? "span-3" : "span-12";
  const promptPanelSpan = showConnectionPanel || showActionPanel ? "span-6" : "span-12";
  const embeddedTitle = "Instellingen";

  const playlistSyncRows = useMemo(() => {
    const rows = Array.isArray(syncStatus?.resources) ? syncStatus.resources : [];
    const mapped = rows
      .map((row) => {
        const resource = String((row as SyncResourceRow)?.resource ?? "");
        if (!resource.startsWith("playlist_items:")) return null;
        const playlistId = resource.split(":")[1] ?? "";
        if (!playlistId) return null;
        const fallbackName = playlistMap[playlistId]?.name ?? `Playlist ${playlistId.slice(0, 6)}`;
        const displayName =
          resourceNameMap[resource] ||
          playlistMap[playlistId]?.name ||
          fallbackName;
        return {
          resource,
          playlistId,
          displayName,
          status: String((row as SyncResourceRow)?.status ?? "").toUpperCase() || "UNKNOWN",
          lastSuccessfulAt:
            typeof (row as SyncResourceRow)?.lastSuccessfulAt === "number"
              ? Number((row as SyncResourceRow).lastSuccessfulAt)
              : null,
          lastErrorCode:
            typeof (row as SyncResourceRow)?.lastErrorCode === "string"
              ? String((row as SyncResourceRow).lastErrorCode)
              : null,
          updatedAt:
            typeof (row as SyncResourceRow)?.updatedAt === "number"
              ? Number((row as SyncResourceRow).updatedAt)
              : null,
          retryAfterAt:
            typeof (row as SyncResourceRow)?.retryAfterAt === "number"
              ? Number((row as SyncResourceRow).retryAfterAt)
              : null,
        };
      })
      .filter(
        (
          row
        ): row is {
          resource: string;
          playlistId: string;
          displayName: string;
          status: string;
          lastSuccessfulAt: number | null;
          lastErrorCode: string | null;
          updatedAt: number | null;
          retryAfterAt: number | null;
        } => Boolean(row)
      )
      .sort((a, b) =>
        a.displayName.localeCompare(b.displayName, "nl", { sensitivity: "base" })
      );
    return mapped;
  }, [playlistMap, resourceNameMap, syncStatus?.resources]);

  useEffect(() => {
    if (!playlistSyncRows.length) {
      if (selectedSyncResource) {
        setSelectedSyncResource("");
      }
      return;
    }
    if (!playlistSyncRows.some((row) => row.resource === selectedSyncResource)) {
      setSelectedSyncResource(playlistSyncRows[0].resource);
    }
  }, [playlistSyncRows, selectedSyncResource]);

  const selectedSyncRow =
    playlistSyncRows.find((row) => row.resource === selectedSyncResource) ?? null;
  const selectedSyncPlaylistId = selectedSyncRow?.playlistId ?? null;
  const selectedSyncUpdateState = selectedSyncPlaylistId
    ? resourceUpdateState[selectedSyncPlaylistId]?.status
    : null;
  const selectedSyncStatus = selectedSyncUpdateState
    ? selectedSyncUpdateState === "success"
      ? "OK"
      : selectedSyncUpdateState === "error"
      ? "FAILED"
      : selectedSyncUpdateState === "running"
      ? "RUNNING"
      : selectedSyncRow?.status ?? "UNKNOWN"
    : selectedSyncRow?.status ?? "UNKNOWN";
  const selectedSyncTone = toneFromStatus(selectedSyncStatus);
  const selectedSyncStatusLabel =
    selectedSyncUpdateState === "success"
      ? "Afgerond"
      : selectedSyncUpdateState === "error"
      ? "Mislukt"
      : selectedSyncUpdateState === "running"
      ? "Bezig"
      : formatResourceStatus(selectedSyncStatus);
  const selectedSyncLastSuccessfulAt = selectedSyncRow?.lastSuccessfulAt ?? null;

  const syncSelectedPlaylist = useCallback(
    async (playlistId: string) => {
      if (!playlistId) return;
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
    },
    [refresh]
  );

  return (
    <section
      className={embedded ? "account-page statusbox-embedded" : "card account-page"}
      style={embedded ? undefined : { marginTop: 24 }}
    >
      {showHeader ? (
        <div className="account-header">
          <div className="account-panel-title">
            {embedded ? embeddedTitle : ""}
          </div>
          <div className="account-version">
            <div className="account-panel-title">Versie</div>
            <div className="account-version-value">{versionInfo?.version ?? "n/a"}</div>
          </div>
        </div>
      ) : null}

      <div className="account-grid">
        {showConnectionPanel ? (
          <div className="panel account-panel span-6">
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
                <div className="text-body">{connectionMessage}</div>
              )}
              <div className="status-badges">
                <Badge
                  label={`Koppeling: ${userStatus?.status ?? "CHECKING"}`}
                  tone={toneFromStatus(userStatus?.status)}
                />
              </div>
              <div className="account-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    window.location.href = "/api/auth/login";
                  }}
                >
                  Spotify login
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    window.location.href = "/api/auth/logout";
                  }}
                >
                  Spotify logout
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {showStatusPanel ? (
        <div className={`panel account-panel ${statusPanelSpan}`}>
          <div className="account-panel-title">
            {mode === "basic-core" ? "Bibliotheekoverzicht" : "Status"}
          </div>
          {showStatusMeta ? (
            <div className="status-badges">
              {statusBadgeItems.map((item) => (
                <Badge key={item.label} label={item.label} tone={item.tone} />
              ))}
            </div>
          ) : null}

          {showStatusMeta ? (
            <div className="text-body status-summary">
              <div>
                Laatst bijgewerkt:{" "}
                <time dateTime={dbStatus?.sync?.lastSuccessfulAt?.toString()}>
                  {lastSync}
                </time>
              </div>
              <div>
                Worker controle:{" "}
                <time dateTime={workerHealth?.lastHeartbeat?.toString()}>
                  {workerLast}
                </time>
              </div>
            </div>
          ) : null}
          <div className="sr-only" aria-live="polite">
            {runningInfo.label}
          </div>

          {showOverviewCounts ? (
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
          ) : null}
        </div>
        ) : null}

        {showActionPanel ? (
          <div className="panel account-panel span-3">
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
                className="btn btn-primary account-action-primary"
              >
                {syncing ? "Bijwerken..." : "Database bijwerken"}
              </button>
              <button onClick={logoutPin} className="btn btn-secondary">
                Uitloggen App
              </button>
            </div>
          </div>
        ) : null}

        <details className={`panel account-panel ${promptPanelSpan}`}>
          <summary className="details-summary">
            ChatGPT prompt
            <span aria-hidden="true">▾</span>
          </summary>
          <div className="text-body" style={{ marginTop: 12 }}>
            Pas de prompt aan die naar het klembord wordt gekopieerd.
          </div>
          <div className="text-subtle" style={{ marginTop: 8 }}>
            Variabelen (niet te bewerken):{" "}
            {CHATGPT_PROMPT_TOKEN_LABELS.map((entry) => (
              <div key={entry.token} style={{ marginTop: 4 }}>
                <code>{entry.token}</code>
                <span className="text-subtle" style={{ marginLeft: 8 }}>
                  {entry.label}
                </span>
              </div>
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

      {showResourcePanel ? <div className="account-divider span-12" /> : null}

      {showResourcePanel ? (
        <div className="panel account-panel span-12">
          <div className="account-panel-title">Lijst synchroniseren</div>
          <div className="text-body" style={{ marginBottom: 16 }}>
            Kies de lijst die je wilt synchroniseren en start direct.
          </div>

          {playlistSyncRows.length ? (
            <div className="account-sync-picker">
              <label className="account-sync-picker-field">
                <span className="text-subtle">Lijst</span>
                <select
                  className="input account-sync-select"
                  value={selectedSyncResource}
                  onChange={(event) => setSelectedSyncResource(event.target.value)}
                >
                  {playlistSyncRows.map((row) => (
                    <option key={row.resource} value={row.resource}>
                      {row.displayName}
                    </option>
                  ))}
                </select>
              </label>

              <div className="account-sync-picker-status">
                <Badge label={`Status: ${selectedSyncStatusLabel}`} tone={selectedSyncTone} />
                <span className="text-subtle">
                  Laatste sync:{" "}
                  {selectedSyncLastSuccessfulAt
                    ? new Date(selectedSyncLastSuccessfulAt).toLocaleString()
                    : "n/a"}
                </span>
                {selectedSyncRow?.lastErrorCode ? (
                  <span className="text-subtle">Foutcode: {selectedSyncRow.lastErrorCode}</span>
                ) : null}
                {selectedSyncUpdateState === "running" ? (
                  <span className="account-resource-spinner" aria-hidden="true" />
                ) : null}
              </div>

              <div className="account-sync-picker-actions">
                <button
                  className="btn btn-secondary account-resource-cta"
                  disabled={!selectedSyncPlaylistId || selectedSyncUpdateState === "running"}
                  onClick={async () => {
                    if (!selectedSyncPlaylistId) return;
                    await syncSelectedPlaylist(selectedSyncPlaylistId);
                  }}
                >
                  {selectedSyncUpdateState === "running" ? "Bezig..." : "Nu bijwerken"}
                </button>
              </div>
            </div>
          ) : (
            <div className="text-subtle">
              Nog geen synchroniseerbare lijsten gevonden. Start eerst een bibliotheek sync.
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
