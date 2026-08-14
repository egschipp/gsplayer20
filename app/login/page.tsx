"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const router = useRouter();
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
          setError(
            `Te veel pogingen. Probeer het over ${data.retryAfter} seconden opnieuw.`
          );
        } else if (data?.error === "MISCONFIGURED") {
          setError("De pincodebeveiliging is niet geconfigureerd.");
        } else if (data?.error === "INVALID_ORIGIN") {
          setError("De aanvraag kwam van een ongeldig adres.");
        } else {
          setError("Onjuiste pincode. Probeer het opnieuw.");
        }
        return;
      }
      const requestedTarget =
        new URLSearchParams(window.location.search).get("next") || "/";
      const next =
        requestedTarget.startsWith("/") && !requestedTarget.startsWith("//")
          ? requestedTarget
          : "/";
      router.replace(next);
      router.refresh();
    } catch {
      setError("Inloggen is mislukt. Probeer het opnieuw.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main id="main-content" tabIndex={-1} className="login-shell">
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
          <label htmlFor="app-pin" className="sr-only">
            Pincode
          </label>
          <input
            id="app-pin"
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
            {loading ? "Controleren…" : "Ontgrendelen"}
          </button>
        </form>
        {error ? (
          <div className="text-subtle" role="alert" aria-live="assertive">
            {error}
          </div>
        ) : null}
      </div>
    </main>
  );
}
