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
    positionMs: number;
    durationMs: number;
  } | null>(null);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [devices, setDevices] = useState<
    { id: string; name: string; isActive: boolean; type: string }[]
  >([]);
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
      const nextPosition = state.position ?? 0;
      const nextDuration = current?.duration_ms ?? 0;
      setPlayerState({
        name: current?.name ?? "Unknown track",
        artists: (current?.artists ?? []).map((a: any) => a.name).join(", "),
        album: current?.album?.name ?? "",
        coverUrl: current?.album?.images?.[0]?.url ?? null,
        paused: Boolean(state.paused),
        positionMs: nextPosition,
        durationMs: nextDuration,
      });
      setPositionMs(nextPosition);
      setDurationMs(nextDuration);
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

  useEffect(() => {
    if (!playerState || playerState.paused) return;
    let raf: number;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = now - last;
      last = now;
      setPositionMs((prev) => {
        const next = Math.min(prev + delta, durationMs || prev + delta);
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playerState?.paused, durationMs]);

  useEffect(() => {
    if (!accessToken) return;
    refreshDevices();
  }, [accessToken, deviceId]);

  async function refreshDevices() {
    const token = accessTokenRef.current;
    if (!token) return;
    const res = await fetch("https://api.spotify.com/v1/me/player/devices", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    const list = Array.isArray(data.devices) ? data.devices : [];
    setDevices(
      list.map((d: any) => ({
        id: d.id,
        name: d.name,
        isActive: Boolean(d.is_active),
        type: d.type,
      }))
    );
  }

  async function handleDeviceChange(targetId: string) {
    const token = accessTokenRef.current;
    if (!token || !targetId) return;
    await fetch("https://api.spotify.com/v1/me/player", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ device_ids: [targetId], play: false }),
    });
    setDeviceId(targetId);
    deviceIdRef.current = targetId;
    refreshDevices();
  }

  async function handleTogglePlay() {
    const token = accessTokenRef.current;
    const currentDevice = deviceIdRef.current;
    if (!token || !currentDevice) return;
    const endpoint = playerState?.paused ? "play" : "pause";
    await fetch(
      `https://api.spotify.com/v1/me/player/${endpoint}?device_id=${currentDevice}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  }

  async function handleNext() {
    const token = accessTokenRef.current;
    const currentDevice = deviceIdRef.current;
    if (!token || !currentDevice) return;
    await fetch(
      `https://api.spotify.com/v1/me/player/next?device_id=${currentDevice}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  }

  async function handlePrevious() {
    const token = accessTokenRef.current;
    const currentDevice = deviceIdRef.current;
    if (!token || !currentDevice) return;
    await fetch(
      `https://api.spotify.com/v1/me/player/previous?device_id=${currentDevice}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  }

  function formatTime(ms?: number) {
    if (!ms || ms < 0) return "0:00";
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, "0")}`;
  }

  async function handleSeek(nextMs: number) {
    const token = accessTokenRef.current;
    const currentDevice = deviceIdRef.current;
    if (!token || !currentDevice) return;
    await fetch(
      `https://api.spotify.com/v1/me/player/seek?device_id=${currentDevice}&position_ms=${Math.floor(
        nextMs
      )}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    setPositionMs(nextMs);
  }

  async function handleVolume(nextVolume: number) {
    const clamped = Math.max(0, Math.min(1, nextVolume));
    setVolume(clamped);
    await playerRef.current?.setVolume?.(clamped);
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
        <div className="player-progress">
          <span className="text-subtle">{formatTime(positionMs)}</span>
          <input
            type="range"
            min={0}
            max={durationMs || 1}
            value={Math.min(positionMs, durationMs || 1)}
            onChange={(event) => setPositionMs(Number(event.target.value))}
            onMouseUp={() => handleSeek(positionMs)}
            onTouchEnd={() => handleSeek(positionMs)}
            className="player-slider"
            aria-label="Seek"
          />
          <span className="text-subtle">{formatTime(durationMs)}</span>
        </div>
      </div>
      <div className="player-controls">
        <button
          type="button"
          className="detail-btn"
          aria-label="Previous"
          title="Previous"
          onClick={handlePrevious}
        >
          ⏮
        </button>
        <button
          type="button"
          className="player-play"
          aria-label={playerState?.paused ? "Play" : "Pause"}
          title={playerState?.paused ? "Play" : "Pause"}
          onClick={handleTogglePlay}
        >
          {playerState?.paused ? "▶" : "⏸"}
        </button>
        <button
          type="button"
          className="detail-btn"
          aria-label="Next"
          title="Next"
          onClick={handleNext}
        >
          ⏭
        </button>
      </div>
      <div className="player-badge">
        <div className="player-device-row">
          <span>{deviceId ? "Spotify Connect" : "Connecting..."}</span>
          <button
            type="button"
            className="detail-btn"
            aria-label="Refresh devices"
            title="Refresh devices"
            onClick={refreshDevices}
          >
            ↻
          </button>
        </div>
        <select
          className="player-device-select"
          value={devices.find((d) => d.isActive)?.id || deviceId || ""}
          onChange={(event) => handleDeviceChange(event.target.value)}
        >
          <option value="" disabled>
            Select device
          </option>
          {devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.name} ({device.type})
            </option>
          ))}
        </select>
        <div className="player-volume">
          <span className="text-subtle">Volume</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(event) => handleVolume(Number(event.target.value))}
            className="player-slider"
            aria-label="Volume"
          />
        </div>
      </div>
    </div>
  );
}
