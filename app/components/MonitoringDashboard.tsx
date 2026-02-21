"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import StatusBox from "./StatusBox";
import { clientFetch } from "@/lib/http/clientFetch";

type SummaryPayload = {
  generatedAt: number;
  meta?: {
    environment?: string | null;
  };
  authStatus: {
    status: string;
    scopes: string[];
    userId: string | null;
    appUserId: string | null;
    lastAuthAt: number | null;
  };
  tokenHealth: {
    expiresInSec: number | null;
    refreshSuccessRate: number;
    refreshAttempts: number;
    invalidGrantCount: number;
    lockWaitP95Ms: number;
    lastRefreshAt: number | null;
  };
  apiHealth: {
    successRate: number;
    latencyMs: { p50: number; p95: number; p99: number };
    errorBreakdown: Array<{ label: string; value: number }>;
    upstream5xx: number;
  };
  rateLimits: {
    count429: number;
    backoffState: string;
  };
  traffic: {
    requestsPerMin: number;
    topEndpoints: Array<{ endpoint: string; rpm: number }>;
    activeUsers: number | null;
  };
  callbackHealth: {
    enabled: boolean;
    latencyP95Ms: number | null;
    failures: number;
  };
  recentErrors: Array<{
    id: string;
    at: number;
    level: string;
    code: string;
    message: string;
    endpoint: string | null;
    correlationId: string;
  }>;
  incidents: {
    active: Array<{
      id: string;
      severity: "P0" | "P1" | "P2";
      title: string;
      startedAt: number;
    }>;
    runbookUrl: string;
  };
};

type UserStatusPayload = {
  status?: string;
  profile?: {
    id?: string | null;
    display_name?: string | null;
    email?: string | null;
    country?: string | null;
    product?: string | null;
  };
  correlationId?: string;
};

type Tone = "ok" | "warn" | "error";

type ActionHistoryItem = {
  id: string;
  name: string;
  outcome: "success" | "error";
  message: string;
  correlationId: string | null;
  at: number;
};

type Insight = {
  id: string;
  tone: Tone;
  title: string;
  text: string;
};

type DangerDialogState =
  | {
      kind: "clear-cache";
      acknowledged: boolean;
      confirmText: string;
    }
  | {
      kind: "deep-sync";
      acknowledged: boolean;
      confirmText: string;
    };

const ENDPOINT_LABEL_MAP: Record<string, { label: string; description: string }> = {
  me_player: {
    label: "Player bediening",
    description: "Play/pause/next/seek en spelerstatus.",
  },
  me_tracks: {
    label: "Liked Songs",
    description: "Lezen/schrijven van persoonlijke library-tracks.",
  },
  me_playlists: {
    label: "Playlists",
    description: "Playlistoverzicht ophalen en beheren.",
  },
  playlists_items: {
    label: "Playlist tracks",
    description: "Tracks binnen playlists laden en wijzigen.",
  },
  me_player_devices: {
    label: "Connect devices",
    description: "Beschikbare Spotify Connect apparaten ophalen.",
  },
  artists: {
    label: "Artiesten",
    description: "Artiest metadata en gerelateerde queries.",
  },
  tracks: {
    label: "Tracks",
    description: "Track metadata en trackgerichte requests.",
  },
  v1_me: {
    label: "Account profiel",
    description: "Controle op ingelogde Spotify gebruiker.",
  },
};

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function fmtPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtCompactTime(value: number | null) {
  if (!value) return "n/a";
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtDateTime(value: number | null) {
  if (!value) return "n/a";
  return new Date(value).toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function toneClass(tone: Tone) {
  return `ops-tone-${tone}`;
}

function pillClass(tone: Tone) {
  if (tone === "ok") return "pill pill-success";
  if (tone === "warn") return "pill pill-warn";
  return "pill pill-error";
}

function authTone(status: string): Tone {
  const normalized = status.trim().toUpperCase();
  if (
    normalized === "OK" ||
    normalized === "CONNECTED" ||
    normalized === "AUTHENTICATED" ||
    normalized === "READY"
  ) {
    return "ok";
  }
  if (
    normalized === "CHECKING" ||
    normalized === "REAUTH_REQUIRED" ||
    normalized === "PENDING" ||
    normalized === "UNKNOWN"
  ) {
    return "warn";
  }
  return "error";
}

function formatAuthStatus(status: string) {
  const normalized = status.trim().toUpperCase();
  if (normalized === "CONNECTED" || normalized === "OK") return "Verbonden";
  if (normalized === "REAUTH_REQUIRED") return "Herlogin nodig";
  if (normalized === "DISCONNECTED") return "Niet verbonden";
  if (normalized === "CHECKING") return "Controleren";
  return status;
}

function describeEndpoint(endpoint: string) {
  const raw = String(endpoint ?? "").trim();
  const key = raw.toLowerCase();
  const known = ENDPOINT_LABEL_MAP[key];
  if (known) {
    return {
      label: known.label,
      raw,
      title: `${known.label} (${raw}) - ${known.description}`,
    };
  }
  const normalized = raw
    .replace(/^\/+/, "")
    .replace(/^api\/spotify\//i, "")
    .replace(/^v1\//i, "")
    .replace(/^me[_/]/i, "")
    .replace(/[_/]+/g, " ")
    .trim();
  const label =
    normalized
      .split(" ")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || "Onbekend endpoint";

  return {
    label,
    raw,
    title: `${label} (${raw})`,
  };
}

function HelpTip({ label, text }: { label: string; text: string }) {
  const tipId = useId();
  return (
    <span className="ops-help-tip">
      <button
        type="button"
        className="ops-help-tip-btn"
        aria-label={`${label}: uitleg`}
        aria-describedby={tipId}
      >
        i
      </button>
      <span id={tipId} role="tooltip" className="ops-help-tip-popover">
        {text}
      </span>
    </span>
  );
}

function KpiCard({
  title,
  value,
  subtitle,
  tone,
  meter,
  hint,
}: {
  title: string;
  value: string;
  subtitle: string;
  tone: Tone;
  meter: number;
  hint: string;
}) {
  return (
    <article className={`ops-kpi ${toneClass(tone)}`}>
      <div className="ops-kpi-head">
        <span className="ops-kpi-title">{title}</span>
        <HelpTip label={title} text={hint} />
      </div>
      <div className="ops-kpi-value">{value}</div>
      <div className="ops-kpi-subtitle">{subtitle}</div>
      <div className="ops-kpi-meter" aria-hidden="true">
        <span style={{ width: `${Math.max(5, clamp01(meter) * 100)}%` }} />
      </div>
    </article>
  );
}

function AlertCard({ item }: { item: Insight }) {
  return (
    <article className={`ops-alert-card ${toneClass(item.tone)}`}>
      <span className={pillClass(item.tone)}>
        {item.tone === "ok" ? "Alles ok" : item.tone === "warn" ? "Let op" : "Actie nodig"}
      </span>
      <strong>{item.title}</strong>
      <p className="text-subtle">{item.text}</p>
    </article>
  );
}

function downloadJson(prefix: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${prefix}-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function MonitoringDashboard() {
  const [summary, setSummary] = useState<SummaryPayload | null>(null);
  const [userStatus, setUserStatus] = useState<UserStatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<null | string>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshIntervalSec, setRefreshIntervalSec] = useState(15);
  const [actionHistory, setActionHistory] = useState<ActionHistoryItem[]>([]);
  const [tokenRefreshCooldownUntil, setTokenRefreshCooldownUntil] = useState(0);
  const [dangerDialog, setDangerDialog] = useState<DangerDialogState | null>(null);
  const [dangerExpanded, setDangerExpanded] = useState(false);
  const dialogCancelRef = useRef<HTMLButtonElement | null>(null);

  const preferenceKey = useMemo(
    () => `gs_settings_page_preferences:v2:${summary?.authStatus.appUserId ?? "anon"}`,
    [summary?.authStatus.appUserId]
  );

  const refreshSummary = useCallback(async () => {
    const res = await clientFetch("/api/monitoring/summary");
    if (!res.ok) {
      throw new Error(`summary_http_${res.status}`);
    }
    const data = (await res.json()) as SummaryPayload;
    setSummary(data);
  }, []);

  const refreshUserStatus = useCallback(async () => {
    const res = await clientFetch("/api/spotify/user-status");
    if (!res.ok) {
      setUserStatus({ status: `ERROR_${res.status}` });
      return;
    }
    const data = (await res.json()) as UserStatusPayload;
    setUserStatus(data);
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      await Promise.all([refreshSummary(), refreshUserStatus()]);
      setRefreshError(null);
    } catch (err) {
      setRefreshError(String(err));
    } finally {
      setLoading(false);
    }
  }, [refreshSummary, refreshUserStatus]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!autoRefresh) return;
    const intervalMs = Math.max(5, refreshIntervalSec) * 1000;
    const timer = window.setInterval(() => {
      void refreshAll();
    }, intervalMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [autoRefresh, refreshAll, refreshIntervalSec]);

  useEffect(() => {
    const refreshNow = () => {
      void refreshAll();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refreshNow();
      }
    };
    window.addEventListener("focus", refreshNow);
    window.addEventListener("pageshow", refreshNow);
    window.addEventListener("online", refreshNow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refreshNow);
      window.removeEventListener("pageshow", refreshNow);
      window.removeEventListener("online", refreshNow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshAll]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(preferenceKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        showAdvanced?: boolean;
        autoRefresh?: boolean;
        refreshIntervalSec?: number;
      };
      if (typeof parsed.showAdvanced === "boolean") {
        setShowAdvanced(parsed.showAdvanced);
      }
      if (typeof parsed.autoRefresh === "boolean") {
        setAutoRefresh(parsed.autoRefresh);
      }
      if (
        typeof parsed.refreshIntervalSec === "number" &&
        Number.isFinite(parsed.refreshIntervalSec)
      ) {
        setRefreshIntervalSec(Math.max(5, Math.min(60, Math.floor(parsed.refreshIntervalSec))));
      }
    } catch {
      // ignore invalid payload
    }
  }, [preferenceKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      preferenceKey,
      JSON.stringify({
        showAdvanced,
        autoRefresh,
        refreshIntervalSec,
      })
    );
  }, [autoRefresh, preferenceKey, refreshIntervalSec, showAdvanced]);

  useEffect(() => {
    if (!dangerDialog) return;
    dialogCancelRef.current?.focus();
  }, [dangerDialog]);

  useEffect(() => {
    if (!dangerDialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && actionBusy === null) {
        setDangerDialog(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [dangerDialog, actionBusy]);

  const pushActionHistory = useCallback((entry: Omit<ActionHistoryItem, "id">) => {
    setActionHistory((prev) => {
      const next: ActionHistoryItem = {
        id: `${entry.at}-${Math.random().toString(16).slice(2, 8)}`,
        ...entry,
      };
      return [next, ...prev].slice(0, 12);
    });
  }, []);

  const runAction = useCallback(
    async (
      name: string,
      url: string,
      method: "GET" | "POST" = "POST",
      onSuccess?: (payload: unknown) => string
    ) => {
      setActionBusy(name);
      try {
        const res = await clientFetch(url, { method });
        const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const correlationId =
          typeof payload.correlationId === "string"
            ? payload.correlationId
            : res.headers.get("x-correlation-id");

        if (!res.ok) {
          const message =
            typeof payload.error === "string"
              ? payload.error
              : typeof payload.message === "string"
              ? payload.message
              : `http_${res.status}`;
          pushActionHistory({
            name,
            outcome: "error",
            message,
            correlationId,
            at: Date.now(),
          });
          return null;
        }

        const successMessage = onSuccess ? onSuccess(payload) : `${name} voltooid`;
        pushActionHistory({
          name,
          outcome: "success",
          message: successMessage,
          correlationId,
          at: Date.now(),
        });
        await refreshAll();
        return payload;
      } catch (err) {
        pushActionHistory({
          name,
          outcome: "error",
          message: String(err),
          correlationId: null,
          at: Date.now(),
        });
        return null;
      } finally {
        setActionBusy(null);
      }
    },
    [pushActionHistory, refreshAll]
  );

  const runBulkSync = useCallback(async () => {
    const name = "Bibliotheek bijwerken";
    setActionBusy(name);
    try {
      const steps: Array<{ type: string; payload?: Record<string, unknown> }> = [
        {
          type: "tracks_initial",
          payload: { offset: 0, limit: 50, maxPagesPerRun: 50 },
        },
        { type: "playlists" },
        { type: "artists" },
        { type: "track_metadata" },
        { type: "covers" },
      ];

      let lastCorrelationId: string | null = null;
      for (const step of steps) {
        const res = await clientFetch("/api/spotify/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: step.type,
            ...(step.payload ? { payload: step.payload } : {}),
          }),
        });
        const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const correlationId =
          typeof payload.correlationId === "string"
            ? payload.correlationId
            : res.headers.get("x-correlation-id");
        if (correlationId) {
          lastCorrelationId = correlationId;
        }

        if (!res.ok) {
          throw new Error(
            typeof payload.error === "string"
              ? payload.error
              : `SYNC_${step.type}_${res.status}`
          );
        }
      }

      pushActionHistory({
        name,
        outcome: "success",
        message: "Synchronisatie gestart voor tracks, playlists, artiesten en covers.",
        correlationId: lastCorrelationId,
        at: Date.now(),
      });
      await refreshAll();
      return true;
    } catch (err) {
      pushActionHistory({
        name,
        outcome: "error",
        message: String(err),
        correlationId: null,
        at: Date.now(),
      });
      return false;
    } finally {
      setActionBusy(null);
    }
  }, [pushActionHistory, refreshAll]);

  const runDiagnosticsExport = useCallback(async () => {
    const payload = await runAction(
      "Diagnostics export",
      "/api/monitoring/diagnostics",
      "GET",
      () => "Diagnoserapport gedownload"
    );
    if (!payload) return;
    downloadJson("gsplayer-diagnostics", payload);
  }, [runAction]);

  const copyDebugBundle = useCallback(async () => {
    const name = "Debug bundle kopieeren";
    setActionBusy(name);
    try {
      const res = await clientFetch("/api/monitoring/diagnostics", { method: "GET" });
      const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const correlationId =
        typeof payload.correlationId === "string"
          ? payload.correlationId
          : res.headers.get("x-correlation-id");

      if (!res.ok) {
        pushActionHistory({
          name,
          outcome: "error",
          message: typeof payload.error === "string" ? payload.error : `http_${res.status}`,
          correlationId,
          at: Date.now(),
        });
        return;
      }

      if (!navigator.clipboard?.writeText) {
        pushActionHistory({
          name,
          outcome: "error",
          message: "Clipboard niet beschikbaar op dit apparaat.",
          correlationId,
          at: Date.now(),
        });
        return;
      }

      await navigator.clipboard.writeText(JSON.stringify(payload));
      pushActionHistory({
        name,
        outcome: "success",
        message: "Debug bundle naar klembord gekopieerd.",
        correlationId,
        at: Date.now(),
      });
    } catch (err) {
      pushActionHistory({
        name,
        outcome: "error",
        message: String(err),
        correlationId: null,
        at: Date.now(),
      });
    } finally {
      setActionBusy(null);
    }
  }, [pushActionHistory]);

  const summaryAvailable = Boolean(summary);

  const authStatus = summary?.authStatus.status ?? "CHECKING";
  const authStatusLabel = formatAuthStatus(authStatus);
  const authStatusTone = authTone(authStatus);

  const tokenExpirySec = summary?.tokenHealth.expiresInSec ?? null;
  const tokenTone: Tone =
    tokenExpirySec == null
      ? "warn"
      : tokenExpirySec > 900
      ? "ok"
      : tokenExpirySec > 240
      ? "warn"
      : "error";

  const apiTone: Tone =
    (summary?.apiHealth.successRate ?? 0) >= 0.97
      ? "ok"
      : (summary?.apiHealth.successRate ?? 0) >= 0.9
      ? "warn"
      : "error";

  const latencyTone: Tone =
    (summary?.apiHealth.latencyMs.p95 ?? 0) <= 450
      ? "ok"
      : (summary?.apiHealth.latencyMs.p95 ?? 0) <= 900
      ? "warn"
      : "error";

  const rateTone: Tone =
    (summary?.rateLimits.count429 ?? 0) === 0
      ? "ok"
      : (summary?.rateLimits.count429 ?? 0) < 5
      ? "warn"
      : "error";

  const topErrors = useMemo(() => {
    const rows = summary?.apiHealth.errorBreakdown ?? [];
    return (showAdvanced ? rows.slice(0, 12) : rows.slice(0, 6)).filter((row) => row.value > 0);
  }, [showAdvanced, summary?.apiHealth.errorBreakdown]);

  const maxErrorCount = useMemo(
    () => Math.max(1, ...topErrors.map((row) => row.value)),
    [topErrors]
  );

  const visibleRecentErrors = useMemo(() => {
    const rows = summary?.recentErrors ?? [];
    return showAdvanced ? rows.slice(0, 18) : rows.slice(0, 8);
  }, [showAdvanced, summary?.recentErrors]);

  const environmentLabel =
    summary?.meta?.environment && summary.meta.environment.trim()
      ? summary.meta.environment
      : "production";

  const now = Date.now();
  const tokenRefreshCooldownLeftSec = Math.max(
    0,
    Math.ceil((tokenRefreshCooldownUntil - now) / 1000)
  );

  const insights = useMemo<Insight[]>(() => {
    if (!summary) return [];
    const list: Insight[] = [];

    if (authStatusTone === "error") {
      list.push({
        id: "auth-error",
        tone: "error",
        title: "Spotify koppeling is niet actief",
        text: "Gebruik 'Spotify opnieuw koppelen' om direct te herstellen.",
      });
    } else if (authStatusTone === "warn") {
      list.push({
        id: "auth-warn",
        tone: "warn",
        title: "Koppeling vereist aandacht",
        text: "Login of tokencontrole loopt; sommige acties kunnen vertraagd reageren.",
      });
    }

    if (summary.tokenHealth.invalidGrantCount > 0) {
      list.push({
        id: "invalid-grant",
        tone: "error",
        title: "Token is geweigerd door Spotify",
        text: "Herlogin is nodig om weer stabiel te kunnen afspelen en synchroniseren.",
      });
    } else if (summary.tokenHealth.refreshSuccessRate < 0.95) {
      list.push({
        id: "token-refresh",
        tone: "warn",
        title: "Token ververst niet altijd direct",
        text: "Gebruik 'Token vernieuwen' als je merkt dat devices of playback achterlopen.",
      });
    }

    if (summary.rateLimits.count429 >= 5) {
      list.push({
        id: "rate-hard",
        tone: "error",
        title: "Spotify rate limit blokkeert requests",
        text: `Er zijn ${summary.rateLimits.count429} blokkades gemeten; wacht kort en herhaal acties niet te snel.`,
      });
    } else if (summary.rateLimits.count429 > 0) {
      list.push({
        id: "rate-soft",
        tone: "warn",
        title: "Spotify rate limit actief",
        text: `Er zijn ${summary.rateLimits.count429} tijdelijke blokkades gemeten; app vangt dit op met backoff.`,
      });
    }

    if (summary.apiHealth.successRate < 0.9 || summary.apiHealth.upstream5xx > 0) {
      list.push({
        id: "api-health",
        tone: summary.apiHealth.successRate < 0.85 ? "error" : "warn",
        title: "Spotify API is niet volledig stabiel",
        text: `Succesratio is ${fmtPercent(summary.apiHealth.successRate)} met ${summary.apiHealth.upstream5xx} serverfouten.`,
      });
    }

    if (summary.incidents.active.length > 0) {
      list.push({
        id: "incidents",
        tone: "error",
        title: `${summary.incidents.active.length} actieve incident${
          summary.incidents.active.length === 1 ? "" : "en"
        }`,
        text: "Open het runbook voor herstelstappen en incident-opvolging.",
      });
    }

    if (!list.length) {
      list.push({
        id: "healthy",
        tone: "ok",
        title: "Systeem is stabiel",
        text: "Koppeling, API en synchronisatie zien er gezond uit.",
      });
    }

    return list.slice(0, showAdvanced ? 8 : 5);
  }, [authStatusTone, showAdvanced, summary]);

  const dangerClearReady =
    dangerDialog?.kind === "clear-cache" &&
    dangerDialog.acknowledged &&
    dangerDialog.confirmText.trim().toUpperCase() === "RESET";

  const dangerSyncReady =
    dangerDialog?.kind === "deep-sync" &&
    dangerDialog.acknowledged &&
    dangerDialog.confirmText.trim().toUpperCase() === "SYNC";

  return (
    <main className="page settings-page ops-page">
      <section className="card ops-shell" style={{ marginTop: 24 }}>
        <header className="ops-header">
          <div className="ops-header-copy">
            <h1 className="ops-title">Settings & Monitoring</h1>
            <p className="text-subtle ops-subtitle">
              Een gebruiksvriendelijke cockpit voor status, foutmeldingen en herstelacties.
            </p>
          </div>

          <div className="ops-header-controls">
            <span className={pillClass(authStatusTone)}>Koppeling: {authStatusLabel}</span>
            <span className="ops-meta-item">
              Omgeving <strong>{environmentLabel}</strong>
            </span>
            <span className="ops-meta-item">
              Laatste update <strong>{summary ? fmtCompactTime(summary.generatedAt) : "..."}</strong>
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void refreshAll()}
              disabled={loading || actionBusy !== null}
            >
              {loading ? "Laden..." : "Nu verversen"}
            </button>
          </div>
        </header>

        {refreshError ? (
          <div className="ops-inline-alert ops-tone-warn" role="status" aria-live="polite">
            Laatste update deels mislukt: {refreshError}. Bestaande data blijft zichtbaar.
          </div>
        ) : null}

        {loading && !summaryAvailable ? <p className="text-body">Pagina laden...</p> : null}

        {summaryAvailable ? (
          <>
            <section className="ops-kpi-grid">
              <KpiCard
                title="Koppeling"
                value={authStatusLabel}
                subtitle={summary?.authStatus.userId ?? "geen gebruiker"}
                tone={authStatusTone}
                meter={authStatusTone === "ok" ? 1 : authStatusTone === "warn" ? 0.55 : 0.2}
                hint="Geeft aan of Spotify-auth direct bruikbaar is voor playback en device-acties."
              />

              <KpiCard
                title="API betrouwbaarheid"
                value={fmtPercent(summary?.apiHealth.successRate ?? 0)}
                subtitle={`${summary?.apiHealth.upstream5xx ?? 0} Spotify serverfouten`}
                tone={apiTone}
                meter={summary?.apiHealth.successRate ?? 0}
                hint="Percentage succesvolle Spotify-requests in de actuele meting."
              />

              <KpiCard
                title="Reactiesnelheid"
                value={`${summary?.apiHealth.latencyMs.p95 ?? 0} ms`}
                subtitle={`p99 ${summary?.apiHealth.latencyMs.p99 ?? 0} ms`}
                tone={latencyTone}
                meter={1 - clamp01((summary?.apiHealth.latencyMs.p95 ?? 0) / 1800)}
                hint="Snelheid van trage requests; hoge waarde kan hikken in de UX geven."
              />

              <KpiCard
                title="Rate limit"
                value={`${summary?.rateLimits.count429 ?? 0}`}
                subtitle={summary?.rateLimits.backoffState || "geen backoff"}
                tone={rateTone}
                meter={1 - clamp01((summary?.rateLimits.count429 ?? 0) / 20)}
                hint="Aantal 429 responses van Spotify. Bij hogere waarden worden acties vertraagd."
              />

              <KpiCard
                title="Token gezondheid"
                value={
                  summary?.tokenHealth.expiresInSec == null
                    ? "n/a"
                    : `${summary.tokenHealth.expiresInSec}s`
                }
                subtitle={`Refresh ${fmtPercent(summary?.tokenHealth.refreshSuccessRate ?? 0)}`}
                tone={tokenTone}
                meter={
                  summary?.tokenHealth.expiresInSec == null
                    ? 0.4
                    : summary.tokenHealth.expiresInSec / 3600
                }
                hint="Toont resterende tokenduur en hoe stabiel automatische refresh werkt."
              />
            </section>

            <section className="ops-insights">
              <div className="ops-section-head">
                <h2 className="ops-section-title">Wat vraagt nu aandacht?</h2>
                <HelpTip
                  label="Aandacht"
                  text="Fouten worden geprioriteerd op impact: groen = ok, oranje = mogelijk issue, rood = directe actie."
                />
              </div>
              <div className="ops-insight-grid">
                {insights.map((item) => (
                  <AlertCard key={item.id} item={item} />
                ))}
              </div>
            </section>

            <section className="ops-main-grid" aria-label="Settings en acties">
              <article className="panel ops-panel span-8">
                <div className="ops-section-head">
                  <h3 className="ops-section-title">Snelle acties</h3>
                  <HelpTip
                    label="Snelle acties"
                    text="Veilige acties voor dagelijks gebruik. Deze acties herstellen de meeste problemen zonder risico."
                  />
                </div>
                <div className="ops-action-grid">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      window.location.href = "/api/auth/login";
                    }}
                    disabled={actionBusy !== null}
                  >
                    Spotify opnieuw koppelen
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={actionBusy !== null || tokenRefreshCooldownLeftSec > 0}
                    onClick={async () => {
                      const payload = await runAction(
                        "Token vernieuwen",
                        "/api/monitoring/token/refresh",
                        "POST",
                        () => "Token vernieuwd"
                      );
                      if (payload) {
                        setTokenRefreshCooldownUntil(Date.now() + 10_000);
                      }
                    }}
                  >
                    {tokenRefreshCooldownLeftSec > 0
                      ? `Wacht ${tokenRefreshCooldownLeftSec}s`
                      : actionBusy === "Token vernieuwen"
                      ? "Bezig..."
                      : "Token vernieuwen"}
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={actionBusy !== null}
                    onClick={() => void runAction("API test", "/api/monitoring/test-api", "POST")}
                  >
                    {actionBusy === "API test" ? "Bezig..." : "Verbinding testen"}
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={actionBusy !== null}
                    onClick={async () => {
                      const ok = window.confirm(
                        "Bibliotheek bijwerken kan kort extra belasting geven. Nu starten?"
                      );
                      if (!ok) return;
                      await runBulkSync();
                    }}
                  >
                    {actionBusy === "Bibliotheek bijwerken" ? "Bezig..." : "Bibliotheek bijwerken"}
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={actionBusy !== null}
                    onClick={() => void runDiagnosticsExport()}
                  >
                    {actionBusy === "Diagnostics export" ? "Bezig..." : "Diagnose export"}
                  </button>

                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={actionBusy !== null}
                    onClick={async () => {
                      const ok = window.confirm("Uitloggen sluit de app sessie. Doorgaan?");
                      if (!ok) return;
                      setActionBusy("App uitloggen");
                      try {
                        await clientFetch("/api/pin-logout", { method: "POST" });
                      } finally {
                        window.location.href = "/login";
                      }
                    }}
                  >
                    Uitloggen app
                  </button>
                </div>
              </article>

              <article className="panel ops-panel span-4">
                <div className="ops-section-head">
                  <h3 className="ops-section-title">Koppeling details</h3>
                  <HelpTip
                    label="Koppeling details"
                    text="Kerninformatie over de actieve Spotify gebruiker en sessiegezondheid."
                  />
                </div>
                <div className="ops-keyvalue-list">
                  <div className="ops-keyvalue-row">
                    <span className="text-subtle">Status</span>
                    <span className={pillClass(authStatusTone)}>{authStatusLabel}</span>
                  </div>
                  <div className="ops-keyvalue-row">
                    <span className="text-subtle">Spotify gebruiker</span>
                    <strong>{summary?.authStatus.userId ?? "n/a"}</strong>
                  </div>
                  <div className="ops-keyvalue-row">
                    <span className="text-subtle">Profiel</span>
                    <strong>
                      {userStatus?.profile?.display_name ??
                        userStatus?.profile?.id ??
                        userStatus?.status ??
                        "n/a"}
                    </strong>
                  </div>
                  <div className="ops-keyvalue-row">
                    <span className="text-subtle">Laatst geauthenticeerd</span>
                    <strong>{fmtDateTime(summary?.authStatus.lastAuthAt ?? null)}</strong>
                  </div>
                  <div className="ops-keyvalue-row">
                    <span className="text-subtle">Actieve scopes</span>
                    <strong>{summary?.authStatus.scopes.length ?? 0}</strong>
                  </div>
                  <div className="ops-keyvalue-row">
                    <span className="text-subtle">Verkeer/min</span>
                    <strong>{summary?.traffic.requestsPerMin ?? 0}</strong>
                  </div>
                </div>
              </article>

              <article className="panel ops-panel span-6">
                <div className="ops-section-head">
                  <h3 className="ops-section-title">Foutmix</h3>
                  <HelpTip
                    label="Foutmix"
                    text="Toont waar fouten ontstaan. Gebruik dit om gerichte herstelacties te kiezen."
                  />
                </div>
                {topErrors.length ? (
                  <div className="ops-mix-list">
                    {topErrors.map((row) => {
                      const endpointMeta = describeEndpoint(row.label);
                      return (
                        <div key={row.label} className="ops-mix-row" title={endpointMeta.title}>
                          <div className="ops-mix-label">
                            <span className="ops-mix-main">{endpointMeta.label}</span>
                            <span className="ops-mix-raw">{endpointMeta.raw}</span>
                          </div>
                          <div className="ops-mix-meter" aria-hidden="true">
                            <span style={{ width: `${Math.max(4, (row.value / maxErrorCount) * 100)}%` }} />
                          </div>
                          <div className="ops-mix-value">{row.value}</div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-subtle">Geen fouten in de huidige meting.</div>
                )}
              </article>

              <article className="panel ops-panel span-6">
                <div className="ops-section-head">
                  <h3 className="ops-section-title">Recente fouten</h3>
                  <HelpTip
                    label="Recente fouten"
                    text="Laatste gebeurtenissen met basisuitleg. Schakel advanced in voor technische details."
                  />
                </div>
                {visibleRecentErrors.length ? (
                  <div className="ops-recent-list" role="status" aria-live="polite">
                    {visibleRecentErrors.map((item) => {
                      const endpoint = describeEndpoint(item.endpoint ?? "onbekend");
                      return (
                        <div key={item.id} className="ops-recent-row">
                          <div className="ops-recent-top">
                            <span className="ops-recent-time">{fmtCompactTime(item.at)}</span>
                            <span className="ops-recent-code">{item.code}</span>
                          </div>
                          <strong>{endpoint.label}</strong>
                          <div className="text-subtle">{item.message}</div>
                          {showAdvanced ? (
                            <div className="ops-recent-extra">corr: {item.correlationId}</div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-subtle">Geen recente fouten.</div>
                )}
              </article>

              <article className="panel ops-panel span-4">
                <div className="ops-section-head">
                  <h3 className="ops-section-title">Weergave & updates</h3>
                  <HelpTip
                    label="Weergave"
                    text="Kies hoe vaak de pagina ververst en of je geavanceerde tools wilt tonen."
                  />
                </div>

                <div className="ops-settings-list">
                  <label className="ops-switch-row">
                    <span>Automatisch verversen</span>
                    <input
                      type="checkbox"
                      checked={autoRefresh}
                      onChange={(event) => setAutoRefresh(event.target.checked)}
                    />
                  </label>

                  <label className="ops-input-row">
                    <span>Refresh interval</span>
                    <select
                      className="input"
                      value={String(refreshIntervalSec)}
                      disabled={!autoRefresh}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value)) {
                          setRefreshIntervalSec(Math.max(5, Math.min(60, Math.floor(value))));
                        }
                      }}
                    >
                      <option value="5">5 seconden</option>
                      <option value="10">10 seconden</option>
                      <option value="15">15 seconden</option>
                      <option value="30">30 seconden</option>
                      <option value="60">60 seconden</option>
                    </select>
                  </label>

                  <label className="ops-switch-row">
                    <span>Toon geavanceerde tools</span>
                    <input
                      type="checkbox"
                      checked={showAdvanced}
                      onChange={(event) => setShowAdvanced(event.target.checked)}
                    />
                  </label>
                </div>
              </article>

              <article className="panel ops-panel span-8">
                <div className="ops-section-head">
                  <h3 className="ops-section-title">Actiehistorie</h3>
                  <HelpTip
                    label="Actiehistorie"
                    text="Laatste uitgevoerde acties met resultaat. Handig voor snelle terugkoppeling na een fix."
                  />
                </div>

                {actionHistory.length ? (
                  <div className="ops-history-list">
                    {actionHistory.map((entry) => (
                      <div key={entry.id} className="ops-history-row">
                        <div className="ops-history-top">
                          <span className={entry.outcome === "success" ? "pill pill-success" : "pill pill-error"}>
                            {entry.outcome === "success" ? "Gelukt" : "Mislukt"}
                          </span>
                          <span className="ops-recent-time">{fmtCompactTime(entry.at)}</span>
                        </div>
                        <strong>{entry.name}</strong>
                        <div className="text-subtle">{entry.message}</div>
                        {showAdvanced && entry.correlationId ? (
                          <div className="ops-recent-extra">corr: {entry.correlationId}</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-subtle">Nog geen acties uitgevoerd in deze sessie.</div>
                )}
              </article>
            </section>

            <section className="panel ops-panel ops-advanced-wrap">
              <button
                type="button"
                className="ops-advanced-toggle"
                onClick={() => setDangerExpanded((prev) => !prev)}
                aria-expanded={dangerExpanded}
              >
                {dangerExpanded ? "Geavanceerde tools verbergen" : "Geavanceerde tools tonen"}
              </button>

              {dangerExpanded ? (
                <div className="ops-advanced-body">
                  <div className="ops-advanced-actions">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={actionBusy !== null}
                      onClick={async () => {
                        const payload = await runAction(
                          "Error export",
                          "/api/monitoring/errors/export",
                          "GET",
                          () => "Error export opgebouwd"
                        );
                        if (!payload) return;
                        downloadJson("gsplayer-errors", payload);
                      }}
                    >
                      {actionBusy === "Error export" ? "Bezig..." : "Exporteer error details"}
                    </button>

                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={actionBusy !== null}
                      onClick={() => void copyDebugBundle()}
                    >
                      {actionBusy === "Debug bundle kopieeren"
                        ? "Bezig..."
                        : "Kopieer debug bundle"}
                    </button>

                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={actionBusy !== null}
                      onClick={() =>
                        setDangerDialog({
                          kind: "clear-cache",
                          acknowledged: false,
                          confirmText: "",
                        })
                      }
                    >
                      Cache reset (gevaarlijk)
                    </button>

                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={actionBusy !== null}
                      onClick={() =>
                        setDangerDialog({
                          kind: "deep-sync",
                          acknowledged: false,
                          confirmText: "",
                        })
                      }
                    >
                      Diepe synchronisatie (gevaarlijk)
                    </button>
                  </div>

                  {summary?.incidents.active.length ? (
                    <div className="ops-incident-rail">
                      <span className="pill pill-error">
                        {summary.incidents.active.length} actieve incident{summary.incidents.active.length === 1 ? "" : "en"}
                      </span>
                      <a className="btn btn-secondary" href={summary.incidents.runbookUrl || "#"}>
                        Open runbook
                      </a>
                    </div>
                  ) : null}

                  {showAdvanced ? <StatusBox embedded mode="advanced-settings" /> : null}
                </div>
              ) : null}
            </section>
          </>
        ) : null}
      </section>

      {dangerDialog ? (
        <div className="settings-danger-modal-backdrop" role="presentation">
          <div
            className="settings-danger-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-danger-dialog-title"
          >
            {dangerDialog.kind === "clear-cache" ? (
              <>
                <h2 id="settings-danger-dialog-title" className="settings-danger-modal-title">
                  Bevestig cache reset
                </h2>
                <p className="text-subtle">
                  Deze actie wist monitoring-metrics en recente errors. Alleen gebruiken bij
                  troubleshooting.
                </p>

                <label className="ops-switch-row settings-modal-row">
                  <span>Ik begrijp de impact van deze reset.</span>
                  <input
                    type="checkbox"
                    checked={dangerDialog.acknowledged}
                    onChange={(event) =>
                      setDangerDialog({
                        ...dangerDialog,
                        acknowledged: event.target.checked,
                      })
                    }
                  />
                </label>

                <label className="ops-input-row settings-modal-row">
                  <span>Typ RESET om te bevestigen</span>
                  <input
                    type="text"
                    className="input"
                    value={dangerDialog.confirmText}
                    onChange={(event) =>
                      setDangerDialog({
                        ...dangerDialog,
                        confirmText: event.target.value,
                      })
                    }
                  />
                </label>

                <div className="settings-danger-modal-actions">
                  <button
                    ref={dialogCancelRef}
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setDangerDialog(null)}
                    disabled={actionBusy !== null}
                  >
                    Annuleren
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={!dangerClearReady || actionBusy !== null}
                    onClick={async () => {
                      const payload = await runAction(
                        "Cache legen",
                        "/api/monitoring/cache/clear",
                        "POST",
                        () => "Cache reset uitgevoerd"
                      );
                      if (payload) {
                        setDangerDialog(null);
                      }
                    }}
                  >
                    {actionBusy === "Cache legen" ? "Bezig..." : "Definitief resetten"}
                  </button>
                </div>
              </>
            ) : null}

            {dangerDialog.kind === "deep-sync" ? (
              <>
                <h2 id="settings-danger-dialog-title" className="settings-danger-modal-title">
                  Bevestig diepe synchronisatie
                </h2>
                <p className="text-subtle">
                  Deze run start een volledige sync voor tracks, playlists, artiesten, metadata en
                  covers. Dit kan tijdelijk extra load geven.
                </p>

                <label className="ops-switch-row settings-modal-row">
                  <span>Ik begrijp de operationele impact van deze actie.</span>
                  <input
                    type="checkbox"
                    checked={dangerDialog.acknowledged}
                    onChange={(event) =>
                      setDangerDialog({
                        ...dangerDialog,
                        acknowledged: event.target.checked,
                      })
                    }
                  />
                </label>

                <label className="ops-input-row settings-modal-row">
                  <span>Typ SYNC om te bevestigen</span>
                  <input
                    type="text"
                    className="input"
                    value={dangerDialog.confirmText}
                    onChange={(event) =>
                      setDangerDialog({
                        ...dangerDialog,
                        confirmText: event.target.value,
                      })
                    }
                  />
                </label>

                <div className="settings-danger-modal-actions">
                  <button
                    ref={dialogCancelRef}
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setDangerDialog(null)}
                    disabled={actionBusy !== null}
                  >
                    Annuleren
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={!dangerSyncReady || actionBusy !== null}
                    onClick={async () => {
                      const ok = await runBulkSync();
                      if (ok) {
                        setDangerDialog(null);
                      }
                    }}
                  >
                    {actionBusy === "Bibliotheek bijwerken" ? "Bezig..." : "Definitief starten"}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}
