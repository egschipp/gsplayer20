"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import SpotifyPlayer, { type PlayerApi } from "../SpotifyPlayer";
import { QueueProvider } from "@/lib/queue/QueueProvider";
import { QueuePlaybackProvider } from "@/lib/playback/QueuePlaybackProvider";
import { useViewport } from "@/lib/responsive/useViewport";
import {
  DEFAULT_PLAYBACK_FOCUS,
  type PlaybackFocus,
} from "./playbackFocus";

type PlayerContextValue = {
  api: PlayerApi | null;
  currentTrackId: string | null;
  playbackFocus: PlaybackFocus;
};

const PlayerContext = createContext<PlayerContextValue>({
  api: null,
  currentTrackId: null,
  playbackFocus: DEFAULT_PLAYBACK_FOCUS,
});

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [api, setApi] = useState<PlayerApi | null>(null);
  const [playbackFocus, setPlaybackFocus] = useState<PlaybackFocus>(
    DEFAULT_PLAYBACK_FOCUS
  );
  const playerShellRef = useRef<HTMLDivElement | null>(null);
  const viewport = useViewport();
  const currentTrackId = playbackFocus.trackId;
  const value = useMemo(
    () => ({ api, currentTrackId, playbackFocus }),
    [api, currentTrackId, playbackFocus]
  );
  const pathname = usePathname();
  const path = pathname ?? "/";
  const showPlayer = path === "/" || path.startsWith("/gsplayer") || path.startsWith("/queue");
  const showLibraryDock = path === "/" || path.startsWith("/gsplayer");

  useEffect(() => {
    if (typeof window === "undefined") return;

    const root = document.documentElement;
    const headerEl = document.querySelector(".shell.header-shell");

    function applyContentHeight() {
      const viewportHeight = viewport.visualHeight || viewport.height || window.innerHeight;
      const headerBottom =
        headerEl instanceof HTMLElement
          ? Math.max(0, Math.round(headerEl.getBoundingClientRect().bottom))
          : 0;
      const playerBottom =
        showPlayer && playerShellRef.current
          ? Math.max(0, Math.round(playerShellRef.current.getBoundingClientRect().bottom))
          : 0;
      const reservedBottom = Math.max(headerBottom, playerBottom);
      const next = Math.max(220, Math.floor(viewportHeight - reservedBottom - 10));
      root.style.setProperty("--app-content-max-height", `${next}px`);
    }

    applyContentHeight();
    const rafId = window.requestAnimationFrame(applyContentHeight);
    window.addEventListener("resize", applyContentHeight, { passive: true });
    window.visualViewport?.addEventListener("resize", applyContentHeight, { passive: true });
    window.visualViewport?.addEventListener("scroll", applyContentHeight, { passive: true });

    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => applyContentHeight())
        : null;
    if (observer && headerEl instanceof HTMLElement) {
      observer.observe(headerEl);
    }
    if (observer && playerShellRef.current) {
      observer.observe(playerShellRef.current);
    }

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", applyContentHeight);
      window.visualViewport?.removeEventListener("resize", applyContentHeight);
      window.visualViewport?.removeEventListener("scroll", applyContentHeight);
      observer?.disconnect();
    };
  }, [showPlayer, viewport.height, viewport.visualHeight]);

  return (
    <PlayerContext.Provider value={value}>
      <QueueProvider>
        <QueuePlaybackProvider>
          <div
            ref={playerShellRef}
            className="shell player-shell-wrap"
            data-visible={showPlayer ? "true" : "false"}
            aria-hidden={!showPlayer}
          >
            <div className="library-sticky player-shell">
              <Image
                src="/georgies-spotify.png"
                alt="Georgies Spotify logo"
                width={240}
                height={80}
                className="library-logo"
                priority
              />
              <SpotifyPlayer onReady={setApi} onPlaybackFocusChange={setPlaybackFocus} />
              {showLibraryDock ? (
                <div
                  id="player-library-dock-slot"
                  className="player-library-dock-slot"
                  aria-label="MyMusic selectie"
                />
              ) : null}
            </div>
          </div>
          {children}
        </QueuePlaybackProvider>
      </QueueProvider>
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  return useContext(PlayerContext);
}
