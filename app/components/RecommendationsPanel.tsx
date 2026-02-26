"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDuration } from "@/app/components/playlist/utils";
import type {
  RecommendationItem,
  RecommendationsErrorResponse,
  RecommendationsSuccessResponse,
} from "@/lib/recommendations/types";

type PanelStatus =
  | "idle"
  | "loading"
  | "success"
  | "empty"
  | "rate_limited"
  | "auth_required"
  | "error";

type RecommendationsPanelProps = {
  enabled: boolean;
  selectedTrackIds: string[];
  seedLabelByTrackId: Record<string, string>;
  onPlayTrack: (item: RecommendationItem) => void;
  onQueueTrack: (item: RecommendationItem) => void;
};

function createSeedLabel(seedId: string, labels: Record<string, string>) {
  const known = labels[seedId];
  if (known) return known;
  return `${seedId.slice(0, 6)}…${seedId.slice(-4)}`;
}

export default function RecommendationsPanel({
  enabled,
  selectedTrackIds,
  seedLabelByTrackId,
  onPlayTrack,
  onQueueTrack,
}: RecommendationsPanelProps) {
  const [status, setStatus] = useState<PanelStatus>("idle");
  const [items, setItems] = useState<RecommendationItem[]>([]);
  const [seedTrackIds, setSeedTrackIds] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lockSeed, setLockSeed] = useState(false);
  const [lockedSelectionSignature, setLockedSelectionSignature] = useState<string | null>(
    null
  );
  const [seedNonce, setSeedNonce] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [retryUntilMs, setRetryUntilMs] = useState<number | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(() => Date.now());

  const requestSeqRef = useRef(0);

  const selectedSignature = useMemo(
    () => [...selectedTrackIds].sort().join(","),
    [selectedTrackIds]
  );
  const hasSelection = selectedTrackIds.length > 0;
  const lockSeedActive =
    lockSeed && lockedSelectionSignature != null && lockedSelectionSignature === selectedSignature;

  const retryAfterMs = useMemo(() => {
    if (!retryUntilMs) return 0;
    return Math.max(0, retryUntilMs - currentTimeMs);
  }, [currentTimeMs, retryUntilMs]);

  const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);

  useEffect(() => {
    if (retryUntilMs == null || retryUntilMs <= currentTimeMs) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setCurrentTimeMs(now);
    }, 250);
    return () => window.clearInterval(timer);
  }, [currentTimeMs, retryUntilMs]);

  useEffect(() => {
    if (!enabled || !hasSelection) return;

    const requestId = ++requestSeqRef.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      if (retryAfterMs > 0) {
        setStatus("rate_limited");
        return;
      }

      setStatus("loading");
      setErrorMessage(null);

      let nextSeedNonce = seedNonce;
      if (lockSeedActive && !nextSeedNonce) {
        nextSeedNonce = crypto.randomUUID();
        setSeedNonce(nextSeedNonce);
      }

      try {
        const res = await fetch("/api/spotify/recommendations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            selectedTrackIds,
            seedCountMax: 5,
            limit: 25,
            market: "from_token",
            ...(lockSeedActive && nextSeedNonce ? { seedNonce: nextSeedNonce } : {}),
          }),
          cache: "no-store",
          signal: controller.signal,
        });

        const payload = (await res
          .json()
          .catch(() => null)) as
          | RecommendationsSuccessResponse
          | RecommendationsErrorResponse
          | null;

        if (requestSeqRef.current !== requestId) return;

        if (res.ok) {
          const success = payload as RecommendationsSuccessResponse | null;
          const nextItems = Array.isArray(success?.items) ? success.items : [];
          setItems(nextItems);
          setSeedTrackIds(Array.isArray(success?.seedTrackIds) ? success.seedTrackIds : []);
          setStatus(nextItems.length ? "success" : "empty");
          return;
        }

        const error = payload as RecommendationsErrorResponse | null;
        const code = String(error?.error?.code ?? "");
        const message =
          String(error?.error?.message ?? "").trim() ||
          "Recommendations laden is nu niet gelukt.";
        const retryAfter = Number(error?.error?.retryAfterMs ?? 0);

        if (res.status === 401 || code === "AUTH_REQUIRED") {
          setStatus("auth_required");
          setErrorMessage(message);
          return;
        }

        if (res.status === 429 || code === "RATE_LIMITED") {
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2000;
          setCurrentTimeMs(Date.now());
          setRetryUntilMs(Date.now() + waitMs);
          setStatus("rate_limited");
          setErrorMessage(message);
          return;
        }

        setStatus("error");
        setErrorMessage(message);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (requestSeqRef.current !== requestId) return;
        setStatus("error");
        setErrorMessage(String(error || "Recommendations laden is nu niet gelukt."));
      }
    }, 350);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    enabled,
    hasSelection,
    lockSeedActive,
    refreshTick,
    retryAfterMs,
    seedNonce,
    selectedTrackIds,
    selectedSignature,
  ]);

  const activeStatus: PanelStatus = enabled && hasSelection ? status : "idle";
  const activeItems = enabled && hasSelection ? items : [];
  const activeSeedTrackIds = enabled && hasSelection ? seedTrackIds : [];

  const reseedDisabled = !hasSelection || status === "loading" || retryAfterMs > 0;

  return (
    <section className="recommendations-panel-shell">
      <div className="recommendations-panel-header">
        <div className="recommendations-title-wrap">
          <h3 className="recommendations-title">Recommendations</h3>
          <span className="text-subtle recommendations-count">{activeItems.length} tracks</span>
        </div>
        <div className="recommendations-controls">
          <button
            type="button"
            className="recommendations-secondary-btn"
            disabled={reseedDisabled}
            onClick={() => {
              if (lockSeedActive) {
                setSeedNonce(crypto.randomUUID());
              }
              setRefreshTick((prev) => prev + 1);
            }}
          >
            Refresh seeds
          </button>
          <button
            type="button"
            className={`recommendations-secondary-btn${lockSeedActive ? " active" : ""}`}
            aria-pressed={lockSeedActive}
            onClick={() => {
              if (lockSeedActive) {
                setLockSeed(false);
                setLockedSelectionSignature(null);
                setSeedNonce(null);
                return;
              }
              setLockSeed(true);
              setLockedSelectionSignature(selectedSignature);
              setSeedNonce(crypto.randomUUID());
            }}
          >
            {lockSeedActive ? "Seed lock aan" : "Seed lock uit"}
          </button>
        </div>
      </div>

      <div className="recommendations-subhead text-subtle">
        Gebaseerd op maximaal 5 willekeurige nummers uit de selectie.
      </div>

      {activeSeedTrackIds.length ? (
        <div className="recommendations-seed-chips" aria-label="Actieve seed tracks">
          {activeSeedTrackIds.map((seedId) => (
            <span key={seedId} className="recommendations-seed-chip">
              {createSeedLabel(seedId, seedLabelByTrackId)}
            </span>
          ))}
        </div>
      ) : null}

      <div className="recommendations-panel-body">
        {activeStatus === "idle" ? (
          <div className="empty-state">
            <div style={{ fontWeight: 600 }}>Selecteer tracks voor recommendations</div>
            <div className="text-body">
              De aanbevelingen worden opgebouwd uit je huidige selectie.
            </div>
          </div>
        ) : null}

        {activeStatus === "loading" ? (
          <div className="recommendations-loading">
            <span className="text-body">Recommendations laden...</span>
          </div>
        ) : null}

        {activeStatus === "auth_required" ? (
          <div className="empty-state">
            <div style={{ fontWeight: 600 }}>Spotify login vereist</div>
            <div className="text-body">
              {errorMessage || "Log opnieuw in om recommendations te laden."}
            </div>
          </div>
        ) : null}

        {activeStatus === "rate_limited" ? (
          <div className="empty-state">
            <div style={{ fontWeight: 600 }}>Rate limit actief</div>
            <div className="text-body">
              {errorMessage || "Te veel verzoeken naar Spotify."}
              {retryAfterSeconds > 0 ? ` Probeer opnieuw over ${retryAfterSeconds}s.` : ""}
            </div>
          </div>
        ) : null}

        {activeStatus === "error" ? (
          <div className="empty-state">
            <div style={{ fontWeight: 600 }}>Spotify is tijdelijk niet bereikbaar</div>
            <div className="text-body">
              {errorMessage || "Recommendations laden is nu niet gelukt."}
            </div>
          </div>
        ) : null}

        {activeStatus === "empty" ? (
          <div className="empty-state">
            <div style={{ fontWeight: 600 }}>Nog geen recommendations</div>
            <div className="text-body">
              Spotify kon voor deze selectie nu geen recommendations tonen.
            </div>
          </div>
        ) : null}

        {activeStatus === "success" && activeItems.length ? (
          <ul className="recommendations-track-list" aria-label="Recommendations">
            {activeItems.map((item) => {
              const image = item.album.images[0]?.url ?? null;
              const artistLine = item.artists.map((artist) => artist.name).join(", ");
              return (
                <li key={item.id} className="recommendations-track-item">
                  <div className="recommendations-track-main">
                    <button
                      type="button"
                      className="play-btn"
                      onClick={() => onPlayTrack(item)}
                      aria-label={`Speel ${item.name}`}
                    >
                      ▶
                    </button>
                    {image ? (
                      <Image
                        src={image}
                        alt=""
                        width={48}
                        height={48}
                        className="track-cover-image"
                        unoptimized
                      />
                    ) : (
                      <span className="track-cover-placeholder" />
                    )}
                    <div className="recommendations-track-text">
                      <div className="track-title-line">
                        <span className="track-title-text" title={item.name}>
                          {item.name}
                        </span>
                      </div>
                      <div className="track-artist-line text-body" title={artistLine}>
                        {artistLine || "Onbekende artiest"}
                      </div>
                      {item.album.name ? (
                        <div className="track-album-line text-subtle" title={item.album.name}>
                          {item.album.name}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <div className="recommendations-track-actions">
                    <span className="text-subtle recommendations-duration">
                      {formatDuration(item.durationMs)}
                    </span>
                    <button
                      type="button"
                      className="queue-row-btn"
                      onClick={() => onQueueTrack(item)}
                      aria-label={`Zet ${item.name} in de queue`}
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        width="15"
                        height="15"
                        fill="none"
                      >
                        <path
                          d="M4 7h10M4 12h10M4 17h6M18 11v6M15 14h6"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    <a
                      href={`https://open.spotify.com/track/${item.id}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${item.name} in Spotify`}
                      className="track-action-link"
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        width="20"
                        height="20"
                        fill="currentColor"
                      >
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm4.6 14.52c-.18.3-.57.4-.87.22-2.4-1.46-5.42-1.8-8.97-1.02-.34.08-.68-.13-.76-.47-.08-.34.13-.68.47-.76 3.86-.86 7.2-.47 9.9 1.18.3.18.4.57.22.87Zm1.24-2.76c-.22.36-.7.48-1.06.26-2.74-1.68-6.92-2.17-10.17-1.18-.41.12-.85-.11-.97-.52-.12-.41.11-.85.52-.97 3.71-1.12 8.33-.57 11.47 1.36.36.22.48.7.26 1.05Zm.11-2.87c-3.28-1.95-8.69-2.13-11.82-1.18-.49.15-1.02-.13-1.17-.62-.15-.49.13-1.02.62-1.17 3.59-1.09 9.56-.88 13.33 1.36.44.26.58.83.32 1.27-.26.44-.83.58-1.27.32Z" />
                      </svg>
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
