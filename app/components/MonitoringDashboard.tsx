"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import StatusBox from "./StatusBox";
import { clientFetch } from "@/lib/http/clientFetch";

type SummaryPayload = {
  generatedAt: number;
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

type Tone = "ok" | "warn" | "error";

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
  if (normalized === "CONNECTED" || normalized === "OK") return "Connected";
  if (normalized === "REAUTH_REQUIRED") return "Herlogin nodig";
  if (normalized === "DISCONNECTED") return "Disconnected";
  if (normalized === "CHECKING") return "Controleren";
  return status;
}

const ENDPOINT_LABEL_MAP: Record<string, { label: string; description: string }> = {
  me_player: {
    label: "Player bediening",
    description: "Acties voor play/pause/next, seek en device playback-status.",
  },
  me_tracks: {
    label: "Liked Songs",
    description: "Lezen/schrijven van tracks in je persoonlijke library.",
  },
  me_playlists: {
    label: "Playlists",
    description: "Ophalen en beheren van playlistoverzicht.",
  },
  playlists_items: {
    label: "Playlist tracks",
    description: "Items binnen playlists ophalen en aanpassen.",
  },
  me_player_devices: {
    label: "Connect devices",
    description: "Beschikbare Spotify Connect-apparaten ophalen.",
  },
  artists: {
    label: "Artiesten",
    description: "Artist metadata, details en related queries.",
  },
  tracks: {
    label: "Tracks",
    description: "Track metadata en trackgerichte requests.",
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

function MiniMetric({
  label,
  value,
  subtitle,
  tone = "ok",
  meter = null,
  hint,
}: {
  label: string;
  value: string;
  subtitle?: string;
  tone?: Tone;
  meter?: number | null;
  hint?: string;
}) {
  return (
    <div
      className={`monitoring-metric monitoring-tone-${tone} monitoring-tooltip-target`}
      data-tip={hint ?? ""}
      title={hint ?? undefined}
    >
      <div className="monitoring-metric-label">{label}</div>
      <div className="monitoring-metric-value">{value}</div>
      {subtitle ? <div className="monitoring-metric-subtitle">{subtitle}</div> : null}
      {meter != null ? (
        <div className="monitoring-meter" aria-hidden="true">
          <span style={{ width: `${Math.max(4, clamp01(meter) * 100)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function DataPanel({
  title,
  children,
  span = "6",
  hint,
}: {
  title: string;
  children: ReactNode;
  span?: "4" | "6" | "8" | "12";
  hint?: string;
}) {
  return (
    <div
      className={`panel monitoring-panel monitoring-span-${span} monitoring-tooltip-target`}
      data-tip={hint ?? ""}
      title={hint ?? undefined}
    >
      <div className="account-panel-title">{title}</div>
      {children}
    </div>
  );
}

export default function MonitoringDashboard() {
  const [summary, setSummary] = useState<SummaryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<null | string>(null);
  const [lastActionMessage, setLastActionMessage] = useState<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<"actions" | "advanced">("actions");

  const refreshSummary = useCallback(async () => {
    try {
      const res = await clientFetch("/api/monitoring/summary");
      if (!res.ok) {
        throw new Error(`summary_http_${res.status}`);
      }
      const data = (await res.json()) as SummaryPayload;
      setSummary(data);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSummary();
    const timer = window.setInterval(() => {
      void refreshSummary();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [refreshSummary]);

  const topEndpoints = useMemo(
    () => summary?.traffic.topEndpoints.slice(0, 6) ?? [],
    [summary]
  );
  const topEndpointRpm = useMemo(
    () => Math.max(1, ...topEndpoints.map((row) => row.rpm)),
    [topEndpoints]
  );
  const topErrors = useMemo(
    () => summary?.apiHealth.errorBreakdown.slice(0, 5) ?? [],
    [summary]
  );
  const maxErrorCount = useMemo(
    () => Math.max(1, ...topErrors.map((row) => row.value)),
    [topErrors]
  );

  async function runAction(
    name: string,
    url: string,
    method: "GET" | "POST" = "POST",
    onSuccess?: (payload: any) => string
  ) {
    setActionBusy(name);
    setLastActionMessage(null);
    try {
      const res = await clientFetch(url, { method });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error || `http_${res.status}`);
      }
      setLastActionMessage(onSuccess ? onSuccess(payload) : `${name} voltooid`);
      await refreshSummary();
      return payload;
    } catch (err) {
      setLastActionMessage(`${name} mislukt: ${String(err)}`);
      return null;
    } finally {
      setActionBusy(null);
    }
  }

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

  return (
    <main className="page settings-page monitoring-page">
      <section className="card monitoring-shell" style={{ marginTop: 24 }}>
        <div className="monitoring-header">
          <div className="monitoring-title-wrap">
            <div className="monitoring-title">Monitoring Dashboard</div>
            <div className="text-subtle">Advanced view voor snelle operationele checks</div>
          </div>
          <div className="monitoring-meta-wrap">
            <span className={pillClass(authStatusTone)}>Auth: {authStatusLabel}</span>
            <span className="monitoring-meta-time">
              Update {summary ? fmtCompactTime(summary.generatedAt) : "..."}
            </span>
          </div>
        </div>

        {loading ? <p className="text-body">Dashboard laden...</p> : null}
        {error ? <p className="text-body">Dashboard error: {error}</p> : null}

        {summary ? (
          <>
            <div className="monitoring-kpi-grid">
              <MiniMetric
                label="Koppeling"
                value={authStatusLabel}
                subtitle={summary.authStatus.userId ?? "geen gebruiker"}
                tone={authStatusTone}
                hint="Status van Spotify-koppeling. Groen is goed, oranje betekent aandacht, rood betekent dat koppelen of herlogin nodig is."
              />
              <MiniMetric
                label="Token"
                value={
                  summary.tokenHealth.expiresInSec == null
                    ? "n/a"
                    : `${summary.tokenHealth.expiresInSec}s`
                }
                subtitle={`refresh ${fmtPercent(summary.tokenHealth.refreshSuccessRate)}`}
                tone={tokenTone}
                meter={
                  summary.tokenHealth.expiresInSec == null
                    ? null
                    : summary.tokenHealth.expiresInSec / 3600
                }
                hint="Hoe lang je access token nog geldig is. Groen is ruim geldig, oranje bijna verlopen, rood direct actie nodig."
              />
              <MiniMetric
                label="API success"
                value={fmtPercent(summary.apiHealth.successRate)}
                subtitle={`5xx ${summary.apiHealth.upstream5xx}`}
                tone={toneByThreshold(summary.apiHealth.successRate, 0.97, 0.9)}
                meter={summary.apiHealth.successRate}
                hint="Aandeel succesvolle Spotify API-calls. Hoe hoger en groener, hoe stabieler de koppeling."
              />
              <MiniMetric
                label="Latency p95"
                value={`${summary.apiHealth.latencyMs.p95}ms`}
                subtitle={`p99 ${summary.apiHealth.latencyMs.p99}ms`}
                tone={
                  summary.apiHealth.latencyMs.p95 <= 450
                    ? "ok"
                    : summary.apiHealth.latencyMs.p95 <= 900
                    ? "warn"
                    : "error"
                }
                meter={1 - clamp01(summary.apiHealth.latencyMs.p95 / 1800)}
                hint="Snelheid van API-responses voor de traagste 5% requests. Groen is snel, oranje merkbaar trager, rood geeft UX-risico."
              />
              <MiniMetric
                label="Rate limits"
                value={`${summary.rateLimits.count429}`}
                subtitle={summary.rateLimits.backoffState}
                tone={
                  summary.rateLimits.count429 === 0
                    ? "ok"
                    : summary.rateLimits.count429 < 5
                    ? "warn"
                    : "error"
                }
                meter={1 - clamp01(summary.rateLimits.count429 / 20)}
                hint="Aantal rate-limit signalen. Groen is geen limietdruk, oranje tijdelijk druk, rood betekent dat acties vaker geblokkeerd raken."
              />
              <MiniMetric
                label="Requests/min"
                value={`${summary.traffic.requestsPerMin}`}
                subtitle={`actieve users ${summary.traffic.activeUsers ?? "n/a"}`}
                tone={summary.traffic.requestsPerMin > 0 ? "ok" : "warn"}
                meter={clamp01(summary.traffic.requestsPerMin / 120)}
                hint="Huidige API-verkeer per minuut. Dit helpt om load en piekmomenten te volgen."
              />
              <MiniMetric
                label="invalid_grant"
                value={`${summary.tokenHealth.invalidGrantCount}`}
                subtitle={`lock p95 ${summary.tokenHealth.lockWaitP95Ms}ms`}
                tone={
                  summary.tokenHealth.invalidGrantCount === 0
                    ? "ok"
                    : summary.tokenHealth.invalidGrantCount < 3
                    ? "warn"
                    : "error"
                }
                meter={1 - clamp01(summary.tokenHealth.invalidGrantCount / 10)}
                hint="Aantal refresh-token fouten. Groen is 0, oranje is incidenteel, rood betekent meestal opnieuw inloggen."
              />
              <MiniMetric
                label="Incidents"
                value={`${summary.incidents.active.length}`}
                subtitle={summary.incidents.active.length ? "actie nodig" : "stabiel"}
                tone={summary.incidents.active.length ? "error" : "ok"}
                meter={1 - clamp01(summary.incidents.active.length / 4)}
                hint="Actieve incidenten uit monitoringregels. Groen betekent geen open issues."
              />
            </div>

            <div className="monitoring-data-grid">
              <DataPanel
                title="Endpoint verkeer"
                span="8"
                hint="Top API-endpoints op volume. Lange balk = vaker gebruikt endpoint."
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
                        <div className="monitoring-endpoint-rpm">{row.rpm}/m</div>
                      </div>
                    );
                    })}
                  </div>
                ) : (
                  <div className="text-subtle">Nog geen endpointdata.</div>
                )}
              </DataPanel>

              <DataPanel
                title="Latency profiel"
                span="4"
                hint="Respons-snelheid verdeling. p50 is gemiddeld, p95/p99 laten piekvertraging zien."
              >
                <div className="monitoring-latency-list">
                  {["p50", "p95", "p99"].map((key) => {
                    const value =
                      key === "p50"
                        ? summary.apiHealth.latencyMs.p50
                        : key === "p95"
                        ? summary.apiHealth.latencyMs.p95
                        : summary.apiHealth.latencyMs.p99;
                    return (
                      <div key={key} className="monitoring-latency-row">
                        <div className="monitoring-latency-key">{key}</div>
                        <div className="monitoring-latency-meter" aria-hidden="true">
                          <span style={{ width: `${Math.max(6, (value / 1600) * 100)}%` }} />
                        </div>
                        <div className="monitoring-latency-value">{value}ms</div>
                      </div>
                    );
                  })}
                </div>
              </DataPanel>

              <DataPanel
                title="Error mix"
                span="6"
                hint="Welke errorgroepen het meest voorkomen. Rode langere balken zijn hoogste prioriteit."
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
                        <div className="monitoring-endpoint-bar monitoring-endpoint-bar-danger" aria-hidden="true">
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
                  <div className="text-subtle">Geen errorgroepen geregistreerd.</div>
                )}
              </DataPanel>

              <DataPanel
                title="Callback health"
                span="6"
                hint="Status van callback/webhook-keten. Toont of callback-pad beschikbaar en snel genoeg is."
              >
                <div className="monitoring-mini-stack">
                  <div className="monitoring-mini-row">
                    <span>Enabled</span>
                    <strong>{summary.callbackHealth.enabled ? "Ja" : "Nee"}</strong>
                  </div>
                  <div className="monitoring-mini-row">
                    <span>Latency p95</span>
                    <strong>{summary.callbackHealth.latencyP95Ms ?? "n/a"}ms</strong>
                  </div>
                  <div className="monitoring-mini-row">
                    <span>Failures</span>
                    <strong>{summary.callbackHealth.failures}</strong>
                  </div>
                  <div className="monitoring-mini-row">
                    <span>Laatste auth</span>
                    <strong>{fmtCompactTime(summary.authStatus.lastAuthAt)}</strong>
                  </div>
                </div>
              </DataPanel>

              <DataPanel
                title="Recente errors"
                span="6"
                hint="Laatste fouten met tijd en correlatie-id. Handig voor snelle troubleshooting."
              >
                {summary.recentErrors.length ? (
                  <div className="monitoring-feed-list">
                    {summary.recentErrors.slice(0, 6).map((item) => (
                      <div key={item.id} className="monitoring-feed-row">
                        <span className="monitoring-feed-time">
                          {new Date(item.at).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </span>
                        <span className="monitoring-feed-code">{item.code}</span>
                        <span className="monitoring-feed-correlation">{item.correlationId}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-subtle">Geen recente fouten.</div>
                )}
              </DataPanel>

              <DataPanel
                title="Incidents"
                span="6"
                hint="Open alerts met ernstniveau. Oranje/rood items hebben opvolging nodig."
              >
                {summary.incidents.active.length ? (
                  <div className="monitoring-feed-list">
                    {summary.incidents.active.map((incident) => (
                      <div key={incident.id} className="monitoring-incident-row">
                        <span className={`pill ${incident.severity === "P0" ? "pill-error" : "pill-warn"}`}>
                          {incident.severity}
                        </span>
                        <span className="monitoring-incident-title">{incident.title}</span>
                        <span className="monitoring-feed-time">
                          {new Date(incident.startedAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-subtle">Geen actieve alerts.</div>
                )}
                <div className="monitoring-runbook">Runbook: {summary.incidents.runbookUrl}</div>
              </DataPanel>
            </div>
          </>
        ) : null}
      </section>

      <section className="card monitoring-config-shell">
        <div className="monitoring-config-header">
          <div>
            <div className="monitoring-title">Settings & Acties</div>
            <div className="text-subtle">
              Basisacties en geavanceerde instellingen in één beheercentrum
            </div>
          </div>

          <div className="monitoring-tab-switch" role="tablist" aria-label="Dashboard instellingen">
            <button
              type="button"
              className={`monitoring-tab-btn ${settingsTab === "actions" ? "active" : ""}`}
              onClick={() => setSettingsTab("actions")}
              role="tab"
              aria-selected={settingsTab === "actions"}
            >
              Acties
            </button>
            <button
              type="button"
              className={`monitoring-tab-btn ${settingsTab === "advanced" ? "active" : ""}`}
              onClick={() => setSettingsTab("advanced")}
              role="tab"
              aria-selected={settingsTab === "advanced"}
            >
              Geavanceerd
            </button>
          </div>
        </div>

        {settingsTab === "actions" ? (
          <div className="monitoring-action-grid">
            <div className="monitoring-action-card">
              <div className="account-panel-title">Authenticatie</div>
              <div className="text-subtle">Nieuwe authorisatie flow starten.</div>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={actionBusy !== null}
                onClick={() => {
                  window.location.href = "/api/auth/login";
                }}
              >
                Re-auth
              </button>
            </div>

            <div className="monitoring-action-card">
              <div className="account-panel-title">Token refresh</div>
              <div className="text-subtle">Forceer direct verversen van access token.</div>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={actionBusy !== null}
                onClick={() =>
                  runAction("Force refresh", "/api/monitoring/token/refresh", "POST")
                }
              >
                {actionBusy === "Force refresh" ? "Bezig..." : "Force token refresh"}
              </button>
            </div>

            <div className="monitoring-action-card">
              <div className="account-panel-title">API check</div>
              <div className="text-subtle">Verifieer Spotify API bereikbaarheid.</div>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={actionBusy !== null}
                onClick={() => runAction("Test API", "/api/monitoring/test-api", "POST")}
              >
                {actionBusy === "Test API" ? "Bezig..." : "Test API call"}
              </button>
            </div>

            <div className="monitoring-action-card">
              <div className="account-panel-title">Cache</div>
              <div className="text-subtle">Leeg lokale monitoring cache en reload data.</div>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={actionBusy !== null}
                onClick={() =>
                  runAction("Clear cache", "/api/monitoring/cache/clear", "POST")
                }
              >
                {actionBusy === "Clear cache" ? "Bezig..." : "Clear cache"}
              </button>
            </div>

            <div className="monitoring-action-card">
              <div className="account-panel-title">Diagnostics export</div>
              <div className="text-subtle">Download JSON bundle met actuele status.</div>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={actionBusy !== null}
                onClick={async () => {
                  const payload = await runAction(
                    "Export diagnostics",
                    "/api/monitoring/diagnostics",
                    "GET",
                    () => "Diagnostics opgehaald"
                  );
                  if (!payload) return;
                  const blob = new Blob([JSON.stringify(payload, null, 2)], {
                    type: "application/json",
                  });
                  const url = URL.createObjectURL(blob);
                  const anchor = document.createElement("a");
                  anchor.href = url;
                  anchor.download = `gsplayer-diagnostics-${Date.now()}.json`;
                  anchor.click();
                  URL.revokeObjectURL(url);
                }}
              >
                {actionBusy === "Export diagnostics" ? "Bezig..." : "Export diagnostics"}
              </button>
            </div>

            <div className="monitoring-action-card">
              <div className="account-panel-title">Debug bundle</div>
              <div className="text-subtle">Kopieer diagnostiek direct naar klembord.</div>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={actionBusy !== null}
                onClick={async () => {
                  const payload = await runAction(
                    "Copy debug bundle",
                    "/api/monitoring/diagnostics",
                    "GET"
                  );
                  if (!payload) return;
                  await navigator.clipboard.writeText(JSON.stringify(payload));
                }}
              >
                {actionBusy === "Copy debug bundle" ? "Bezig..." : "Copy debug bundle"}
              </button>
            </div>
          </div>
        ) : (
          <div className="monitoring-advanced-shell">
            <StatusBox embedded />
          </div>
        )}

        {lastActionMessage ? (
          <div className="monitoring-action-message text-subtle">{lastActionMessage}</div>
        ) : null}
      </section>
    </main>
  );
}
