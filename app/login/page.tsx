"use client";

import Image from "next/image";
import { useState } from "react";

export default function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string };
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/pin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data?.error === "PIN_LOCKED" && data?.retryAfter) {
          setError(`Too many attempts. Try again in ${data.retryAfter}s.`);
        } else if (data?.error === "MISCONFIGURED") {
          setError("PIN not configured. Check APP_PIN and AUTH_SECRET.");
        } else if (data?.error === "INVALID_ORIGIN") {
          setError("Invalid origin. Check AUTH_URL/NEXTAUTH_URL.");
        } else {
          setError("Incorrect PIN. Try again.");
        }
        return;
      }
      const next = searchParams?.next || "/";
      window.location.href = next;
    } catch {
      setError("Login failed. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <Image
          src="/georgies-spotify.png"
          alt="Georgies Spotify logo"
          width={160}
          height={160}
          className="login-logo"
          priority
        />
        <h1 className="login-title">Georgies Spotify</h1>
        <p className="text-subtle">Enter your PIN to continue.</p>
        <form onSubmit={handleSubmit} className="login-form">
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            className="input"
            placeholder="PIN"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            required
          />
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? "Checking..." : "Unlock"}
          </button>
        </form>
        {error ? <div className="text-subtle">{error}</div> : null}
      </div>
    </div>
  );
}
