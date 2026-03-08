"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export default function MainNav() {
  const pathname = usePathname();
  const isHome = pathname === "/";
  const isStatus = pathname === "/status";
  const isAbout = pathname === "/about";
  const isQueue = pathname === "/queue";
  const [loggingOut, setLoggingOut] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/version", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return null;
        return res.json().catch(() => null);
      })
      .then((data) => {
        if (cancelled) return;
        const version = typeof data?.version === "string" ? data.version.trim() : "";
        if (version) setAppVersion(version);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch("/api/pin-logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  }

  return (
    <nav className="nav">
      <div className="nav-left">
        <Link
          href="/"
          className={`nav-link${isHome ? " active" : ""}`}
          aria-current={isHome ? "page" : undefined}
        >
          My Music
        </Link>
        <Link
          href="/queue"
          className={`nav-link${isQueue ? " active" : " secondary"}`}
          aria-current={isQueue ? "page" : undefined}
        >
          Queue
        </Link>
        <Link
          href="/status"
          className={`nav-link${isStatus ? " active" : " secondary"}`}
          aria-current={isStatus ? "page" : undefined}
        >
          Settings
        </Link>
        <Link
          href="/about"
          className={`nav-link${isAbout ? " active" : " secondary"}`}
          aria-current={isAbout ? "page" : undefined}
        >
          About
        </Link>
      </div>
      <div className="nav-right">
        {appVersion ? (
          <span className="nav-version" aria-label={`Version ${appVersion}`}>
            v{appVersion}
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={handleLogout}
          disabled={loggingOut}
        >
          {loggingOut ? "Signing out..." : "Sign out"}
        </button>
      </div>
    </nav>
  );
}
