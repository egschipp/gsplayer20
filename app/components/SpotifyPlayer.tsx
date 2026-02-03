"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";

declare global {
  interface Window {
    Spotify: any;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

export type PlayerApi = {
  playQueue: (uris: string[], offsetUri?: string) => Promise<void>;
  togglePlay: () => Promise<void>;
  next: () => Promise<void>;
  previous: () => Promise<void>;
};

type PlayerProps = {
  onReady: (api: PlayerApi | null) => void;
  onTrackChange?: (trackId: string | null) => void;
};

export default function SpotifyPlayer({ onReady, onTrackChange }: PlayerProps) {
  const { data: session } = useSession();
  const accessToken = session?.accessToken as string | undefined;
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [playerState, setPlayerState] = useState<{
    name: string;
    artists: string;
    album: string;
    coverUrl: string | null;
    paused: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const playerRef = useRef<any>(null);
  const deviceIdRef = useRef<string | null>(null);
  const accessTokenRef = useRef<string | undefined>(accessToken);
  const readyRef = useRef(false);

  const canUseSdk = useMemo(() => Boolean(accessToken), [accessToken]);

  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    if (!canUseSdk) {
      onReady(null);
      return;
    }

    if (window.Spotify) {
      initializePlayer();
      return;
    }

    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    document.body.appendChild(script);
    window.onSpotifyWebPlaybackSDKReady = () => {
      initializePlayer();
    };

    return () => {
      if (script.parentNode) script.parentNode.removeChild(script);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseSdk, accessToken]);

  function initializePlayer() {
    if (!accessToken || readyRef.current) return;
    readyRef.current = true;

    const player = new window.Spotify.Player({
      name: "GSPlayer20 Web",
      getOAuthToken: (cb: (token: string) => void) => cb(accessToken),
      volume: 0.8,
    });

    player.addListener("ready", ({ device_id }: { device_id: string }) => {
      setDeviceId(device_id);
      deviceIdRef.current = device_id;
      transferPlayback(device_id).catch(() => {});
    });

    player.addListener("not_ready", () => {
      setDeviceId(null);
    });

    player.addListener("player_state_changed", (state: any) => {
      if (!state) return;
      const current = state.track_window?.current_track;
      const trackId = current?.id ?? null;
      setPlayerState({
        name: current?.name ?? "Unknown track",
        artists: (current?.artists ?? []).map((a: any) => a.name).join(", "),
        album: current?.album?.name ?? "",
        coverUrl: current?.album?.images?.[0]?.url ?? null,
        paused: Boolean(state.paused),
      });
      if (onTrackChange) onTrackChange(trackId);
    });

    player.addListener("initialization_error", ({ message }: { message: string }) => {
      setError(message);
    });
    player.addListener("authentication_error", ({ message }: { message: string }) => {
      setError(message);
    });
    player.addListener("account_error", ({ message }: { message: string }) => {
      setError(message);
    });

    player.connect();
    playerRef.current = player;

    const api: PlayerApi = {
      playQueue: async (uris, offsetUri) => {
        const currentDevice = deviceIdRef.current;
        const token = accessTokenRef.current;
        if (!currentDevice || !token) return;
        await fetch(
          `https://api.spotify.com/v1/me/player/play?device_id=${currentDevice}`,
          {
            method: "PUT",
            headers: { Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              uris,
              offset: offsetUri ? { uri: offsetUri } : undefined,
            }),
          }
        );
      },
      togglePlay: async () => {
        if (!playerRef.current) return;
        await playerRef.current.togglePlay();
      },
      next: async () => {
        const currentDevice = deviceIdRef.current;
        const token = accessTokenRef.current;
        if (!currentDevice || !token) return;
        await fetch(
          `https://api.spotify.com/v1/me/player/next?device_id=${currentDevice}`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          }
        );
      },
      previous: async () => {
        const currentDevice = deviceIdRef.current;
        const token = accessTokenRef.current;
        if (!currentDevice || !token) return;
        await fetch(
          `https://api.spotify.com/v1/me/player/previous?device_id=${currentDevice}`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          }
        );
      },
    };

    onReady(api);
  }

  async function transferPlayback(id: string) {
    if (!accessToken) return;
    await fetch("https://api.spotify.com/v1/me/player", {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ device_ids: [id], play: false }),
    });
  }

  if (!canUseSdk) {
    return (
      <div className="player-card">
        <div className="player-meta">
          <div className="player-title">Spotify Player</div>
          <div className="text-body">
            Connect Spotify to enable playback in the browser.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="player-card">
      <div className="player-cover">
        {playerState?.coverUrl ? (
          <img src={playerState.coverUrl} alt={playerState.album || "Album"} />
        ) : (
          <div className="player-cover placeholder" />
        )}
      </div>
      <div className="player-meta">
        <div className="player-title">{playerState?.name || "Ready to play"}</div>
        <div className="text-body">
          {playerState?.artists || "Select a track to start playback"}
        </div>
        {playerState?.album ? (
          <div className="text-subtle">{playerState.album}</div>
        ) : null}
        {error ? <div className="text-subtle">Player error: {error}</div> : null}
      </div>
      <div className="player-controls">
        <button
          type="button"
          className="detail-btn"
          aria-label="Previous"
          title="Previous"
          onClick={() => playerRef.current?.previousTrack?.() || undefined}
        >
          ⏮
        </button>
        <button
          type="button"
          className="player-play"
          aria-label={playerState?.paused ? "Play" : "Pause"}
          title={playerState?.paused ? "Play" : "Pause"}
          onClick={() => playerRef.current?.togglePlay?.() || undefined}
        >
          {playerState?.paused ? "▶" : "⏸"}
        </button>
        <button
          type="button"
          className="detail-btn"
          aria-label="Next"
          title="Next"
          onClick={() => playerRef.current?.nextTrack?.() || undefined}
        >
          ⏭
        </button>
      </div>
      <div className="player-badge">
        {deviceId ? "Spotify Connect ready" : "Connecting..."}
      </div>
    </div>
  );
}
