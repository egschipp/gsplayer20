"use client";

import Image from "next/image";
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

  return (
    <PlayerContext.Provider value={value}>
      <div className="library-sticky">
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
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  return useContext(PlayerContext);
}
