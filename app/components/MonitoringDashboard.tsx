"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
    images?: Array<{ url?: string | null }>;
  };
  correlationId?: string;
};

type Tone = "ok" | "warn" | "error";
type ViewMode = "standard" | "advanced";
type SectionKey = "monitoring" | "settings" | "actions";

type ActionHistoryItem = {
  id: string;
  name: string;
  outcome: "success" | "error";
  message: string;
  correlationId: string | null;
  at: number;
};

type DangerDialogState =
  | {
      kind: "clear-cache";
      acknowledged: boolean;
      confirmText: string;
    }
  | {
      kind: "bulk-sync";
      step: 1 | 2;
      acknowledged: boolean;
      confirmText: string;
    };

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

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
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

function toneByThreshold(value: number, okFrom: number, warnFrom: number): Tone {
  if (value >= okFrom) return "ok";
  if (value >= warnFrom) return "warn";
  return "error";
}

function pillClass(tone: Tone) {
  if (tone === "ok") return "pill pill-success";
  if (tone === "warn") return "pill pill-warn";
  return "pill pill-error";
}

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
    <span className="settings-help-tip">
      <button
        type="button"
        className="settings-help-tip-btn"
        aria-label={`${label}: uitleg`}
        aria-describedby={tipId}
      >
        i
      </button>
      <span id={tipId} role="tooltip" className="settings-help-tip-popover">
        {text}
      </span>
    </span>
  );
}

function MetricCard({
  label,
  value,
  subtitle,
  tone,
  meter,
  hint,
}: {
  label: string;
  value: string;
  subtitle?: string;
  tone: Tone;
  meter?: number | null;
  hint: string;
}) {
  return (
    <article className={`monitoring-metric monitoring-tone-${tone} settings-redesign-metric`}>
      <div className="settings-metric-label-row">
        <div className="monitoring-metric-label">{label}</div>
        <HelpTip label={label} text={hint} />
      </div>
      <div className="monitoring-metric-value">{value}</div>
      {subtitle ? <div className="monitoring-metric-subtitle">{subtitle}</div> : null}
      {meter != null ? (
        <div className="monitoring-meter" aria-hidden="true">
          <span style={{ width: `${Math.max(4, clamp01(meter) * 100)}%` }} />
        </div>
      ) : null}
    </article>
  );
}

function DataPanel({
  title,
  hint,
  span,
  children,
}: {
  title: string;
  hint: string;
  span: "4" | "6" | "8" | "12";
  children: ReactNode;
}) {
  return (
    <article className={`panel monitoring-panel monitoring-span-${span} settings-redesign-panel`}>
      <div className="settings-panel-title-row">
        <div className="account-panel-title">{title}</div>
        <HelpTip label={title} text={hint} />
      </div>
      {children}
    </article>
  );
}

function SectionTabButton({
  tab,
  active,
  onClick,
}: {
  tab: { key: SectionKey; label: string };
  active: boolean;
  onClick: (key: SectionKey) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`settings-tab-${tab.key}`}
      aria-controls={`settings-panel-${tab.key}`}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={`settings-section-tab-btn${active ? " active" : ""}`}
      onClick={() => onClick(tab.key)}
    >
      {tab.label}
    </button>
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
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<null | string>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("standard");
  const [activeSection, setActiveSection] = useState<SectionKey>("monitoring");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshIntervalSec, setRefreshIntervalSec] = useState(10);
  const [dangerExpanded, setDangerExpanded] = useState(false);
  const [dangerDialog, setDangerDialog] = useState<DangerDialogState | null>(null);
  const [actionHistory, setActionHistory] = useState<ActionHistoryItem[]>([]);
  const [tokenRefreshCooldownUntil, setTokenRefreshCooldownUntil] = useState(0);
  const dialogCancelRef = useRef<HTMLButtonElement | null>(null);

  const preferenceKey = useMemo(
    () => `gs_settings_page_preferences:${summary?.authStatus.appUserId ?? "anon"}`,
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
      setError(null);
    } catch (err) {
      setError(String(err));
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
        viewMode?: ViewMode;
        activeSection?: SectionKey;
        autoRefresh?: boolean;
        refreshIntervalSec?: number;
      };
      if (parsed.viewMode === "standard" || parsed.viewMode === "advanced") {
        setViewMode(parsed.viewMode);
      }
      if (
        parsed.activeSection === "monitoring" ||
        parsed.activeSection === "settings" ||
        parsed.activeSection === "actions"
      ) {
        setActiveSection(parsed.activeSection);
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
      // ignore invalid preference payloads
    }
  }, [preferenceKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload = {
      viewMode,
      activeSection,
      autoRefresh,
      refreshIntervalSec,
    };
    window.localStorage.setItem(preferenceKey, JSON.stringify(payload));
  }, [activeSection, autoRefresh, preferenceKey, refreshIntervalSec, viewMode]);

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
      onSuccess?: (payload: any) => string
    ) => {
      setActionBusy(name);
      try {
        const res = await clientFetch(url, { method });
        const payload = await res.json().catch(() => ({}));
        const correlationId =
          typeof payload?.correlationId === "string"
            ? payload.correlationId
            : res.headers.get("x-correlation-id");

        if (!res.ok) {
          const message =
            typeof payload?.error === "string"
              ? payload.error
              : typeof payload?.message === "string"
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
    const name = "Volledige synchronisatie";
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
        const payload = await res.json().catch(() => ({}));
        const correlationId =
          typeof payload?.correlationId === "string"
            ? payload.correlationId
            : res.headers.get("x-correlation-id");
        if (correlationId) {
          lastCorrelationId = correlationId;
        }
        if (!res.ok) {
          throw new Error(
            typeof payload?.error === "string"
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

  const apiTone = toneByThreshold(summary?.apiHealth.successRate ?? 0, 0.97, 0.9);
  const latencyTone: Tone =
    (summary?.apiHealth.latencyMs.p95 ?? 0) <= 450
      ? "ok"
      : (summary?.apiHealth.latencyMs.p95 ?? 0) <= 900
      ? "warn"
      : "error";

  const topEndpoints = useMemo(() => {
    const rows = summary?.traffic.topEndpoints ?? [];
    return viewMode === "standard" ? rows.slice(0, 5) : rows.slice(0, 10);
  }, [summary?.traffic.topEndpoints, viewMode]);

  const topEndpointRpm = useMemo(
    () => Math.max(1, ...topEndpoints.map((row) => row.rpm)),
    [topEndpoints]
  );

  const topErrors = useMemo(() => {
    const rows = summary?.apiHealth.errorBreakdown ?? [];
    return viewMode === "standard" ? rows.slice(0, 3) : rows.slice(0, 8);
  }, [summary?.apiHealth.errorBreakdown, viewMode]);

  const maxErrorCount = useMemo(
    () => Math.max(1, ...topErrors.map((row) => row.value)),
    [topErrors]
  );

  const visibleRecentErrors = useMemo(() => {
    const rows = summary?.recentErrors ?? [];
    return viewMode === "standard" ? rows.slice(0, 6) : rows.slice(0, 16);
  }, [summary?.recentErrors, viewMode]);

  const environmentLabel =
    summary?.meta?.environment && summary.meta.environment.trim()
      ? summary.meta.environment
      : "production";

  const now = Date.now();
  const tokenRefreshCooldownLeftSec = Math.max(
    0,
    Math.ceil((tokenRefreshCooldownUntil - now) / 1000)
  );

  const sectionTabs: Array<{ key: SectionKey; label: string }> = [
    { key: "monitoring", label: "Monitoring" },
    { key: "settings", label: "Settings" },
    { key: "actions", label: "Acties" },
  ];

  const dangerClearReady =
    dangerDialog?.kind === "clear-cache" &&
    dangerDialog.acknowledged &&
    dangerDialog.confirmText.trim().toUpperCase() === "RESET";

  const dangerSyncReady =
    dangerDialog?.kind === "bulk-sync" &&
    dangerDialog.step === 2 &&
    dangerDialog.acknowledged &&
    dangerDialog.confirmText.trim().toUpperCase() === "SYNC";

  return (
    <main className="page settings-page monitoring-page settings-redesign-page">
      <section className="card settings-redesign-shell" style={{ marginTop: 24 }}>
        <header className="settings-redesign-header">
          <div className="settings-redesign-header-copy">
            <h1 className="settings-redesign-title">Settings</h1>
            <p className="text-subtle settings-redesign-subtitle">
              Monitoring en beheer van de Spotify-koppeling met veilige standaardinstellingen.
            </p>
          </div>

          <div className="settings-redesign-header-controls">
            <div className="settings-mode-toggle" role="group" aria-label="Complexiteitsniveau">
              <button
                type="button"
                className={`settings-mode-toggle-btn${viewMode === "standard" ? " active" : ""}`}
                onClick={() => setViewMode("standard")}
                aria-pressed={viewMode === "standard"}
              >
                Standard
              </button>
              <button
                type="button"
                className={`settings-mode-toggle-btn${viewMode === "advanced" ? " active" : ""}`}
                onClick={() => setViewMode("advanced")}
                aria-pressed={viewMode === "advanced"}
              >
                Advanced
              </button>
            </div>

            <div className="settings-redesign-meta">
              <span className={pillClass(authStatusTone)}>Koppeling: {authStatusLabel}</span>
              <span className="settings-redesign-meta-item">
                Omgeving: <strong>{environmentLabel}</strong>
              </span>
              <span className="settings-redesign-meta-item">
                Update: <strong>{summary ? fmtCompactTime(summary.generatedAt) : "..."}</strong>
              </span>
            </div>
          </div>
        </header>

        <div className="settings-threshold-legend" aria-label="Kleurlegenda">
          <span className="pill pill-success">Groen = gezond</span>
          <span className="pill pill-warn">Oranje = aandacht nodig</span>
          <span className="pill pill-error">Rood = actie vereist</span>
        </div>

        <div className="settings-section-tabs" role="tablist" aria-label="Settings secties">
          {sectionTabs.map((tab) => (
            <SectionTabButton
              key={tab.key}
              tab={tab}
              active={activeSection === tab.key}
              onClick={setActiveSection}
            />
          ))}
        </div>

        {loading ? <p className="text-body">Pagina laden...</p> : null}
        {error ? (
          <div className="settings-inline-alert" role="status" aria-live="polite">
            Laatste update deels mislukt: {error}. Laatste succesvolle gegevens blijven zichtbaar.
          </div>
        ) : null}

        {summaryAvailable ? (
          <>
            <section
              id="settings-panel-monitoring"
              role="tabpanel"
              aria-labelledby="settings-tab-monitoring"
              hidden={activeSection !== "monitoring"}
              className="settings-panel"
            >
              <div className="monitoring-kpi-grid">
                <MetricCard
                  label="Koppeling"
                  value={authStatusLabel}
                  subtitle={summary?.authStatus.userId ?? "geen gebruiker"}
                  tone={authStatusTone}
                  meter={authStatusTone === "ok" ? 1 : authStatusTone === "warn" ? 0.55 : 0.2}
                  hint="Laat zien of Spotify autorisatie bruikbaar is voor requests en playback acties."
                />

                <MetricCard
                  label="Token"
                  value={
                    summary?.tokenHealth.expiresInSec == null
                      ? "n/a"
                      : `${summary.tokenHealth.expiresInSec}s`
                  }
                  subtitle={`Refresh succes ${fmtPercent(summary?.tokenHealth.refreshSuccessRate ?? 0)}`}
                  tone={tokenTone}
                  meter={
                    summary?.tokenHealth.expiresInSec == null
                      ? null
                      : summary.tokenHealth.expiresInSec / 3600
                  }
                  hint="Toont resterende geldigheid van access token en kwaliteit van refresh-cyclus."
                />

                <MetricCard
                  label="API succes"
                  value={fmtPercent(summary?.apiHealth.successRate ?? 0)}
                  subtitle={`Spotify 5xx: ${summary?.apiHealth.upstream5xx ?? 0}`}
                  tone={apiTone}
                  meter={summary?.apiHealth.successRate ?? 0}
                  hint="Percentage succesvolle Spotify API-calls over alle geregistreerde requests."
                />

                <MetricCard
                  label="Latency p95"
                  value={`${summary?.apiHealth.latencyMs.p95 ?? 0}ms`}
                  subtitle={`p99 ${summary?.apiHealth.latencyMs.p99 ?? 0}ms`}
                  tone={latencyTone}
                  meter={1 - clamp01((summary?.apiHealth.latencyMs.p95 ?? 0) / 1800)}
                  hint="Snelheid van de traagste 5% API-calls; hoge waarden kunnen UX-vertraging geven."
                />

                <MetricCard
                  label="Rate limits"
                  value={`${summary?.rateLimits.count429 ?? 0}`}
                  subtitle={summary?.rateLimits.backoffState ?? "n/a"}
                  tone={
                    (summary?.rateLimits.count429 ?? 0) === 0
                      ? "ok"
                      : (summary?.rateLimits.count429 ?? 0) < 5
                      ? "warn"
                      : "error"
                  }
                  meter={1 - clamp01((summary?.rateLimits.count429 ?? 0) / 20)}
                  hint="Aantal 429-responses. Bij hogere waarden worden acties vertraagd of geblokkeerd."
                />

                <MetricCard
                  label="Incidenten"
                  value={`${summary?.incidents.active.length ?? 0}`}
                  subtitle={(summary?.incidents.active.length ?? 0) > 0 ? "actie nodig" : "stabiel"}
                  tone={(summary?.incidents.active.length ?? 0) > 0 ? "error" : "ok"}
                  meter={1 - clamp01((summary?.incidents.active.length ?? 0) / 4)}
                  hint="Actieve monitoring-incidenten op basis van fout- en tokenregels."
                />
              </div>

              <div className="monitoring-data-grid">
                <DataPanel
                  title="Error mix"
                  span="6"
                  hint="Verdeling van 4xx/5xx fouten per endpoint. Gebruik dit om prioriteiten te stellen."
                >
                  {topErrors.length ? (
                    <div className="monitoring-endpoint-list">
                      {topErrors.map((row) => {
                        const endpointMeta = describeEndpoint(row.label);
                        return (
                          <div
                            key={row.label}
                            className="monitoring-endpoint-row"
                            title={endpointMeta.title}
                          >
                            <div className="monitoring-endpoint-label">
                              <span className="monitoring-endpoint-main">{endpointMeta.label}</span>
                              <span className="monitoring-endpoint-raw">{endpointMeta.raw}</span>
                            </div>
                            <div
                              className="monitoring-endpoint-bar monitoring-endpoint-bar-danger"
                              aria-hidden="true"
                            >
                              <span
                                style={{
                                  width: `${Math.max(5, (row.value / maxErrorCount) * 100)}%`,
                                }}
                              />
                            </div>
                            <div className="monitoring-endpoint-rpm">{row.value}</div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-subtle">Geen fouten geregistreerd in de huidige snapshot.</div>
                  )}
                </DataPanel>

                <DataPanel
                  title="Endpoint verkeer"
                  span="6"
                  hint="Top endpoint-groepen op volume. Helpt bij load-analyse en impact-inschatting."
                >
                  {topEndpoints.length ? (
                    <div className="monitoring-endpoint-list">
                      {topEndpoints.map((row) => {
                        const endpointMeta = describeEndpoint(row.endpoint);
                        return (
                          <div
                            key={row.endpoint}
                            className="monitoring-endpoint-row"
                            title={endpointMeta.title}
                          >
                            <div className="monitoring-endpoint-label">
                              <span className="monitoring-endpoint-main">{endpointMeta.label}</span>
                              <span className="monitoring-endpoint-raw">{endpointMeta.raw}</span>
                            </div>
                            <div className="monitoring-endpoint-bar" aria-hidden="true">
                              <span
                                style={{
                                  width: `${Math.max(5, (row.rpm / topEndpointRpm) * 100)}%`,
                                }}
                              />
                            </div>
                            <div className="monitoring-endpoint-rpm">{row.rpm}</div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-subtle">Nog geen endpointverkeer geregistreerd.</div>
                  )}
                </DataPanel>

                <DataPanel
                  title="Recente errors"
                  span="8"
                  hint="Laatste foutgebeurtenissen met tijd, code en correlatie-id voor troubleshooting."
                >
                  {visibleRecentErrors.length ? (
                    <div className="monitoring-feed-list">
                      {visibleRecentErrors.map((item) => (
                        <div key={item.id} className="monitoring-feed-row">
                          <span className="monitoring-feed-time">{fmtCompactTime(item.at)}</span>
                          <span className="monitoring-feed-code">{item.code}</span>
                          <span className="monitoring-feed-correlation">
                            {viewMode === "advanced"
                              ? `${item.endpoint ?? "endpoint onbekend"} - ${item.message} - ${
                                  item.correlationId
                                }`
                              : item.correlationId}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-subtle">Geen recente fouten.</div>
                  )}
                </DataPanel>

                <DataPanel
                  title="Incidenten"
                  span="4"
                  hint="Open alerts op basis van foutpatronen en auth-gezondheid."
                >
                  {summary?.incidents.active.length ? (
                    <div className="monitoring-feed-list">
                      {summary.incidents.active.map((incident) => (
                        <div key={incident.id} className="monitoring-incident-row">
                          <span
                            className={`pill ${
                              incident.severity === "P0" ? "pill-error" : "pill-warn"
                            }`}
                          >
                            {incident.severity}
                          </span>
                          <span className="monitoring-incident-title">{incident.title}</span>
                          <span className="monitoring-feed-time">
                            {fmtCompactTime(incident.startedAt)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-subtle">Geen actieve incidenten.</div>
                  )}

                  <div className="settings-runbook-row">
                    <span className="text-subtle">Runbook beschikbaar voor incident-opvolging.</span>
                    <a className="btn btn-secondary" href={summary?.incidents.runbookUrl ?? "#"}>
                      Open runbook
                    </a>
                  </div>
                </DataPanel>
              </div>
            </section>

            <section
              id="settings-panel-settings"
              role="tabpanel"
              aria-labelledby="settings-tab-settings"
              hidden={activeSection !== "settings"}
              className="settings-panel"
            >
              <div className="monitoring-data-grid">
                <DataPanel
                  title="Account en sessie"
                  span="6"
                  hint="Beheer de Spotify-koppeling en de appsessie veilig en expliciet."
                >
                  <div className="settings-account-grid">
                    <div className="settings-account-row">
                      <span className="text-subtle">Koppelstatus</span>
                      <span className={pillClass(authStatusTone)}>{authStatusLabel}</span>
                    </div>
                    <div className="settings-account-row">
                      <span className="text-subtle">Spotify user</span>
                      <strong>{summary?.authStatus.userId ?? "n/a"}</strong>
                    </div>
                    <div className="settings-account-row">
                      <span className="text-subtle">Laatst geauthenticeerd</span>
                      <strong>{fmtDateTime(summary?.authStatus.lastAuthAt ?? null)}</strong>
                    </div>
                    <div className="settings-account-row">
                      <span className="text-subtle">Profiel</span>
                      <strong>
                        {userStatus?.profile?.display_name ??
                          userStatus?.profile?.id ??
                          userStatus?.status ??
                          "n/a"}
                      </strong>
                    </div>
                  </div>

                  <div className="settings-inline-actions">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        window.location.href = "/api/auth/login";
                      }}
                    >
                      Spotify opnieuw koppelen
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        const ok = window.confirm(
                          "Spotify logout verbreekt de koppeling voor deze app. Doorgaan?"
                        );
                        if (!ok) return;
                        window.location.href = "/api/auth/logout";
                      }}
                    >
                      Spotify logout
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={async () => {
                        const ok = window.confirm(
                          "App logout sluit de huidige appsessie. Doorgaan?"
                        );
                        if (!ok) return;
                        setActionBusy("App logout");
                        try {
                          await clientFetch("/api/pin-logout", { method: "POST" });
                        } finally {
                          window.location.href = "/login";
                        }
                      }}
                      disabled={actionBusy !== null}
                    >
                      Uitloggen app
                    </button>
                  </div>
                </DataPanel>

                <DataPanel
                  title="Voorkeuren"
                  span="6"
                  hint="Stel complexiteit en updategedrag in met veilige defaults."
                >
                  <div className="settings-preferences-list">
                    <label className="settings-switch-row">
                      <span>Gebruik Advanced weergave</span>
                      <input
                        type="checkbox"
                        checked={viewMode === "advanced"}
                        onChange={(event) => {
                          setViewMode(event.target.checked ? "advanced" : "standard");
                        }}
                      />
                    </label>

                    <label className="settings-switch-row">
                      <span>Auto-refresh monitoring</span>
                      <input
                        type="checkbox"
                        checked={autoRefresh}
                        onChange={(event) => setAutoRefresh(event.target.checked)}
                      />
                    </label>

                    <label className="settings-input-row">
                      <span>Refresh interval</span>
                      <select
                        className="input settings-select"
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
                  </div>

                  {viewMode === "standard" ? (
                    <div className="text-subtle settings-advanced-note">
                      Geavanceerde systeeminstellingen zijn verborgen in Standard modus.
                    </div>
                  ) : null}
                </DataPanel>

                {viewMode === "advanced" ? (
                  <DataPanel
                    title="Geavanceerde systeemsettings"
                    span="12"
                    hint="Uitgebreide operationele details, resource-updates en promptbeheer."
                  >
                    <StatusBox embedded mode="advanced-settings" />
                  </DataPanel>
                ) : null}
              </div>
            </section>

            <section
              id="settings-panel-actions"
              role="tabpanel"
              aria-labelledby="settings-tab-actions"
              hidden={activeSection !== "actions"}
              className="settings-panel"
            >
              <div className="monitoring-data-grid">
                <DataPanel
                  title="Safe acties"
                  span="8"
                  hint="Dagelijkse beheeracties met lage impact en directe feedback."
                >
                  <div className="settings-action-grid">
                    <article className="settings-action-card" data-risk="safe">
                      <div className="settings-action-card-head">
                        <span className="pill pill-success">Veilig</span>
                        <strong>Spotify opnieuw koppelen</strong>
                      </div>
                      <p className="text-subtle">Start de autorisatieflow opnieuw bij scope/token issues.</p>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => {
                          window.location.href = "/api/auth/login";
                        }}
                        disabled={actionBusy !== null}
                      >
                        Re-auth starten
                      </button>
                    </article>

                    <article className="settings-action-card" data-risk="safe">
                      <div className="settings-action-card-head">
                        <span className="pill pill-success">Veilig</span>
                        <strong>Force token refresh</strong>
                      </div>
                      <p className="text-subtle">Vernieuw direct de access token om auth drift te herstellen.</p>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={actionBusy !== null || tokenRefreshCooldownLeftSec > 0}
                        onClick={async () => {
                          const payload = await runAction(
                            "Force token refresh",
                            "/api/monitoring/token/refresh",
                            "POST",
                            () => "Token succesvol ververst"
                          );
                          if (payload) {
                            setTokenRefreshCooldownUntil(Date.now() + 10_000);
                          }
                        }}
                      >
                        {tokenRefreshCooldownLeftSec > 0
                          ? `Wacht ${tokenRefreshCooldownLeftSec}s`
                          : actionBusy === "Force token refresh"
                          ? "Bezig..."
                          : "Force refresh"}
                      </button>
                    </article>

                    <article className="settings-action-card" data-risk="safe">
                      <div className="settings-action-card-head">
                        <span className="pill pill-success">Veilig</span>
                        <strong>Test API call</strong>
                      </div>
                      <p className="text-subtle">Controleer direct of Spotify profiel-endpoint bereikbaar is.</p>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={actionBusy !== null}
                        onClick={() => runAction("Test API", "/api/monitoring/test-api", "POST")}
                      >
                        {actionBusy === "Test API" ? "Bezig..." : "Test API"}
                      </button>
                    </article>

                    <article className="settings-action-card" data-risk="safe">
                      <div className="settings-action-card-head">
                        <span className="pill pill-success">Veilig</span>
                        <strong>Export diagnostics</strong>
                      </div>
                      <p className="text-subtle">
                        Download operationele status als JSON (bevat correlation IDs).
                      </p>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={actionBusy !== null}
                        onClick={async () => {
                          const payload = await runAction(
                            "Export diagnostics",
                            "/api/monitoring/diagnostics",
                            "GET",
                            () => "Diagnostics export opgebouwd"
                          );
                          if (!payload) return;
                          downloadJson("gsplayer-diagnostics", payload);
                        }}
                      >
                        {actionBusy === "Export diagnostics" ? "Bezig..." : "Export diagnostics"}
                      </button>
                    </article>

                    {viewMode === "advanced" ? (
                      <>
                        <article className="settings-action-card" data-risk="warn">
                          <div className="settings-action-card-head">
                            <span className="pill pill-warn">Verhoogd risico</span>
                            <strong>Export errors detail</strong>
                          </div>
                          <p className="text-subtle">
                            Exporteer error mix en recente errors met volledige technische context.
                          </p>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={actionBusy !== null}
                            onClick={async () => {
                              const payload = await runAction(
                                "Export errors",
                                "/api/monitoring/errors/export",
                                "GET",
                                () => "Error export opgebouwd"
                              );
                              if (!payload) return;
                              downloadJson("gsplayer-errors", payload);
                            }}
                          >
                            {actionBusy === "Export errors" ? "Bezig..." : "Export errors"}
                          </button>
                        </article>

                        <article className="settings-action-card" data-risk="warn">
                          <div className="settings-action-card-head">
                            <span className="pill pill-warn">Verhoogd risico</span>
                            <strong>Copy debug bundle</strong>
                          </div>
                          <p className="text-subtle">
                            Kopieer diagnostics naar klembord voor support of incidentanalyse.
                          </p>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={actionBusy !== null}
                            onClick={async () => {
                              const name = "Copy debug bundle";
                              setActionBusy(name);
                              try {
                                const res = await clientFetch("/api/monitoring/diagnostics", {
                                  method: "GET",
                                });
                                const payload = await res.json().catch(() => ({}));
                                const correlationId =
                                  typeof payload?.correlationId === "string"
                                    ? payload.correlationId
                                    : res.headers.get("x-correlation-id");
                                if (!res.ok) {
                                  pushActionHistory({
                                    name,
                                    outcome: "error",
                                    message:
                                      typeof payload?.error === "string"
                                        ? payload.error
                                        : `http_${res.status}`,
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
                            }}
                          >
                            {actionBusy === "Copy debug bundle" ? "Bezig..." : "Copy debug bundle"}
                          </button>
                        </article>
                      </>
                    ) : null}
                  </div>
                </DataPanel>

                <DataPanel
                  title="Recente actiehistorie"
                  span="4"
                  hint="Laatste uitgevoerde acties met uitkomst en correlation-id waar beschikbaar."
                >
                  {actionHistory.length ? (
                    <div className="settings-action-history-list" role="status" aria-live="polite">
                      {actionHistory.map((entry) => (
                        <div key={entry.id} className="settings-action-history-item">
                          <div className="settings-action-history-top">
                            <span
                              className={`pill ${
                                entry.outcome === "success" ? "pill-success" : "pill-error"
                              }`}
                            >
                              {entry.outcome === "success" ? "Geslaagd" : "Mislukt"}
                            </span>
                            <span className="monitoring-feed-time">{fmtCompactTime(entry.at)}</span>
                          </div>
                          <div className="settings-action-history-name">{entry.name}</div>
                          <div className="text-subtle">{entry.message}</div>
                          {entry.correlationId ? (
                            <div className="monitoring-feed-correlation">{entry.correlationId}</div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-subtle">Nog geen acties uitgevoerd in deze sessie.</div>
                  )}
                </DataPanel>

                <DataPanel
                  title="Danger Zone"
                  span="12"
                  hint="Acties met hogere operationele impact. Standaard ingeklapt voor foutpreventie."
                >
                  <div className="settings-danger-header">
                    <p className="text-subtle">
                      Gebruik alleen bij incidenten of expliciete onderhoudstaken.
                    </p>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setDangerExpanded((prev) => !prev)}
                      aria-expanded={dangerExpanded}
                    >
                      {dangerExpanded ? "Inklappen" : "Uitklappen"}
                    </button>
                  </div>

                  {dangerExpanded ? (
                    <div className="settings-danger-grid">
                      <article className="settings-action-card settings-danger-card" data-risk="danger">
                        <div className="settings-action-card-head">
                          <span className="pill pill-error">Hoge impact</span>
                          <strong>Cache legen</strong>
                        </div>
                        <p className="text-subtle">
                          Reset monitoring-metrics, recente errors en app-token cache.
                        </p>
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
                          Start cache reset
                        </button>
                      </article>

                      <article className="settings-action-card settings-danger-card" data-risk="danger">
                        <div className="settings-action-card-head">
                          <span className="pill pill-error">Hoge impact</span>
                          <strong>Volledige synchronisatie</strong>
                        </div>
                        <p className="text-subtle">
                          Start een volledige sync-run voor tracks, playlists, artiesten en covers.
                        </p>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={actionBusy !== null}
                          onClick={() =>
                            setDangerDialog({
                              kind: "bulk-sync",
                              step: 1,
                              acknowledged: false,
                              confirmText: "",
                            })
                          }
                        >
                          Start bevestiging
                        </button>
                      </article>
                    </div>
                  ) : null}
                </DataPanel>
              </div>
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
                  Deze actie wist monitoring-metrics en recente errors. Alleen uitvoeren bij
                  troubleshooting.
                </p>
                <label className="settings-switch-row settings-modal-row">
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
                <label className="settings-input-row settings-modal-row">
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

            {dangerDialog.kind === "bulk-sync" ? (
              <>
                <h2 id="settings-danger-dialog-title" className="settings-danger-modal-title">
                  Bevestig volledige synchronisatie
                </h2>

                {dangerDialog.step === 1 ? (
                  <>
                    <p className="text-subtle">
                      Deze run start sync voor tracks, playlists, artiesten, metadata en covers.
                      Dit kan tijdelijk extra load geven.
                    </p>
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
                        onClick={() =>
                          setDangerDialog({
                            kind: "bulk-sync",
                            step: 2,
                            acknowledged: false,
                            confirmText: "",
                          })
                        }
                        disabled={actionBusy !== null}
                      >
                        Verder naar bevestiging
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <label className="settings-switch-row settings-modal-row">
                      <span>Ik begrijp dat deze actie operationele belasting verhoogt.</span>
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
                    <label className="settings-input-row settings-modal-row">
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
                        {actionBusy === "Volledige synchronisatie"
                          ? "Bezig..."
                          : "Definitief starten"}
                      </button>
                    </div>
                  </>
                )}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}
