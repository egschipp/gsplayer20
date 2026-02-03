"use client";

import { usePathname } from "next/navigation";

export default function MainNav() {
  const pathname = usePathname();
  const isHome = pathname === "/";
  const isStatus = pathname === "/status";

  return (
    <nav className="nav">
      <a href="/" className={`nav-link${isHome ? " active" : ""}`} aria-current={isHome ? "page" : undefined}>
        GSPlayer
      </a>
      <a
        href="/status"
        className={`nav-link${isStatus ? " active" : " secondary"}`}
        aria-current={isStatus ? "page" : undefined}
      >
        Status
      </a>
    </nav>
  );
}
