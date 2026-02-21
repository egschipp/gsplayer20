"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

function fmtPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtTime(value: number | null) {
  if (!value) return "n/a";
  return new Date(value).toLocaleString();
}

function Panel({
  title,
  children,
  span = "span-3",
}: {
  title: string;
  children: React.ReactNode;
  span?: string;
}) {
  return (
    <div className={`panel account-panel ${span}`}>
      <div className="account-panel-title">{title}</div>
      <div className="text-body">{children}</div>
    </div>
  );
}

export default function MonitoringDashboard() {
  const [summary, setSummary] = useState<SummaryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<null | string>(null);
  const [lastActionMessage, setLastActionMessage] = useState<string | null>(null);

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
    () => summary?.traffic.topEndpoints.slice(0, 4) ?? [],
    [summary]
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

  return (
    <main className="page settings-page">
      <section className="card account-page" style={{ marginTop: 24 }}>
        <div className="account-header">
          <div className="account-panel-title">Monitoring Dashboard</div>
          <div className="text-subtle">
            Laatste update: {summary ? fmtTime(summary.generatedAt) : "laden..."}
          </div>
        </div>

        {loading ? <p className="text-body">Dashboard laden...</p> : null}
        {error ? <p className="text-body">Dashboard error: {error}</p> : null}

        {summary ? (
          <div className="account-grid">
            <Panel title="Auth Status">
              <div>Status: {summary.authStatus.status}</div>
              <div>Gebruiker: {summary.authStatus.userId ?? "n/a"}</div>
              <div>Scopes: {summary.authStatus.scopes.join(", ") || "n/a"}</div>
              <div>Laatste auth: {fmtTime(summary.authStatus.lastAuthAt)}</div>
            </Panel>

            <Panel title="Token Health">
              <div>Expires in: {summary.tokenHealth.expiresInSec ?? "n/a"}s</div>
              <div>Refresh success: {fmtPercent(summary.tokenHealth.refreshSuccessRate)}</div>
              <div>invalid_grant: {summary.tokenHealth.invalidGrantCount}</div>
              <div>Lock wait p95: {summary.tokenHealth.lockWaitP95Ms}ms</div>
            </Panel>

            <Panel title="API Health">
              <div>Success rate: {fmtPercent(summary.apiHealth.successRate)}</div>
              <div>
                Latency p50/p95/p99: {summary.apiHealth.latencyMs.p50}/
                {summary.apiHealth.latencyMs.p95}/{summary.apiHealth.latencyMs.p99}ms
              </div>
              <div>Upstream 5xx: {summary.apiHealth.upstream5xx}</div>
            </Panel>

            <Panel title="Rate Limits">
              <div>429 count: {summary.rateLimits.count429}</div>
              <div>Backoff state: {summary.rateLimits.backoffState}</div>
            </Panel>

            <Panel title="Traffic" span="span-6">
              <div>Requests/min: {summary.traffic.requestsPerMin}</div>
              <div>Active users: {summary.traffic.activeUsers ?? "n/a"}</div>
              <div style={{ marginTop: 8 }}>
                {topEndpoints.length ? (
                  topEndpoints.map((row) => (
                    <div key={row.endpoint} className="text-subtle">
                      {row.endpoint}: {row.rpm}/min
                    </div>
                  ))
                ) : (
                  <span className="text-subtle">Geen endpointdata</span>
                )}
              </div>
            </Panel>

            <Panel title="Webhook/Callback Health" span="span-6">
              <div>Ingeschakeld: {summary.callbackHealth.enabled ? "ja" : "nee"}</div>
              <div>Latency p95: {summary.callbackHealth.latencyP95Ms ?? "n/a"}ms</div>
              <div>Failures: {summary.callbackHealth.failures}</div>
            </Panel>

            <Panel title="Recent Errors" span="span-6">
              {summary.recentErrors.length ? (
                summary.recentErrors.slice(0, 6).map((item) => (
                  <div key={item.id} className="text-subtle" style={{ marginBottom: 6 }}>
                    {new Date(item.at).toLocaleTimeString()} • {item.code} • {item.correlationId}
                  </div>
                ))
              ) : (
                <span className="text-subtle">Geen recente fouten.</span>
              )}
            </Panel>

            <Panel title="Incidents/Alerts" span="span-6">
              {summary.incidents.active.length ? (
                summary.incidents.active.map((incident) => (
                  <div key={incident.id} className="text-subtle" style={{ marginBottom: 6 }}>
                    [{incident.severity}] {incident.title}
                  </div>
                ))
              ) : (
                <span className="text-subtle">Geen actieve alerts.</span>
              )}
              <div className="text-subtle" style={{ marginTop: 8 }}>
                Runbook: {summary.incidents.runbookUrl}
              </div>
            </Panel>
          </div>
        ) : null}
      </section>

      <section className="card account-page" style={{ marginTop: 20 }}>
        <div className="account-panel-title">Settings & Acties</div>
        <div className="account-actions" style={{ marginTop: 12 }}>
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
          <button
            type="button"
            className="btn btn-secondary"
            disabled={actionBusy !== null}
            onClick={() =>
              runAction("Test API", "/api/monitoring/test-api", "POST")
            }
          >
            {actionBusy === "Test API" ? "Bezig..." : "Test API call"}
          </button>
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
        {lastActionMessage ? (
          <div className="text-subtle" style={{ marginTop: 10 }}>
            {lastActionMessage}
          </div>
        ) : null}
      </section>

      <details className="card account-page" style={{ marginTop: 20 }}>
        <summary className="details-summary">
          Geavanceerde settings (bestaand)
          <span aria-hidden="true">▾</span>
        </summary>
        <StatusBox />
      </details>
    </main>
  );
}
