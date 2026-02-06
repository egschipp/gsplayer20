"use client";

import { useEffect, useState } from "react";

type AppStatus = {
  status: string;
  detail?: number;
};

type UserStatus = {
  status: string;
  scope?: string;
  profile?: { display_name?: string; email?: string };
};

function Badge({ label, tone }: { label: string; tone?: "ok" | "warn" }) {
  const cls = tone === "ok" ? "pill pill-success" : "pill pill-warn";
  return <span className={cls}>{label}</span>;
}

export default function SpotifyStatus({ showBadges = true }: { showBadges?: boolean }) {
  const [appStatus, setAppStatus] = useState<AppStatus | null>(null);
  const [userStatus, setUserStatus] = useState<UserStatus | null>(null);
  const userName = userStatus?.profile?.display_name || userStatus?.profile?.email;
  const appOk = appStatus?.status === "OK";
  const userOk = userStatus?.status === "OK";
  const userMessage =
    userStatus?.status === "OK"
      ? userName
        ? `Verbonden als ${userName}.`
        : "Verbonden met Spotify."
      : userStatus?.status === "ERROR_SCOPES"
      ? "Toestemmingen ontbreken. Verbind opnieuw."
      : userStatus?.status === "ERROR_REVOKED"
      ? "Spotify‑toegang is ingetrokken. Verbind opnieuw."
      : userStatus?.status === "LOGGED_OUT"
      ? "Nog niet verbonden."
      : userStatus?.status === "ERROR_NETWORK"
      ? "Spotify is tijdelijk niet bereikbaar."
      : "Status wordt gecontroleerd.";
  const appMessage =
    appStatus?.status === "OK"
      ? "Spotify‑koppeling werkt."
      : appStatus?.status === "ERROR_MISSING_ENV"
      ? "App mist configuratie."
      : appStatus?.status === "ERROR_AUTH"
      ? "App kan niet authenticeren."
      : appStatus?.status === "ERROR_NETWORK"
      ? "Spotify is tijdelijk niet bereikbaar."
      : "Status wordt gecontroleerd.";

  useEffect(() => {
    fetch("/api/spotify/app-status")
      .then((res) => res.json())
      .then(setAppStatus)
      .catch(() => setAppStatus({ status: "ERROR_NETWORK" }));

    fetch("/api/spotify/user-status")
      .then((res) => res.json())
      .then(setUserStatus)
      .catch(() => setUserStatus({ status: "ERROR_NETWORK" }));
  }, []);

  return (
    <section style={{ marginTop: 24 }}>
      <h2 className="heading-2">Spotify‑koppeling</h2>
      {showBadges ? (
        <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Badge
            label={`App: ${appStatus?.status ?? "CHECKING"}`}
            tone={appOk ? "ok" : "warn"}
          />
          <Badge
            label={`Account: ${userStatus?.status ?? "CHECKING"}`}
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
          Spotify verbinden
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            window.location.href = "/api/auth/logout";
          }}
        >
          Spotify loskoppelen
        </button>
      </div>
    </section>
  );
}
