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
          setError(`Te veel pogingen. Probeer opnieuw over ${data.retryAfter}s.`);
        } else if (data?.error === "MISCONFIGURED") {
          setError("Pincode niet ingesteld. Controleer APP_PIN en AUTH_SECRET.");
        } else if (data?.error === "INVALID_ORIGIN") {
          setError("Ongeldige origin. Controleer AUTH_URL/NEXTAUTH_URL.");
        } else {
          setError("Onjuiste pincode. Probeer het opnieuw.");
        }
        return;
      }
      const next = searchParams?.next || "/";
      window.location.href = next;
    } catch {
      setError("Inloggen mislukt. Probeer het opnieuw.");
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
        <p className="text-subtle">Voer je pincode in om door te gaan.</p>
        <form onSubmit={handleSubmit} className="login-form">
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            className="input"
            placeholder="Pincode"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            required
          />
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? "Controleren..." : "Ontgrendelen"}
          </button>
        </form>
        {error ? <div className="text-subtle">{error}</div> : null}
      </div>
    </div>
  );
}
