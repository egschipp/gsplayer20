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

function Badge({ label }: { label: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "4px 10px",
        borderRadius: 999,
        background: "#0f172a",
        color: "white",
        fontSize: 12,
        marginRight: 8,
      }}
    >
      {label}
    </span>
  );
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
      <h2>Spotify Connection</h2>
      <div style={{ marginTop: 12 }}>
        <Badge label={`App: ${appStatus?.status ?? "CHECKING"}`} />
        <Badge label={`User: ${userStatus?.status ?? "CHECKING"}`} />
      </div>
      <div style={{ marginTop: 16 }}>
        <a
          href="/api/auth/login"
          style={{
            display: "inline-block",
            padding: "10px 16px",
            background: "#1db954",
            color: "white",
            borderRadius: 8,
            textDecoration: "none",
            marginRight: 12,
          }}
        >
          Connect Spotify
        </a>
        <a href="/api/auth/logout" style={{ color: "#0f172a" }}>
          Sign out
        </a>
      </div>
    </section>
  );
}
