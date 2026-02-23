"use client";

import { useCallback, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";

const HEARTBEAT_URL = "/api/monitoring/token/heartbeat";
const ACTIVE_INTERVAL_MS = 55_000;
const HIDDEN_INTERVAL_MS = 120_000;
const ERROR_RETRY_MS = 20_000;
const POLL_TICK_MS = 10_000;

function parseRetryAfterMs(res: Response) {
  const retryAfter = Number(res.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(Math.round(retryAfter * 1000), 120_000);
  }
  return ERROR_RETRY_MS;
}

export default function TokenAutoRefresh() {
  const { status } = useSession();
  const nextRunAtRef = useRef(0);
  const inFlightRef = useRef(false);

  const runHeartbeat = useCallback(
    async (force = false) => {
      if (status !== "authenticated") return;

      const now = Date.now();
      if (!force && now < nextRunAtRef.current) return;
      if (inFlightRef.current) return;
      inFlightRef.current = true;

      try {
        const res = await fetch(HEARTBEAT_URL, {
          method: "POST",
          cache: "no-store",
        });
        if (res.status === 429) {
          nextRunAtRef.current = Date.now() + parseRetryAfterMs(res);
          return;
        }
        if (!res.ok) {
          nextRunAtRef.current = Date.now() + ERROR_RETRY_MS;
          return;
        }
        const baseInterval =
          typeof document !== "undefined" && document.visibilityState !== "visible"
            ? HIDDEN_INTERVAL_MS
            : ACTIVE_INTERVAL_MS;
        nextRunAtRef.current = Date.now() + baseInterval;
      } catch {
        nextRunAtRef.current = Date.now() + ERROR_RETRY_MS;
      } finally {
        inFlightRef.current = false;
      }
    },
    [status]
  );

  useEffect(() => {
    if (status !== "authenticated") {
      nextRunAtRef.current = 0;
      return;
    }

    void runHeartbeat(true);

    const pollTimer = window.setInterval(() => {
      void runHeartbeat(false);
    }, POLL_TICK_MS);

    const handleResume = () => {
      void runHeartbeat(true);
    };
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      void runHeartbeat(true);
    };

    window.addEventListener("focus", handleResume);
    window.addEventListener("pageshow", handleResume);
    window.addEventListener("online", handleResume);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.clearInterval(pollTimer);
      window.removeEventListener("focus", handleResume);
      window.removeEventListener("pageshow", handleResume);
      window.removeEventListener("online", handleResume);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [runHeartbeat, status]);

  return null;
}
