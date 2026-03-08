"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";

type AppStatus = {
  status: string;
  detail?: number;
};

type UserStatus = {
  status: string;
  scope?: string;
  profile?: { display_name?: string; email?: string };
};

function parseRetryAfterMs(res: Response) {
  const retryAfter = Number(res.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(Math.round(retryAfter * 1000), 60_000);
  }
  return 5_000;
}

function Badge({ label, tone }: { label: string; tone?: "ok" | "warn" }) {
  const cls = tone === "ok" ? "pill pill-success" : "pill pill-warn";
  return <span className={cls}>{label}</span>;
}

export default function SpotifyStatus({ showBadges = true }: { showBadges?: boolean }) {
  const { status: sessionStatus } = useSession();
  const [appStatus, setAppStatus] = useState<AppStatus | null>(null);
  const [userStatus, setUserStatus] = useState<UserStatus | null>(null);
  const authRateLimitedUntilRef = useRef(0);
  const effectiveUserStatus =
    sessionStatus === "unauthenticated"
      ? "LOGGED_OUT"
      : userStatus?.status ?? "CHECKING";
  const userName =
    effectiveUserStatus === "OK"
      ? userStatus?.profile?.display_name || userStatus?.profile?.email
      : null;
  const appOk = appStatus?.status === "OK";
  const userOk = effectiveUserStatus === "OK";
  const userMessage =
    effectiveUserStatus === "OK"
      ? userName
        ? `Connected as ${userName}.`
        : "Connected to Spotify."
      : effectiveUserStatus === "ERROR_SCOPES"
      ? "Required permissions are missing. Reconnect."
      : effectiveUserStatus === "ERROR_REVOKED"
      ? "Spotify access was revoked. Reconnect."
      : effectiveUserStatus === "LOGGED_OUT"
      ? "Not connected yet."
      : effectiveUserStatus === "ERROR_RATE_LIMIT"
      ? "Status check requested too often. Please wait."
      : effectiveUserStatus === "ERROR_NETWORK"
      ? "Spotify is temporarily unavailable."
      : "Checking status.";
  const appMessage =
    appStatus?.status === "OK"
      ? "Spotify app connection is healthy."
      : appStatus?.status === "ERROR_MISSING_ENV"
      ? "App configuration is incomplete."
      : appStatus?.status === "ERROR_AUTH"
      ? "App authentication failed."
      : appStatus?.status === "ERROR_NETWORK"
      ? "Spotify is temporarily unavailable."
      : "Checking status.";

  const refreshStatus = useCallback(async () => {
    if (Date.now() < authRateLimitedUntilRef.current) return;
    try {
      const [appRes, userRes] = await Promise.all([
        fetch("/api/spotify/app-status", { cache: "no-store" }),
        fetch("/api/spotify/user-status", { cache: "no-store" }),
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
        | AppStatus
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
      } else if (userRes.status === 401) {
        setUserStatus({ status: "LOGGED_OUT" });
      } else if (userRes.status === 403) {
        setUserStatus({ status: "ERROR_SCOPES" });
      } else if (userRes.status === 429) {
        setUserStatus({ status: "ERROR_RATE_LIMIT" });
      } else if (!userRes.ok) {
        setUserStatus({ status: "ERROR_NETWORK" });
      }
    } catch {
      setAppStatus({ status: "ERROR_NETWORK" });
      setUserStatus({ status: "ERROR_NETWORK" });
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void refreshStatus();
    }, 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshStatus();
    }, 15000);
    const handleResume = () => {
      void refreshStatus();
    };
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      void refreshStatus();
    };
    window.addEventListener("focus", handleResume);
    window.addEventListener("pageshow", handleResume);
    window.addEventListener("online", handleResume);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      window.removeEventListener("focus", handleResume);
      window.removeEventListener("pageshow", handleResume);
      window.removeEventListener("online", handleResume);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refreshStatus]);

  return (
    <section style={{ marginTop: 24 }}>
      <h2 className="heading-2">Spotify connection</h2>
      {showBadges ? (
        <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Badge
            label={`App: ${appStatus?.status ?? "CHECKING"}`}
            tone={appOk ? "ok" : "warn"}
          />
          <Badge
            label={`Account: ${effectiveUserStatus}`}
            tone={userOk ? "ok" : "warn"}
          />
        </div>
      ) : null}
      <div className="text-body" style={{ marginTop: 12 }}>
        <div>{appMessage}</div>
        <div>{userMessage}</div>
      </div>
      <div style={{ marginTop: 16, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            window.location.href = "/api/auth/login";
          }}
        >
          Connect Spotify
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            window.location.href = "/api/auth/logout";
          }}
        >
          Disconnect Spotify
        </button>
      </div>
    </section>
  );
}
