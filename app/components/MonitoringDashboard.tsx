"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import PromptSettingsPanel from "./PromptSettingsPanel";
import { clientFetch } from "@/lib/http/clientFetch";
import { PLAYBACK_FEATURE_FLAGS } from "@/lib/playback/featureFlags";

type SummaryPayload = {
  generatedAt: number;
  meta?: {
    environment?: string | null;
    metricsWindowSec?: number | null;
  };
  authStatus: {
    status: string;
    scopes: string[];
    userId: string | null;
    appUserId: string | null;
    lastAuthAt: number | null;
  };
  tokenHealth: {
    status: string;
    expiresInSec: number | null;
    refreshSuccessRate: number;
    refreshAttempts: number;
    refreshSuccessCount: number;
    refreshFailureCount: number;
    invalidGrantCount: number;
    lockWaitP95Ms: number;
    lastRefreshAt: number | null;
  };
  appTokenHealth: {
    status: string;
    expiresInSec: number | null;
    expiresAt: number | null;
    refreshSuccessCount: number;
    refreshFailureCount: number;
    lastRefreshAt: number | null;
    lastAttemptAt: number | null;
    lastError: string | null;
  };
  apiHealth: {
    successRate: number;
    sampleCount: number;
    restrictionViolatedCount?: number;
    latencyMs: { p50: number; p95: number; p99: number };
    latencyByPriority?: {
      foreground: { p50: number; p95: number; p99: number };
      background: { p50: number; p95: number; p99: number };
    };
    errorBreakdown: Array<{ label: string; value: number }>;
    upstream5xx: number;
    slowActivities?: {
      total: number;
      topActivities: Array<{ label: string; count: number }>;
      topEndpointPaths: Array<{ label: string; count: number }>;
      negativeReliabilityActivities: Array<{ label: string; count: number }>;
      negativeResponsivenessActivities: Array<{ label: string; count: number }>;
    };
  };
  rateLimits: {
    count429: number;
    backoffState: string;
    sampleWindowSec?: number;
    backoffRemainingMs?: number;
    backoffUntilTs?: number | null;
    lastRetryAfterMs?: number | null;
    lastTriggeredAt?: number | null;
    retryAfterObservationsSec?: number[];
    activityLog?: {
      total: number;
      topActivities: Array<{ label: string; count: number }>;
      topEndpointPaths: Array<{ label: string; count: number }>;
      bySource: Array<{ label: string; count: number }>;
      negativeReliabilityActivities: Array<{ label: string; count: number }>;
      negativeResponsivenessActivities: Array<{ label: string; count: number }>;
    };
  };
  traffic: {
    requestsPerMin: number;
    requestsInWindow?: number;
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

type RateLimitActivityEntry = {
  at: number;
  activity: string;
  source: string;
  endpoint?: string;
  endpointPath?: string;
  method: string;
  priority?: "foreground" | "default" | "background";
  statusCode: number;
  retryAfterMs: number | null;
  attempt: number | null;
  correlationId: string;
  impact?: {
    reliability: "low" | "medium" | "high";
    responsiveness: "low" | "medium" | "high";
    reasons: string[];
  };
};

type DiagnosticsPayload = {
  recentRateLimitActivities?: RateLimitActivityEntry[];
  recentSlowActivities?: Array<{
    at: number;
    activity: string;
    endpoint: string;
    endpointPath: string;
    method: string;
    priority: "foreground" | "default" | "background";
    statusCode: number;
    durationMs: number;
    correlationId: string;
    impact?: {
      reliability: "low" | "medium" | "high";
      responsiveness: "low" | "medium" | "high";
      reasons: string[];
    };
  }>;
  app?: {
    nodeEnv?: string;
    hasUpstash?: boolean;
    trustProxy?: boolean;
    authLogEnabled?: boolean;
  };
  rateLimiter?: {
    globalInFlight?: number;
    queueDepth?: number;
    globalConcurrency?: number;
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

type DbStatusPayload = {
  counts?: Record<string, number>;
  sync?: {
    running?: boolean;
    staleRunning?: number;
    lastSuccessfulAt?: number | null;
    resources?: Array<{
      resource: string;
      status: string;
      cursorOffset?: number | null;
      cursorLimit?: number | null;
      lastSuccessfulAt?: number | null;
      retryAfterAt?: number | null;
      failureCount?: number;
      lastErrorCode?: string | null;
      updatedAt?: number | null;
    }>;
  };
  asOf?: number;
};

type WorkerHealthPayload = {
  status: string;
  lastHeartbeat: number | null;
  staleAfterMs: number;
  now: number;
};

type LibraryCounts = {
  playlists: number;
  tracks: number;
  artists: number;
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

type StatusSectionId =
  | "overview"
  | "health"
  | "data"
  | "diagnostics"
  | "actions"
  | "ai";

const ENDPOINT_LABEL_MAP: Record<string, { label: string; description: string }> = {
  me_player: {
    label: "Player controls",
    description: "Play/pause/next/seek and player state.",
  },
  me_tracks: {
    label: "Liked Songs",
    description: "Lezen/schrijven van persoonlijke library-tracks.",
  },
  me_playlists: {
    label: "Playlists",
    description: "Fetch and manage playlist overviews.",
  },
  playlists_items: {
    label: "Playlist tracks",
    description: "Load and modify tracks inside playlists.",
  },
  me_player_devices: {
    label: "Connect devices",
    description: "Fetch available Spotify Connect devices.",
  },
  artists: {
    label: "Artists",
    description: "Artist metadata and related queries.",
  },
  tracks: {
    label: "Tracks",
    description: "Track metadata and track-specific requests.",
  },
  v1_me: {
    label: "Account profile",
    description: "Validation for the signed-in Spotify user.",
  },
};

const ACTIVITY_LABEL_MAP: Record<string, string> = {
  me_player_get_raw_state: "Player state refresh",
  me_player_get_state: "Player state sync",
  me_player_devices: "Device discovery",
  me_player_transfer: "Device handoff",
  me_player_command: "Playback command",
  me_tracks: "Liked Songs",
  me_playlists: "Playlist overview",
  playlists_items: "Playlist tracks",
  artists: "Artist lookup",
  tracks: "Track lookup",
  v1_me: "Account profile",
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

function fmtCount(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US");
}

function fmtWindow(seconds: number | null | undefined) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return "recent";
  }
  if (seconds % 60 === 0) {
    return `${Math.max(1, Math.floor(seconds / 60))}m`;
  }
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

function fmtAgoShort(seconds: number | null | undefined) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return "n/a";
  }
  if (seconds < 60) return `${Math.max(1, Math.floor(seconds))}s`;
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  return `${Math.max(1, Math.floor(seconds / 3600))}h`;
}

function formatRateLimitSource(value: string) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "spotify_http_429") return "Spotify 429";
  if (normalized === "spotify_local_limiter") return "Local limiter";
  return value || "Unknown";
}

function formatImpactLevel(value: "low" | "medium" | "high" | null | undefined) {
  if (value === "high") return "high";
  if (value === "medium") return "medium";
  return "low";
}

function formatLatencyHealthLabel(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "Waiting for enough samples";
  if (value <= 450) return "User-facing requests feel healthy";
  if (value <= 900) return "User-facing requests are slightly elevated";
  return "User-facing requests feel slow";
}

function formatMonitoringActivityLabel(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return "No hotspot";
  const mapped = ACTIVITY_LABEL_MAP[raw.toLowerCase()];
  if (mapped) return mapped;

  const normalized = raw
    .replace(/^me_player_/i, "player ")
    .replace(/^me_/i, "account ")
    .replace(/^v1_/i, "")
    .replace(/_/g, " ")
    .replace(/\braw\b/gi, "live")
    .replace(/\bget\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return raw;

  return normalized
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function copyTextToClipboard(value: string) {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  } catch {
    // keep trying async API below
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
  }
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
  if (normalized === "CONNECTED" || normalized === "OK") return "Connected";
  if (normalized === "REAUTH_REQUIRED") return "Re-login required";
  if (normalized === "DISCONNECTED") return "Disconnected";
  if (normalized === "CHECKING") return "Checking";
  return status;
}

function tokenStatusTone(status: string): Tone {
  const normalized = String(status ?? "").trim().toUpperCase();
  if (
    normalized === "VALID" ||
    normalized === "CONNECTED" ||
    normalized === "OK" ||
    normalized === "REFRESHING"
  ) {
    return "ok";
  }
  if (
    normalized === "EXPIRING" ||
    normalized === "MISSING_ACCESS" ||
    normalized === "MISSING" ||
    normalized === "CHECKING" ||
    normalized === "UNKNOWN"
  ) {
    return "warn";
  }
  return "error";
}

function formatTokenStatus(status: string) {
  const normalized = String(status ?? "").trim().toUpperCase();
  if (normalized === "VALID" || normalized === "OK") return "Valid";
  if (normalized === "REFRESHING") return "Refreshing";
  if (normalized === "EXPIRING") return "Expiring soon";
  if (normalized === "EXPIRED") return "Expired";
  if (normalized === "REAUTH_REQUIRED") return "Re-login required";
  if (normalized === "MISSING" || normalized === "MISSING_ACCESS") return "Missing";
  if (normalized === "ERROR") return "Error";
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
      .join(" ") || "Unknown endpoint";

  return {
    label,
    raw,
    title: `${label} (${raw})`,
  };
}

function normalizeEndpointKey(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeRecentErrorMessage(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text) return "No detail available.";
  try {
    const parsed = JSON.parse(text) as
      | { error?: string | { status?: number; message?: string } }
      | null;
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        return parsed.error.trim();
      }
      if (parsed.error && typeof parsed.error === "object") {
        const status =
          typeof parsed.error.status === "number" ? parsed.error.status : null;
        const message =
          typeof parsed.error.message === "string"
            ? parsed.error.message.trim()
            : "";
        if (message) return status ? `${message} (${status})` : message;
      }
    }
  } catch {
    // keep raw text when it is not valid JSON
  }
  return text;
}

function describeErrorCode(code: string): { label: string; tone: Tone; help: string } {
  const normalized = String(code ?? "").trim().toUpperCase();
  switch (normalized) {
    case "NO_ACTIVE_DEVICE":
      return {
        label: "No active device",
        tone: "warn",
        help: "Start playback on a Spotify Connect device.",
      };
    case "NO_CONNECT_DEVICE":
      return {
        label: "No devices visible",
        tone: "warn",
        help: "Check whether Spotify is active on your device.",
      };
    case "NETWORK_TIMEOUT":
      return {
        label: "Network timeout",
        tone: "warn",
        help: "Spotify responded too slowly; the app will retry automatically.",
      };
    case "NETWORK_TRANSIENT":
      return {
        label: "Temporary network error",
        tone: "warn",
        help: "Temporary disruption; this usually recovers on its own.",
      };
    case "RATE_LIMIT":
      return {
        label: "Rate limit",
        tone: "warn",
        help: "Too many requests at once; backoff is active.",
      };
    case "UNAUTHENTICATED":
      return {
        label: "Not signed in",
        tone: "error",
        help: "Spotify session expired; reconnect is required.",
      };
    case "SPOTIFY_UPSTREAM":
      return {
        label: "Spotify outage",
        tone: "error",
        help: "The Spotify API returned a server-side error.",
      };
    case "NOT_FOUND":
    case "PLAYER_NOT_FOUND":
      return {
        label: "Not found",
        tone: "warn",
        help: "The requested playback context does not exist right now.",
      };
    case "NETWORK_FATAL":
      return {
        label: "Network error",
        tone: "error",
        help: "Hard network failure; retry the action manually.",
      };
    default:
      return {
        label: normalized || "Unknown",
        tone: "error",
        help: "Unknown error; review the diagnostics export for details.",
      };
  }
}

function describeRecentErrorMessage(args: {
  code: string;
  endpointRaw: string;
  message: string;
}): string {
  const code = String(args.code ?? "").trim().toUpperCase();
  if (code === "NO_ACTIVE_DEVICE") {
    return "No active player found. Start music on a device and try again.";
  }
  if (code === "NO_CONNECT_DEVICE") {
    return "No Spotify Connect devices are available.";
  }
  if (code === "NOT_FOUND" && args.endpointRaw === "me_player") {
    return "No active player found. Start music on a device and try again.";
  }
  return normalizeRecentErrorMessage(args.message);
}

function HelpTip({ label, text }: { label: string; text: string }) {
  const tipId = useId();
  return (
    <span className="ops-help-tip">
      <button
        type="button"
        className="ops-help-tip-btn"
        aria-label={`${label}: explanation`}
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
  details,
  featured = false,
}: {
  title: string;
  value: string;
  subtitle: string;
  tone: Tone;
  meter: number;
  hint: string;
  details?: Array<{ label: string; value: string }>;
  featured?: boolean;
}) {
  return (
    <article className={`ops-kpi ${toneClass(tone)}${featured ? " ops-kpi-featured" : ""}`}>
      <div className="ops-kpi-head">
        <span className="ops-kpi-title">{title}</span>
        <HelpTip label={title} text={hint} />
      </div>
      <div className="ops-kpi-value">{value}</div>
      <div className="ops-kpi-subtitle">{subtitle}</div>
      {details?.length ? (
        <div className="ops-kpi-details">
          {details.map((detail) => (
            <div key={detail.label} className="ops-kpi-detail">
              <span className="ops-kpi-detail-label">{detail.label}</span>
              <span className="ops-kpi-detail-value">{detail.value}</span>
            </div>
          ))}
        </div>
      ) : null}
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
  const [summaryReceivedAtMs, setSummaryReceivedAtMs] = useState(0);
  const [userStatus, setUserStatus] = useState<UserStatusPayload | null>(null);
  const [libraryCounts, setLibraryCounts] = useState<LibraryCounts | null>(null);
  const [dbStatus, setDbStatus] = useState<DbStatusPayload | null>(null);
  const [workerHealth, setWorkerHealth] = useState<WorkerHealthPayload | null>(null);
  const [diagnosticsSnapshot, setDiagnosticsSnapshot] = useState<DiagnosticsPayload | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<null | string>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshIntervalSec, setRefreshIntervalSec] = useState(15);
  const [activeSection, setActiveSection] = useState<StatusSectionId>("overview");
  const [actionHistory, setActionHistory] = useState<ActionHistoryItem[]>([]);
  const [tokenRefreshCooldownUntil, setTokenRefreshCooldownUntil] = useState(0);
  const [selectedErrorEndpoint, setSelectedErrorEndpoint] = useState<string | null>(null);
  const [clockNowMs, setClockNowMs] = useState(() => Date.now());
  const [rateLimitLogOpen, setRateLimitLogOpen] = useState(false);
  const [rateLimitLogLoading, setRateLimitLogLoading] = useState(false);
  const [rateLimitLogError, setRateLimitLogError] = useState<string | null>(null);
  const [rateLimitLogEntries, setRateLimitLogEntries] = useState<RateLimitActivityEntry[]>(
    []
  );
  const [rateLimitLogFetchedAt, setRateLimitLogFetchedAt] = useState<number | null>(null);
  const [rateLimitLogCopyBusy, setRateLimitLogCopyBusy] = useState(false);

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
    setSummaryReceivedAtMs(Date.now());
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

  const refreshDbStatus = useCallback(async () => {
    try {
      const res = await clientFetch("/api/spotify/db-status");
      if (!res.ok) return;
      const data = (await res.json()) as DbStatusPayload;
      setDbStatus(data);
      const counts = data?.counts ?? {};
      const next: LibraryCounts = {
        playlists:
          typeof counts.playlists === "number" && Number.isFinite(counts.playlists)
            ? counts.playlists
            : 0,
        tracks:
          typeof counts.tracks === "number" && Number.isFinite(counts.tracks)
            ? counts.tracks
            : 0,
        artists:
          typeof counts.artists === "number" && Number.isFinite(counts.artists)
            ? counts.artists
            : 0,
      };
      setLibraryCounts(next);
    } catch {
      // keep existing counters when this call fails
    }
  }, []);

  const refreshWorkerHealth = useCallback(async () => {
    try {
      const res = await clientFetch("/api/spotify/worker-health");
      if (!res.ok) return;
      setWorkerHealth((await res.json()) as WorkerHealthPayload);
    } catch {
      // keep current worker health on transient failure
    }
  }, []);

  const refreshDiagnosticsSnapshot = useCallback(async () => {
    try {
      const res = await clientFetch("/api/monitoring/diagnostics");
      if (!res.ok) return;
      setDiagnosticsSnapshot((await res.json()) as DiagnosticsPayload);
    } catch {
      // diagnostics is optional for the overview shell
    }
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      await Promise.all([
        refreshSummary(),
        refreshUserStatus(),
        refreshDbStatus(),
        refreshWorkerHealth(),
        refreshDiagnosticsSnapshot(),
      ]);
      setRefreshError(null);
    } catch (err) {
      setRefreshError(String(err));
    } finally {
      setLoading(false);
    }
  }, [
    refreshDbStatus,
    refreshDiagnosticsSnapshot,
    refreshSummary,
    refreshUserStatus,
    refreshWorkerHealth,
  ]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClockNowMs(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const intervalMs = Math.max(5, refreshIntervalSec) * 1000;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
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
        autoRefresh?: boolean;
        refreshIntervalSec?: number;
      };
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
        autoRefresh,
        refreshIntervalSec,
      })
    );
  }, [autoRefresh, preferenceKey, refreshIntervalSec]);

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

        const successMessage = onSuccess ? onSuccess(payload) : `${name} completed`;
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
    const name = "Refresh library";
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

  const loadRateLimitActivityLog = useCallback(async () => {
    setRateLimitLogLoading(true);
    setRateLimitLogError(null);
    try {
      const res = await clientFetch("/api/monitoring/diagnostics");
      if (!res.ok) {
        throw new Error(`rate_limit_log_http_${res.status}`);
      }
      const payload = (await res.json()) as DiagnosticsPayload;
      const rows = Array.isArray(payload?.recentRateLimitActivities)
        ? payload.recentRateLimitActivities
        : [];
      setRateLimitLogEntries(rows.slice(0, 120));
      setRateLimitLogFetchedAt(Date.now());
      pushActionHistory({
        name: "Rate-limit log",
        outcome: "success",
        message: rows.length
          ? `${rows.length} activiteiten geladen`
          : "No rate-limit activity in log",
        correlationId: null,
        at: Date.now(),
      });
    } catch (error) {
      const message = String(error);
      setRateLimitLogError(message);
      pushActionHistory({
        name: "Rate-limit log",
        outcome: "error",
        message,
        correlationId: null,
        at: Date.now(),
      });
    } finally {
      setRateLimitLogLoading(false);
    }
  }, [pushActionHistory]);

  const copyRateLimitActivityLog = useCallback(async () => {
    const payload = {
      exportedAt: Date.now(),
      fetchedAt: rateLimitLogFetchedAt,
      total: rateLimitLogEntries.length,
      entries: rateLimitLogEntries,
    };
    setRateLimitLogCopyBusy(true);
    try {
      await copyTextToClipboard(JSON.stringify(payload, null, 2));
      pushActionHistory({
        name: "Rate-limit log kopieren",
        outcome: "success",
        message: `${rateLimitLogEntries.length} regels gekopieerd`,
        correlationId: null,
        at: Date.now(),
      });
    } catch (error) {
      pushActionHistory({
        name: "Rate-limit log kopieren",
        outcome: "error",
        message: String(error),
        correlationId: null,
        at: Date.now(),
      });
    } finally {
      setRateLimitLogCopyBusy(false);
    }
  }, [pushActionHistory, rateLimitLogEntries, rateLimitLogFetchedAt]);

  const summaryAvailable = Boolean(summary);

  const authStatus = summary?.authStatus.status ?? "CHECKING";
  const authStatusLabel = formatAuthStatus(authStatus);
  const authStatusTone = authTone(authStatus);

  const userTokenExpirySec = summary?.tokenHealth.expiresInSec ?? null;
  const userTokenStatus = summary?.tokenHealth.status ?? "UNKNOWN";
  const userTokenStatusLabel = formatTokenStatus(userTokenStatus);
  const userTokenTone: Tone = (() => {
    const fromStatus = tokenStatusTone(userTokenStatus);
    if (fromStatus !== "ok") return fromStatus;
    if (userTokenExpirySec == null) return "warn";
    if (userTokenExpirySec <= 240) return "warn";
    return "ok";
  })();

  const appTokenExpirySec = summary?.appTokenHealth.expiresInSec ?? null;
  const appTokenStatus = summary?.appTokenHealth.status ?? "UNKNOWN";
  const appTokenStatusLabel = formatTokenStatus(appTokenStatus);
  const appTokenTone: Tone = (() => {
    if (summary?.appTokenHealth.lastError) return "error";
    const fromStatus = tokenStatusTone(appTokenStatus);
    if (fromStatus !== "ok") return fromStatus;
    if (appTokenExpirySec == null) return "warn";
    if (appTokenExpirySec <= 240) return "warn";
    return "ok";
  })();

  const metricsWindowSec =
    summary?.meta?.metricsWindowSec ?? summary?.rateLimits.sampleWindowSec ?? null;
  const metricsWindowLabel = fmtWindow(metricsWindowSec);
  const apiSampleCount = summary?.apiHealth.sampleCount ?? 0;
  const restrictionViolatedCount = summary?.apiHealth.restrictionViolatedCount ?? 0;
  const apiWarmup = apiSampleCount < 20;

  const apiTone: Tone = apiWarmup
    ? "warn"
    : (summary?.apiHealth.successRate ?? 0) >= 0.97
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
  const foregroundLatencyP95 =
    summary?.apiHealth.latencyByPriority?.foreground.p95 ?? summary?.apiHealth.latencyMs.p95 ?? 0;
  const backgroundLatencyP95 =
    summary?.apiHealth.latencyByPriority?.background.p95 ?? summary?.apiHealth.latencyMs.p95 ?? 0;

  const elapsedSinceSummaryMs = Math.max(0, clockNowMs - summaryReceivedAtMs);
  const backoffFromSnapshotMs = Math.max(
    0,
    (summary?.rateLimits.backoffRemainingMs ?? 0) - elapsedSinceSummaryMs
  );
  const backoffFromUntilMs = summary?.rateLimits.backoffUntilTs
    ? Math.max(0, summary.rateLimits.backoffUntilTs - clockNowMs)
    : 0;
  const rateBackoffRemainingMs = Math.max(backoffFromSnapshotMs, backoffFromUntilMs);
  const rateBackoffRemainingSec = Math.ceil(rateBackoffRemainingMs / 1000);
  const hasActiveRateBackoff = rateBackoffRemainingSec > 0;
  const rateLimitCount = summary?.rateLimits.count429 ?? 0;
  const rateLimitActivityTotal = summary?.rateLimits.activityLog?.total ?? 0;
  const topReliabilityImpactActivities =
    summary?.rateLimits.activityLog?.negativeReliabilityActivities ?? [];
  const topResponsivenessImpactActivities =
    summary?.rateLimits.activityLog?.negativeResponsivenessActivities ?? [];
  const topSlowActivity = summary?.apiHealth.slowActivities?.topActivities?.[0] ?? null;
  const topSlowActivityLabel = topSlowActivity
    ? formatMonitoringActivityLabel(topSlowActivity.label)
    : null;
  const responsivenessSummary = topSlowActivityLabel
    ? `${formatLatencyHealthLabel(foregroundLatencyP95)}. Current hotspot: ${topSlowActivityLabel}.`
    : "Foreground actions and background jobs are measured separately.";
  const hasRecentRateLimitEvents = rateLimitCount > 0;
  const lastRateTriggeredAgoSec = summary?.rateLimits.lastTriggeredAt
    ? Math.max(0, Math.floor((clockNowMs - summary.rateLimits.lastTriggeredAt) / 1000))
    : null;
  const recentRateBurst = typeof lastRateTriggeredAgoSec === "number" && lastRateTriggeredAgoSec <= 120;
  const historicRateBurst =
    typeof lastRateTriggeredAgoSec === "number" && lastRateTriggeredAgoSec > 120;

  const rateTone: Tone = hasActiveRateBackoff
    ? rateLimitCount >= 10 || rateBackoffRemainingSec >= 10
      ? "error"
      : "warn"
    : rateLimitCount === 0
    ? "ok"
    : recentRateBurst
    ? "warn"
    : historicRateBurst
    ? "ok"
    : "warn";

  const topErrors = useMemo(() => {
    const rows = summary?.apiHealth.errorBreakdown ?? [];
    return rows.slice(0, 6).filter((row) => row.value > 0);
  }, [summary?.apiHealth.errorBreakdown]);

  const maxErrorCount = useMemo(
    () => Math.max(1, ...topErrors.map((row) => row.value)),
    [topErrors]
  );

  useEffect(() => {
    if (!selectedErrorEndpoint) return;
    const selectedKey = normalizeEndpointKey(selectedErrorEndpoint);
    const stillVisible = topErrors.some(
      (row) => normalizeEndpointKey(row.label) === selectedKey
    );
    if (!stillVisible) {
      setSelectedErrorEndpoint(null);
    }
  }, [selectedErrorEndpoint, topErrors]);

  const visibleRecentErrors = useMemo(() => {
    const rows = summary?.recentErrors ?? [];
    if (!selectedErrorEndpoint) {
      return rows.slice(0, 8);
    }
    const selectedKey = normalizeEndpointKey(selectedErrorEndpoint);
    return rows
      .filter((row) => normalizeEndpointKey(row.endpoint) === selectedKey)
      .slice(0, 8);
  }, [selectedErrorEndpoint, summary?.recentErrors]);

  const selectedErrorEndpointMeta = selectedErrorEndpoint
    ? describeEndpoint(selectedErrorEndpoint)
    : null;

  const environmentLabel =
    summary?.meta?.environment && summary.meta.environment.trim()
      ? summary.meta.environment
      : "production";

  const now = clockNowMs;
  const tokenRefreshCooldownLeftSec = Math.max(
    0,
    Math.ceil((tokenRefreshCooldownUntil - now) / 1000)
  );
  const rateBackoffSubtitle = hasActiveRateBackoff
    ? `backoff active · ${rateBackoffRemainingSec}s`
    : hasRecentRateLimitEvents
    ? `no active backoff · ${rateLimitCount} recent throttles (${fmtAgoShort(
        lastRateTriggeredAgoSec
      )} ago)`
    : "no rate limits in window";
  const rateBackoffSubtitleWithWindow = `${rateBackoffSubtitle} · window ${metricsWindowLabel}`;

  const insights = useMemo<Insight[]>(() => {
    if (!summary) return [];
    const list: Insight[] = [];

    if (authStatusTone === "error") {
      list.push({
        id: "auth-error",
        tone: "error",
        title: "Spotify connection is inactive",
        text: "Use 'Reconnect Spotify' to recover immediately.",
      });
    } else if (authStatusTone === "warn") {
      list.push({
        id: "auth-warn",
        tone: "warn",
        title: "Connection needs attention",
        text: "Login or token validation is still in progress; some actions may respond slowly.",
      });
    }

    if (summary.tokenHealth.invalidGrantCount > 0) {
      list.push({
        id: "invalid-grant",
        tone: "error",
        title: "Token was rejected by Spotify",
        text: "Re-login is required to restore stable playback and sync.",
      });
    } else if (summary.tokenHealth.refreshSuccessRate < 0.95) {
      list.push({
        id: "token-refresh",
        tone: "warn",
        title: "Token refresh is not consistently immediate",
        text: "Use 'Refresh token' if devices or playback start lagging behind.",
      });
    }

    if (hasActiveRateBackoff && rateLimitCount >= 5) {
      list.push({
        id: "rate-hard",
        tone: "error",
        title: "Spotify rate limit is blocking requests",
        text: `There were ${rateLimitCount} throttles in the last ${metricsWindowLabel}; backoff continues for ${rateBackoffRemainingSec}s.`,
      });
    } else if (hasActiveRateBackoff && rateLimitCount > 0) {
      list.push({
        id: "rate-soft",
        tone: "warn",
        title: "Spotify rate limit is active",
        text: `There were ${rateLimitCount} temporary throttles in the last ${metricsWindowLabel}; backoff countdown: ${rateBackoffRemainingSec}s.`,
      });
    } else if (rateLimitCount > 0) {
      list.push({
        id: "rate-recent",
        tone: "warn",
        title: "Recent rate limits (now recovered)",
        text: `There were ${rateLimitCount} temporary throttles in the last ${metricsWindowLabel}, but no active backoff remains.`,
      });
    }

    if (apiWarmup) {
      list.push({
        id: "api-warmup",
        tone: "warn",
        title: "Monitoring is still warming up",
        text: `Only ${apiSampleCount} requests have been measured in ${metricsWindowLabel}; the score will stabilize automatically.`,
      });
    } else if (restrictionViolatedCount > 0) {
      list.push({
        id: "api-restriction",
        tone: "warn",
        title: "Spotify is blocking player commands",
        text: `${restrictionViolatedCount} commands were rejected due to device/context restrictions in ${metricsWindowLabel}.`,
      });
    } else if (summary.apiHealth.successRate < 0.9 || summary.apiHealth.upstream5xx > 0) {
      list.push({
        id: "api-health",
        tone: summary.apiHealth.successRate < 0.85 ? "error" : "warn",
        title: "Spotify API is not fully stable",
        text: `Success rate is ${fmtPercent(summary.apiHealth.successRate)} in ${metricsWindowLabel} with ${summary.apiHealth.upstream5xx} server errors.`,
      });
    }

    if (summary.incidents.active.length > 0) {
      list.push({
        id: "incidents",
        tone: "error",
        title: `${summary.incidents.active.length} active incident${
          summary.incidents.active.length === 1 ? "" : "s"
        }`,
        text: "Open the runbook for recovery steps and incident follow-up.",
      });
    }

    if (!list.length) {
      list.push({
        id: "healthy",
        tone: "ok",
        title: "System is stable",
        text: "Connection, API, and synchronization all look healthy.",
      });
    }

    return list.slice(0, 5);
  }, [
    apiSampleCount,
    apiWarmup,
    authStatusTone,
    hasActiveRateBackoff,
    metricsWindowLabel,
    rateLimitCount,
    restrictionViolatedCount,
    rateBackoffRemainingSec,
    summary,
  ]);

  const primaryInsight = insights[0] ?? null;
  const supportingInsights = insights.slice(1, 4);
  const activeIncidentCount = summary?.incidents.active.length ?? 0;
  const profileLabel =
    userStatus?.profile?.display_name ??
    userStatus?.profile?.id ??
    summary?.authStatus.userId ??
    "No Spotify user";
  const totalLibraryItems =
    (libraryCounts?.playlists ?? 0) + (libraryCounts?.tracks ?? 0) + (libraryCounts?.artists ?? 0);
  const userTokenSummary =
    userTokenExpirySec == null ? userTokenStatusLabel : `${userTokenStatusLabel} · ${userTokenExpirySec}s`;
  const appTokenSummary =
    appTokenExpirySec == null ? appTokenStatusLabel : `${appTokenStatusLabel} · ${appTokenExpirySec}s`;
  const overallTone: Tone =
    primaryInsight?.tone ??
    (activeIncidentCount > 0 ? "error" : apiTone === "error" || authStatusTone === "error" ? "error" : "ok");
  const overallStatusLabel =
    overallTone === "ok"
      ? "Healthy"
      : overallTone === "warn"
      ? "Needs attention"
      : "Action required";
  const workerTone: Tone =
    workerHealth?.status === "OK"
      ? "ok"
      : workerHealth?.status === "STALE"
      ? "warn"
      : workerHealth?.status
      ? "error"
      : "warn";
  const dbTone: Tone = dbStatus?.counts ? "ok" : "warn";
  const syncRunning = Boolean(dbStatus?.sync?.running);
  const staleRunningCount =
    typeof dbStatus?.sync?.staleRunning === "number" ? dbStatus.sync.staleRunning : 0;
  const syncTone: Tone = staleRunningCount > 0 ? "warn" : syncRunning ? "warn" : "ok";
  const runtimeFlags = diagnosticsSnapshot?.app;
  const sectionTabs: Array<{ id: StatusSectionId; label: string; meta: string }> = [
    { id: "overview", label: "Overview", meta: "what needs attention now" },
    { id: "health", label: "Health", meta: "tokens, api, rate limits" },
    { id: "data", label: "Data & sync", meta: "worker, jobs, counts" },
    { id: "diagnostics", label: "Diagnostics", meta: "errors and logs" },
    { id: "actions", label: "Actions", meta: "intervention and configuration" },
    { id: "ai", label: "AI prompt", meta: "existing ChatGPT flow" },
  ];
  const serviceCards = [
    {
      title: "Spotify connection",
      value: authStatusLabel,
      meta: summary?.authStatus.userId ?? "no user",
      tone: authStatusTone,
    },
    {
      title: "User token",
      value: userTokenStatusLabel,
      meta: userTokenExpirySec == null ? "no known expiry" : `valid for ${userTokenExpirySec}s`,
      tone: userTokenTone,
    },
    {
      title: "App token",
      value: appTokenStatusLabel,
      meta: appTokenExpirySec == null ? "no known expiry" : `valid for ${appTokenExpirySec}s`,
      tone: appTokenTone,
    },
    {
      title: "Worker",
      value: workerHealth?.status ?? "CHECKING",
      meta: workerHealth?.lastHeartbeat
        ? `heartbeat ${fmtCompactTime(workerHealth.lastHeartbeat)}`
        : "no heartbeat",
      tone: workerTone,
    },
    {
      title: "Database",
      value: dbStatus?.counts ? "Available" : "Checking",
      meta: dbStatus?.asOf ? `snapshot ${fmtCompactTime(dbStatus.asOf)}` : "no snapshot",
      tone: dbTone,
    },
    {
      title: "Sync pipeline",
      value: syncRunning ? "Running" : "Idle",
      meta:
        staleRunningCount > 0
          ? `${staleRunningCount} stale jobs`
          : dbStatus?.sync?.lastSuccessfulAt
          ? `last sync ${fmtCompactTime(dbStatus.sync.lastSuccessfulAt)}`
          : "no successful sync yet",
      tone: syncTone,
    },
  ];
  const syncResources = Array.isArray(dbStatus?.sync?.resources)
    ? [...(dbStatus?.sync?.resources ?? [])]
        .sort((a, b) => {
          const failureDiff = (b.failureCount ?? 0) - (a.failureCount ?? 0);
          if (failureDiff !== 0) return failureDiff;
          return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
        })
        .slice(0, 12)
    : [];
  const dataInventory = [
    { label: "Playlists", value: fmtCount(dbStatus?.counts?.playlists ?? libraryCounts?.playlists ?? 0) },
    { label: "Tracks", value: fmtCount(dbStatus?.counts?.tracks ?? libraryCounts?.tracks ?? 0) },
    { label: "Artists", value: fmtCount(dbStatus?.counts?.artists ?? libraryCounts?.artists ?? 0) },
    { label: "Playlist items", value: fmtCount(dbStatus?.counts?.playlist_items ?? 0) },
    { label: "Cover images", value: fmtCount(dbStatus?.counts?.cover_images ?? 0) },
    { label: "Track-artist links", value: fmtCount(dbStatus?.counts?.track_artists ?? 0) },
  ];
  const featureFlags = Object.entries(PLAYBACK_FEATURE_FLAGS);
  const recentSlowActivities = diagnosticsSnapshot?.recentSlowActivities?.slice(0, 8) ?? [];

  return (
    <main className="page settings-page ops-page">
      <section
        className="card ops-shell"
        style={{ marginTop: "4px" }}
      >
        <header className="ops-control-header">
          <div className="ops-header-copy">
            <span className="ops-kicker">System control</span>
            <h1 className="ops-title">Settings & System Status</h1>
            <p className="ops-subtitle">
              A central control room for Spotify connectivity, system health,
              diagnostics, maintenance, and the existing ChatGPT prompt workflow.
            </p>
          </div>

          <div className="ops-control-summary">
            <span className={pillClass(overallTone)}>Status: {overallStatusLabel}</span>
            <span className="ops-meta-item">
              Environment <strong>{environmentLabel}</strong>
            </span>
            <span className="ops-meta-item">
              Last update <strong>{summary ? fmtCompactTime(summary.generatedAt) : "..."}</strong>
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void refreshAll()}
              disabled={loading || actionBusy !== null}
            >
              {loading ? "Loading..." : "Refresh now"}
            </button>
          </div>
        </header>

        {refreshError ? (
          <div className="ops-inline-alert ops-tone-warn" role="status" aria-live="polite">
            The latest refresh partially failed: {refreshError}. Existing data remains visible.
          </div>
        ) : null}

        {loading && !summaryAvailable ? <p className="text-body">Loading page...</p> : null}

        {summaryAvailable ? (
          <>
            <nav className="ops-control-nav" aria-label="Settings sections">
              {sectionTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`ops-control-nav-btn${activeSection === tab.id ? " active" : ""}`}
                  onClick={() => setActiveSection(tab.id)}
                >
                  <strong>{tab.label}</strong>
                  <span>{tab.meta}</span>
                </button>
              ))}
            </nav>

            <section className="ops-control-hero" aria-label="System summary">
              <article className={`ops-control-focus ${toneClass(primaryInsight?.tone ?? "ok")}`}>
                <div className="ops-section-head">
                  <div className="ops-stack-tight">
                    <span className="ops-kicker">Focus now</span>
                    <h2 className="ops-hero-title">{primaryInsight?.title ?? "System stable"}</h2>
                  </div>
                  <span className={pillClass(overallTone)}>{overallStatusLabel}</span>
                </div>
                <p className="ops-hero-text">
                  {primaryInsight?.text ??
                    "The control room shows the live health of connectivity, tokens, the worker, and Spotify API traffic."}
                </p>
                <div className="ops-hero-chip-row">
                  <span className={`ops-hero-chip ${toneClass(authStatusTone)}`}>
                    Connection {authStatusLabel}
                  </span>
                  <span className={`ops-hero-chip ${toneClass(userTokenTone)}`}>
                    User token {userTokenSummary}
                  </span>
                  <span className={`ops-hero-chip ${toneClass(appTokenTone)}`}>
                    App token {appTokenSummary}
                  </span>
                  <span className={`ops-hero-chip ${toneClass(syncTone)}`}>
                    Sync {syncRunning ? "running" : "idle"}
                  </span>
                </div>
              </article>

              <div className="ops-control-metrics">
                <article className={`ops-mini-stat ${toneClass(primaryInsight?.tone ?? "ok")}`}>
                  <span className="ops-mini-stat-label">Focus now</span>
                  <strong className="ops-mini-stat-value">{primaryInsight?.title ?? "Stable"}</strong>
                  <span className="ops-mini-stat-meta">
                    {activeIncidentCount > 0
                      ? `${activeIncidentCount} active incidents`
                      : `${metricsWindowLabel} measurement window`}
                  </span>
                </article>
                <article className="ops-mini-stat ops-tone-ok">
                  <span className="ops-mini-stat-label">Library</span>
                  <strong className="ops-mini-stat-value">{fmtCount(totalLibraryItems)}</strong>
                  <span className="ops-mini-stat-meta">
                    {fmtCount(libraryCounts?.playlists)} playlists · {fmtCount(libraryCounts?.tracks)} tracks
                  </span>
                </article>
                <article className={`ops-mini-stat ${toneClass(apiTone)}`}>
                  <span className="ops-mini-stat-label">API health</span>
                  <strong className="ops-mini-stat-value">
                    {fmtPercent(summary?.apiHealth.successRate ?? 0)}
                  </strong>
                  <span className="ops-mini-stat-meta">
                    {apiSampleCount} requests · {summary?.apiHealth.upstream5xx ?? 0} server errors
                  </span>
                </article>
                <article className={`ops-mini-stat ${toneClass(latencyTone)}`}>
                  <span className="ops-mini-stat-label">P95 latency</span>
                  <strong className="ops-mini-stat-value">{foregroundLatencyP95} ms</strong>
                  <span className="ops-mini-stat-meta">
                    bg {backgroundLatencyP95} ms · {topSlowActivity?.label ?? "no hotspot"}
                  </span>
                </article>
              </div>
            </section>

            {activeSection === "overview" ? (
              <section className="ops-dashboard-grid" aria-label="Overview">
                <article className="panel ops-panel ops-span-8">
                  <div className="ops-section-head">
                    <h3 className="ops-section-title">Operator overview</h3>
                    <HelpTip
                      label="Operator overview"
                      text="The core app status, translated directly into what needs attention right now."
                    />
                  </div>
                  <div className="ops-priority-grid">
                    <article className={`ops-priority-lead ${toneClass(primaryInsight?.tone ?? "ok")}`}>
                      <div className="ops-priority-head">
                        <span className={pillClass(primaryInsight?.tone ?? "ok")}>{overallStatusLabel}</span>
                        <span className="text-subtle">{profileLabel}</span>
                      </div>
                      <strong className="ops-priority-title">{primaryInsight?.title}</strong>
                      <p className="ops-priority-text">{primaryInsight?.text}</p>
                    </article>
                    <div className="ops-priority-stack">
                      {supportingInsights.length ? (
                        supportingInsights.map((item) => <AlertCard key={item.id} item={item} />)
                      ) : (
                        <article className="ops-alert-card ops-tone-ok">
                          <span className="pill pill-success">All good</span>
                          <strong>No extra concerns</strong>
                          <p className="text-subtle">
                            Tokens, API, and synchronization currently look stable.
                          </p>
                        </article>
                      )}
                    </div>
                  </div>
                </article>

                <article className="panel ops-panel ops-span-4">
                  <div className="ops-section-head">
                    <h3 className="ops-section-title">Recommended actions</h3>
                    <HelpTip
                      label="Recommended actions"
                      text="The most useful immediate actions for operator and developer."
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
                      Connect Spotify
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={actionBusy !== null || tokenRefreshCooldownLeftSec > 0}
                      onClick={async () => {
                        const payload = await runAction(
                          "Refresh token",
                          "/api/monitoring/token/refresh",
                          "POST",
                          () => "Token refreshed"
                        );
                        if (payload) {
                          setTokenRefreshCooldownUntil(Date.now() + 10_000);
                        }
                      }}
                    >
                      {tokenRefreshCooldownLeftSec > 0
                        ? `Wait ${tokenRefreshCooldownLeftSec}s`
                        : actionBusy === "Refresh token"
                        ? "Working..."
                        : "Refresh token"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={actionBusy !== null}
                      onClick={async () => {
                        const ok = window.confirm(
                          "Refreshing the library can briefly add load. Start now?"
                        );
                        if (!ok) return;
                        await runBulkSync();
                      }}
                    >
                      {actionBusy === "Refresh library" ? "Working..." : "Library sync"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={rateLimitLogLoading}
                      onClick={async () => {
                        setActiveSection("diagnostics");
                        setRateLimitLogOpen(true);
                        await loadRateLimitActivityLog();
                      }}
                    >
                      {rateLimitLogLoading ? "Loading log..." : `Rate-limit log (${fmtCount(rateLimitActivityTotal)})`}
                    </button>
                  </div>
                </article>

                <article className="panel ops-panel ops-span-12">
                  <div className="ops-section-head">
                    <h3 className="ops-section-title">Service status</h3>
                    <HelpTip
                      label="Service status"
                      text="Compacte statuskaarten voor de belangrijkste subsysteem-statussen."
                    />
                  </div>
                  <div className="ops-service-grid">
                    {serviceCards.map((card) => (
                      <article key={card.title} className={`ops-service-card ${toneClass(card.tone)}`}>
                        <span className="ops-mini-stat-label">{card.title}</span>
                        <strong className="ops-service-value">{card.value}</strong>
                        <span className="ops-mini-stat-meta">{card.meta}</span>
                      </article>
                    ))}
                  </div>
                </article>
              </section>
            ) : null}

            {activeSection === "health" ? (
              <section className="ops-dashboard-grid" aria-label="Health">
                <article className="panel ops-panel ops-span-12">
                  <div className="ops-section-head">
                    <h3 className="ops-section-title">App health</h3>
                    <HelpTip
                      label="App health"
                      text="Observe auth, tokens, API stability, latency, and rate limiting from one central overview."
                    />
                  </div>
                  <section className="ops-kpi-grid" aria-label="Health metrics">
                    <KpiCard
                      title="Connection"
                      value={authStatusLabel}
                      subtitle={summary?.authStatus.userId ?? "no user"}
                      tone={authStatusTone}
                      meter={authStatusTone === "ok" ? 1 : authStatusTone === "warn" ? 0.55 : 0.2}
                      hint="Shows whether Spotify auth is directly usable for playback and device actions."
                    />
                    <KpiCard
                      title="API reliability"
                      value={fmtPercent(summary?.apiHealth.successRate ?? 0)}
                      subtitle={`${apiSampleCount} req in ${metricsWindowLabel} · ${summary?.apiHealth.upstream5xx ?? 0} server errors · ${restrictionViolatedCount} restrictions`}
                      tone={apiTone}
                      meter={summary?.apiHealth.successRate ?? 0}
                      hint="Percentage of successful Spotify requests in a recent time window. An expected 'no active player' 404 does not count as an error."
                    />
                    <KpiCard
                      title="Responsiveness"
                      value={`${foregroundLatencyP95} ms`}
                      subtitle={responsivenessSummary}
                      tone={latencyTone}
                      meter={1 - clamp01(foregroundLatencyP95 / 1800)}
                      details={[
                        { label: "User actions p95", value: `${foregroundLatencyP95} ms` },
                        { label: "Background p95", value: `${backgroundLatencyP95} ms` },
                        {
                          label: "Current hotspot",
                          value: topSlowActivityLabel ?? "No hotspot",
                        },
                        {
                          label: "Observed",
                          value: topSlowActivity
                            ? `${fmtCount(topSlowActivity.count)} samples`
                            : `${metricsWindowLabel} window`,
                        },
                      ]}
                      hint="Shows foreground request latency for UX, with background latency as context."
                      featured
                    />
                    <KpiCard
                      title="Rate limit"
                      value={`${summary?.rateLimits.count429 ?? 0}`}
                      subtitle={rateBackoffSubtitleWithWindow}
                      tone={rateTone}
                      meter={1 - clamp01((summary?.rateLimits.count429 ?? 0) / 20)}
                      hint="Number of 429 responses in the recent measurement window. With active backoff, this card counts down live to 0s."
                    />
                    <KpiCard
                      title="User token"
                      value={userTokenSummary}
                      subtitle={`Refresh ok ${fmtCount(summary?.tokenHealth.refreshSuccessCount ?? 0)}`}
                      tone={userTokenTone}
                      meter={userTokenExpirySec == null ? 0.4 : userTokenExpirySec / 3600}
                      hint="Shows remaining token lifetime and how stable automatic refresh is."
                    />
                    <KpiCard
                      title="App token"
                      value={appTokenSummary}
                      subtitle={`Refresh ok ${fmtCount(summary?.appTokenHealth.refreshSuccessCount ?? 0)}`}
                      tone={appTokenTone}
                      meter={appTokenExpirySec == null ? 0.4 : appTokenExpirySec / 3600}
                      hint="Client credentials token for app-level Spotify calls."
                    />
                  </section>
                </article>

                <article className="panel ops-panel ops-span-12">
                  <div className="ops-section-head">
                    <h3 className="ops-section-title">Services & runtime</h3>
                  </div>
                  <div className="ops-service-grid">
                    {serviceCards.map((card) => (
                      <article key={card.title} className={`ops-service-card ${toneClass(card.tone)}`}>
                        <span className="ops-mini-stat-label">{card.title}</span>
                        <strong className="ops-service-value">{card.value}</strong>
                        <span className="ops-mini-stat-meta">{card.meta}</span>
                      </article>
                    ))}
                  </div>
                </article>
              </section>
            ) : null}

            {activeSection === "data" ? (
              <section className="ops-dashboard-grid" aria-label="Data and sync">
                <article className="panel ops-panel ops-span-12">
                  <div className="ops-section-head">
                    <h3 className="ops-section-title">Data inventory</h3>
                    <HelpTip
                      label="Data inventory"
                      text="Shows what is stored locally in the database and how the sync pipeline is doing."
                    />
                  </div>
                  <div className="ops-service-grid">
                    {dataInventory.map((item) => (
                      <article key={item.label} className="ops-service-card ops-tone-ok">
                        <span className="ops-mini-stat-label">{item.label}</span>
                        <strong className="ops-service-value">{item.value}</strong>
                      </article>
                    ))}
                  </div>
                </article>

                <article className="panel ops-panel ops-span-12">
                  <div className="ops-section-head">
                    <h3 className="ops-section-title">Sync resources</h3>
                    <HelpTip
                      label="Sync resources"
                      text="For each resource you can see status, last success, failures, and retry information."
                    />
                  </div>
                  {syncResources.length ? (
                    <div className="ops-sync-table">
                      <div className="ops-sync-table-head">
                        <span>Resource</span>
                        <span>Status</span>
                        <span>Last success</span>
                        <span>Failures</span>
                        <span>Last update</span>
                      </div>
                      {syncResources.map((row) => (
                        <div key={row.resource} className="ops-sync-table-row">
                          <strong>{row.resource}</strong>
                          <span>{row.status}</span>
                          <span>{fmtDateTime(row.lastSuccessfulAt ?? null)}</span>
                          <span>{fmtCount(row.failureCount ?? 0)}</span>
                          <span>{fmtDateTime(row.updatedAt ?? null)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-subtle">No sync resources available yet.</div>
                  )}
                </article>
              </section>
            ) : null}

            {activeSection === "diagnostics" ? (
              <section className="ops-dashboard-grid" aria-label="Diagnostics">
                <article className="panel ops-panel ops-span-6">
                  <div className="ops-section-head">
                    <h3 className="ops-section-title">Error mix by endpoint</h3>
                    <HelpTip
                      label="Error mix"
                      text="Endpoint categories that produce the most errors in the current measurement window. Click to filter recent errors."
                    />
                  </div>
                  {topErrors.length ? (
                    <div className="ops-mix-list">
                      {topErrors.map((row) => {
                        const endpointMeta = describeEndpoint(row.label);
                        const endpointKey = normalizeEndpointKey(row.label);
                        const isActive = normalizeEndpointKey(selectedErrorEndpoint) === endpointKey;
                        return (
                          <button
                            key={row.label}
                            type="button"
                            className={`ops-mix-row ops-mix-row-btn${isActive ? " is-active" : ""}`}
                            title={endpointMeta.title}
                            onClick={() => {
                              setSelectedErrorEndpoint((prev) =>
                                normalizeEndpointKey(prev) === endpointKey ? null : row.label
                              );
                            }}
                          >
                            <div className="ops-mix-label">
                              <span className="ops-mix-main">{endpointMeta.label}</span>
                              <span className="ops-mix-raw">{endpointMeta.raw}</span>
                            </div>
                            <div className="ops-mix-meter" aria-hidden="true">
                              <span style={{ width: `${Math.max(4, (row.value / maxErrorCount) * 100)}%` }} />
                            </div>
                            <div className="ops-mix-value">{row.value}</div>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-subtle">No errors in the current measurement.</div>
                  )}
                </article>

                <article className="panel ops-panel ops-span-6">
                  <div className="ops-section-head">
                    <h3 className="ops-section-title">
                      {selectedErrorEndpointMeta
                        ? `Recent errors · ${selectedErrorEndpointMeta.label}`
                        : "Recent errors & context"}
                    </h3>
                  </div>
                  {visibleRecentErrors.length ? (
                    <div className="ops-recent-list" role="status" aria-live="polite">
                      {visibleRecentErrors.map((item) => {
                        const endpoint = describeEndpoint(item.endpoint ?? "unknown");
                        const codeMeta = describeErrorCode(item.code);
                        const message = describeRecentErrorMessage({
                          code: item.code,
                          endpointRaw: endpoint.raw.toLowerCase(),
                          message: item.message,
                        });
                        return (
                          <div key={item.id} className="ops-recent-row">
                            <div className="ops-recent-top">
                              <span className="ops-recent-time">{fmtCompactTime(item.at)}</span>
                              <span className={`ops-recent-code ops-recent-code-${codeMeta.tone}`}>
                                {codeMeta.label}
                              </span>
                            </div>
                            <strong>{endpoint.label}</strong>
                            <div className="text-subtle">{message}</div>
                            <div className="ops-recent-extra">{codeMeta.help}</div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-subtle">No recent errors.</div>
                  )}
                </article>

                <article className="panel ops-panel ops-span-12">
                  <div className="ops-section-head">
                    <h3 className="ops-section-title">Rate-limit activity</h3>
                    <div className="ops-inline-actions">
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => {
                          setRateLimitLogOpen(true);
                          void loadRateLimitActivityLog();
                        }}
                        disabled={rateLimitLogLoading}
                      >
                        {rateLimitLogLoading ? "Loading..." : "Load activity log"}
                      </button>
                      <button type="button" className="btn btn-secondary" onClick={() => void runDiagnosticsExport()}>
                        Export diagnostics
                      </button>
                    </div>
                  </div>
                  {rateLimitLogOpen && rateLimitLogEntries.length > 0 ? (
                    <div className="ops-recent-list">
                      {rateLimitLogEntries.slice(0, 12).map((item, index) => (
                        <div key={`${item.at}:${item.correlationId}:${index}`} className="ops-recent-row">
                          <div className="ops-recent-top">
                            <span className="ops-recent-time">{fmtCompactTime(item.at)}</span>
                            <span className="ops-recent-code ops-recent-code-warn">
                              {formatRateLimitSource(item.source)}
                            </span>
                          </div>
                          <strong>{item.activity}</strong>
                          <div className="text-subtle">
                            {item.method.toUpperCase()} {item.endpointPath || "unknown path"} ·{" "}
                            {item.endpoint || "unknown endpoint"}
                          </div>
                          <div className="ops-recent-extra">
                            reliability {formatImpactLevel(item.impact?.reliability)} · responsiveness{" "}
                            {formatImpactLevel(item.impact?.responsiveness)} · status {item.statusCode}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-subtle">
                      {rateLimitLogOpen
                        ? "No rate-limit activity available."
                        : "Load the activity log for live details on 429s and local limiter events."}
                    </div>
                  )}

                  {recentSlowActivities.length ? (
                    <div className="ops-diagnostics-inline-list">
                      {recentSlowActivities.slice(0, 6).map((item) => (
                        <div key={`${item.at}-${item.correlationId}`} className="ops-diagnostics-inline-item">
                          <strong>{item.activity}</strong>
                          <span className="text-subtle">
                            {item.durationMs} ms · {item.endpointPath}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              </section>
            ) : null}

            {activeSection === "actions" ? (
              <section className="ops-dashboard-grid" aria-label="Actions and configuration">
                <article className="panel ops-panel ops-span-6">
                  <div className="ops-section-head">
                    <h3 className="ops-section-title">Interventions</h3>
                    <HelpTip
                      label="Interventions"
                      text="Safe recovery and maintenance actions without shell work."
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
                      Connect Spotify
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={actionBusy !== null}
                      onClick={() => void runAction("API test", "/api/monitoring/test-api", "POST")}
                    >
                      {actionBusy === "API test" ? "Working..." : "API test"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={actionBusy !== null}
                      onClick={async () => {
                        const payload = await runAction(
                          "Refresh token",
                          "/api/monitoring/token/refresh",
                          "POST",
                          () => "Token refreshed"
                        );
                        if (payload) setTokenRefreshCooldownUntil(Date.now() + 10_000);
                      }}
                    >
                      Refresh token
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={actionBusy !== null}
                      onClick={async () => {
                        const ok = window.confirm(
                          "Refreshing the library can briefly add load. Start now?"
                        );
                        if (!ok) return;
                        await runBulkSync();
                      }}
                    >
                      Library sync
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={actionBusy !== null}
                      onClick={() => void runAction("Cache reset", "/api/monitoring/cache/clear", "POST", () => "Caches and metrics cleared")}
                    >
                      Cache reset
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={actionBusy !== null}
                      onClick={async () => {
                        const ok = window.confirm("Signing out closes the app session. Continue?");
                        if (!ok) return;
                        setActionBusy("Sign out of app");
                        try {
                          await clientFetch("/api/pin-logout", { method: "POST" });
                        } finally {
                          window.location.href = "/login";
                        }
                      }}
                    >
                      Sign out of app
                    </button>
                  </div>
                </article>

                <article className="panel ops-panel ops-span-6">
                  <div className="ops-section-head">
                    <h3 className="ops-section-title">Configuration & behavior</h3>
                  </div>
                  <div className="ops-settings-list">
                    <label className="ops-settings-control ops-switch-row">
                      <span className="ops-settings-control-copy">
                        <strong>Auto refresh</strong>
                        <small>Keeps the control room live without manual refreshes.</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={autoRefresh}
                        onChange={(event) => setAutoRefresh(event.target.checked)}
                      />
                    </label>
                    <label className="ops-settings-control ops-input-row">
                      <span className="ops-settings-control-copy">
                        <strong>Refresh interval</strong>
                        <small>Choose how often fresh status and error data is fetched.</small>
                      </span>
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
                        <option value="5">5 seconds</option>
                        <option value="10">10 seconds</option>
                        <option value="15">15 seconds</option>
                        <option value="30">30 seconds</option>
                        <option value="60">60 seconds</option>
                      </select>
                    </label>
                  </div>

                  <div className="ops-keyvalue-list">
                    <div className="ops-keyvalue-row">
                      <span className="text-subtle">Redis / Upstash</span>
                      <strong>{runtimeFlags?.hasUpstash ? "Active" : "Not configured"}</strong>
                    </div>
                    <div className="ops-keyvalue-row">
                      <span className="text-subtle">Trust proxy</span>
                      <strong>{runtimeFlags?.trustProxy ? "Yes" : "No"}</strong>
                    </div>
                    <div className="ops-keyvalue-row">
                      <span className="text-subtle">Auth log</span>
                      <strong>{runtimeFlags?.authLogEnabled ? "Enabled" : "Off"}</strong>
                    </div>
                  </div>
                </article>

                <article className="panel ops-panel ops-span-12 ops-history-panel">
                  <div className="ops-section-head">
                    <h3 className="ops-section-title">Action history</h3>
                  </div>
                  {actionHistory.length ? (
                    <div className="ops-history-list">
                      {actionHistory.map((entry) => (
                        <div key={entry.id} className="ops-history-row">
                          <div className="ops-history-top">
                            <span className={entry.outcome === "success" ? "pill pill-success" : "pill pill-error"}>
                              {entry.outcome === "success" ? "Success" : "Failed"}
                            </span>
                            <span className="ops-recent-time">{fmtCompactTime(entry.at)}</span>
                          </div>
                          <strong>{entry.name}</strong>
                          <div className="text-subtle">{entry.message}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-subtle">No actions executed in this session yet.</div>
                  )}
                </article>

                <article className="panel ops-panel ops-span-12">
                  <div className="ops-section-head">
                    <h3 className="ops-section-title">Playback feature flags</h3>
                  </div>
                  <div className="ops-flag-grid">
                    {featureFlags.map(([key, enabled]) => (
                      <div key={key} className="ops-flag-item">
                        <strong>{key}</strong>
                        <span className={enabled ? "pill pill-success" : "pill pill-warn"}>
                          {enabled ? "on" : "off"}
                        </span>
                      </div>
                    ))}
                  </div>
                </article>
              </section>
            ) : null}

            {activeSection === "ai" ? (
              <section className="ops-dashboard-grid" aria-label="AI prompt">
                <article className="panel ops-panel ops-span-12">
                  <PromptSettingsPanel />
                </article>
              </section>
            ) : null}
          </>
        ) : null}
      </section>
    </main>
  );
}
