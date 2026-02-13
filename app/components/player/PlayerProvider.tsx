"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import SpotifyPlayer, { type PlayerApi } from "../SpotifyPlayer";

type PlayerContextValue = {
  api: PlayerApi | null;
  currentTrackId: string | null;
};

const PlayerContext = createContext<PlayerContextValue>({
  api: null,
  currentTrackId: null,
});

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [api, setApi] = useState<PlayerApi | null>(null);
  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const value = useMemo(() => ({ api, currentTrackId }), [api, currentTrackId]);
  const pathname = usePathname();
  const path = pathname ?? "/";
  const showPlayer = path === "/" || path.startsWith("/gsplayer");

  return (
    <PlayerContext.Provider value={value}>
      <div
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
          <SpotifyPlayer onReady={setApi} onTrackChange={setCurrentTrackId} />
        </div>
      </div>
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  return useContext(PlayerContext);
}
