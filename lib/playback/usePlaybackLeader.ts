"use client";

import { useEffect, useState } from "react";

const LEASE_KEY = "gsplayer:playback:leader:v1";
const LEASE_TTL_MS = 9_000;
const HEARTBEAT_MS = 3_000;

type LeaseRecord = {
  ownerId: string;
  expiresAt: number;
};

function createOwnerId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `playback-leader-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readLease(storage: Storage): LeaseRecord | null {
  const raw = storage.getItem(LEASE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LeaseRecord>;
    if (
      typeof parsed?.ownerId === "string" &&
      typeof parsed?.expiresAt === "number" &&
      Number.isFinite(parsed.expiresAt)
    ) {
      return {
        ownerId: parsed.ownerId,
        expiresAt: parsed.expiresAt,
      };
    }
  } catch {
    // ignore malformed lease records
  }
  return null;
}

function writeLease(storage: Storage, ownerId: string) {
  const next: LeaseRecord = {
    ownerId,
    expiresAt: Date.now() + LEASE_TTL_MS,
  };
  storage.setItem(LEASE_KEY, JSON.stringify(next));
  return next;
}

export function usePlaybackLeader(enabled = true) {
  const [ownerId] = useState(createOwnerId);
  const [isLeader, setIsLeader] = useState(false);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    const storage = window.localStorage;
    let active = true;

    const syncLease = () => {
      try {
        const current = readLease(storage);
        const now = Date.now();
        let ownsLease = false;
        if (!current || current.expiresAt <= now || current.ownerId === ownerId) {
          const written = writeLease(storage, ownerId);
          const confirmed = readLease(storage);
          ownsLease = Boolean(
            confirmed &&
              confirmed.ownerId === ownerId &&
              confirmed.expiresAt >= written.expiresAt - LEASE_TTL_MS
          );
        }
        if (active) {
          setIsLeader(ownsLease);
        }
      } catch {
        if (active) {
          setIsLeader(false);
        }
      }
    };

    const release = () => {
      try {
        const current = readLease(storage);
        if (current?.ownerId === ownerId) {
          storage.removeItem(LEASE_KEY);
        }
      } catch {
        // ignore storage failures
      }
    };

    syncLease();
    const interval = window.setInterval(() => {
      syncLease();
    }, HEARTBEAT_MS);

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== LEASE_KEY) return;
      syncLease();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        syncLease();
      }
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener("focus", syncLease);
    window.addEventListener("pageshow", syncLease);
    window.addEventListener("pagehide", release);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("focus", syncLease);
      window.removeEventListener("pageshow", syncLease);
      window.removeEventListener("pagehide", release);
      document.removeEventListener("visibilitychange", handleVisibility);
      release();
    };
  }, [enabled, ownerId]);

  return {
    isLeader: enabled ? isLeader : false,
    ownerId,
  };
}
