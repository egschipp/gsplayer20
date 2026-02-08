"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

export default function MainNav() {
  const pathname = usePathname();
  const isHome = pathname === "/";
  const isStatus = pathname === "/status";
  const [loggingOut, setLoggingOut] = useState(false);

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
          Bibliotheek
        </Link>
        <Link
          href="/status"
          className={`nav-link${isStatus ? " active" : " secondary"}`}
          aria-current={isStatus ? "page" : undefined}
        >
          Account
        </Link>
      </div>
      <div className="nav-right">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={handleLogout}
          disabled={loggingOut}
        >
          {loggingOut ? "Uitloggen..." : "Uitloggen"}
        </button>
      </div>
    </nav>
  );
}
