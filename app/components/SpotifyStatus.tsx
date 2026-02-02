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

export default function SpotifyStatus() {
  const [appStatus, setAppStatus] = useState<AppStatus | null>(null);
  const [userStatus, setUserStatus] = useState<UserStatus | null>(null);

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
      <h2 className="heading-2">Spotify Connection</h2>
      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Badge
          label={`App: ${appStatus?.status ?? "CHECKING"}`}
          tone={appStatus?.status === "OK" ? "ok" : "warn"}
        />
        <Badge
          label={`User: ${userStatus?.status ?? "CHECKING"}`}
          tone={userStatus?.status === "OK" ? "ok" : "warn"}
        />
      </div>
      <div style={{ marginTop: 16, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <a href="/api/auth/login" className="btn btn-primary">
          Connect Spotify
        </a>
        <a href="/api/auth/logout" className="btn btn-ghost">
          Sign out
        </a>
      </div>
    </section>
  );
}
