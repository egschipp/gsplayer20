"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const { data: session, status: sessionStatus } = useSession();
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
    {
      id: string;
      name: string;
      isActive: boolean;
      type: string;
      isRestricted?: boolean;
      supportsVolume?: boolean;
    }[]
  >([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [activeDeviceName, setActiveDeviceName] = useState<string | null>(null);
  const [activeDeviceRestricted, setActiveDeviceRestricted] = useState(false);
  const [activeDeviceSupportsVolume, setActiveDeviceSupportsVolume] = useState(true);
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const deviceCloseRef = useRef(false);
  const lastDeviceSelectRef = useRef(0);
  const pendingDeviceIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const playerRef = useRef<any>(null);
  const deviceIdRef = useRef<string | null>(null);
  const accessTokenRef = useRef<string | undefined>(accessToken);
  const sdkDeviceIdRef = useRef<string | null>(null);
  const activeDeviceIdRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  const rateLimitRef = useRef({ until: 0, backoffMs: 5000 });
  const lastRequestAtRef = useRef(0);
  const lastDevicesRefreshRef = useRef(0);
  const lastTrackIdRef = useRef<string | null>(null);
  const pendingTrackIdRef = useRef<string | null>(null);
  const trackChangeLockUntilRef = useRef(0);

  const canUseSdk = useMemo(() => Boolean(accessToken), [accessToken]);

  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);

  const setActiveDevice = useCallback((id: string | null, name?: string | null) => {
    setActiveDeviceId(id);
    activeDeviceIdRef.current = id;
    if (name !== undefined) {
      setActiveDeviceName(name);
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    const token = accessTokenRef.current;
    if (!token) return;
    const now = Date.now();
    if (now - lastDevicesRefreshRef.current < 5000) return;
    lastDevicesRefreshRef.current = now;
    if (now < rateLimitRef.current.until) return;
    const res = await fetch("https://api.spotify.com/v1/me/player/devices", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 429) {
      const retry = res.headers.get("Retry-After");
      const retryMs = retry ? Number(retry) * 1000 : rateLimitRef.current.backoffMs;
      rateLimitRef.current.until = Date.now() + retryMs;
      rateLimitRef.current.backoffMs = Math.min(
        rateLimitRef.current.backoffMs * 2,
        60000
      );
      setError(`Spotify is even druk. Opnieuw in ${Math.ceil(retryMs / 1000)}s`);
      return;
    }
    if (!res.ok) return;
    rateLimitRef.current.backoffMs = 5000;
    const data = await res.json();
    const list = Array.isArray(data.devices) ? data.devices : [];
    setDevices(
      list.map((d: any) => ({
        id: d.id,
        name: d.name,
        isActive: Boolean(d.is_active),
        type: d.type,
        isRestricted: Boolean(d.is_restricted),
        supportsVolume: d.supports_volume !== false,
      }))
    );
    const active = list.find((d: any) => d.is_active);
    if (active?.id) {
      setActiveDevice(active.id, active.name ?? null);
      setActiveDeviceRestricted(Boolean(active.is_restricted));
      setActiveDeviceSupportsVolume(active.supports_volume !== false);
    }
  }, [setActiveDevice]);

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

  async function initializePlayer() {
    if (!accessToken || readyRef.current) return;
    readyRef.current = true;

    const player = new window.Spotify.Player({
      name: "GSPlayer20 Web",
      getOAuthToken: (cb: (token: string) => void) => cb(accessToken),
      volume: 0.8,
    });

    player.addListener("ready", async ({ device_id }: { device_id: string }) => {
      setDeviceId(device_id);
      deviceIdRef.current = device_id;
      sdkDeviceIdRef.current = device_id;
      const token = accessTokenRef.current;
      if (token) {
        try {
          const res = await fetch("https://api.spotify.com/v1/me/player", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.ok) {
            const data = await res.json();
            const device = data?.device;
            if (device?.id) {
              setActiveDevice(device.id, device.name ?? null);
              setActiveDeviceRestricted(Boolean(device.is_restricted));
              setActiveDeviceSupportsVolume(device.supports_volume !== false);
            }
            const item = data?.item;
            if (item) {
              setPlayerState({
                name: item.name ?? "Unknown track",
                artists: (item.artists ?? []).map((a: any) => a.name).join(", "),
                album: item.album?.name ?? "",
                coverUrl: item.album?.images?.[0]?.url ?? null,
                paused: Boolean(!data.is_playing),
                positionMs: data.progress_ms ?? 0,
                durationMs: item.duration_ms ?? 0,
              });
              setPositionMs(data.progress_ms ?? 0);
              setDurationMs(item.duration_ms ?? 0);
              if (onTrackChange) onTrackChange(item.id ?? null);
            }
          }
        } catch {
          // ignore
        }
      }
    });

    player.addListener("not_ready", () => {
      setDeviceId(null);
      sdkDeviceIdRef.current = null;
    });

    player.addListener("player_state_changed", (state: any) => {
      if (!state) return;
      if (
        activeDeviceIdRef.current &&
        activeDeviceIdRef.current !== sdkDeviceIdRef.current
      ) {
        return;
      }
      const current = state.track_window?.current_track;
      const trackId = current?.id ?? null;
      const nextPosition = state.position ?? 0;
      const nextDuration = current?.duration_ms ?? 0;
      const isNewTrack = trackId && trackId !== lastTrackIdRef.current;
      if (isNewTrack) {
        lastTrackIdRef.current = trackId;
        if (pendingTrackIdRef.current === trackId) {
          pendingTrackIdRef.current = null;
        }
        trackChangeLockUntilRef.current = Date.now() + 1200;
      }
      setPlayerState((prev) => ({
        name: current?.name ?? prev?.name ?? "Unknown track",
        artists: (current?.artists ?? [])
          .map((a: any) => a.name)
          .join(", "),
        album: current?.album?.name ?? prev?.album ?? "",
        coverUrl: current?.album?.images?.[0]?.url ?? prev?.coverUrl ?? null,
        paused: Boolean(state.paused),
        positionMs: isNewTrack ? 0 : nextPosition,
        durationMs: nextDuration,
      }));
      const allowProgressUpdate = Date.now() >= trackChangeLockUntilRef.current;
      setPositionMs(isNewTrack || !allowProgressUpdate ? 0 : nextPosition);
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
    player.addListener("autoplay_failed", () => {
      setError("Autoplay is geblokkeerd door de browser. Klik op Play.");
    });

    player.connect();
    playerRef.current = player;

    const api: PlayerApi = {
      playQueue: async (uris, offsetUri) => {
        const token = accessTokenRef.current;
        const currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
        if (!currentDevice || !token) return;
        if (offsetUri) {
          const id = offsetUri.split(":").pop() || null;
          pendingTrackIdRef.current = id;
          trackChangeLockUntilRef.current = Date.now() + 2000;
          setPositionMs(0);
        }
        if (currentDevice === sdkDeviceIdRef.current) {
          await playerRef.current?.activateElement?.();
        }
        await transferPlayback(currentDevice, false);
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
  }, [playerState, durationMs]);

  useEffect(() => {
    if (!accessToken) return;
    refreshDevices();
  }, [accessToken, deviceId, refreshDevices]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function spotifyRequest(url: string, options?: RequestInit) {
      const token = accessTokenRef.current;
      if (!token) return null;
      const now = Date.now();
      if (now - lastRequestAtRef.current < 1200) return null;
      if (now < rateLimitRef.current.until) return null;
      lastRequestAtRef.current = now;
      const res = await fetch(url, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, ...options?.headers },
      });
      if (res.status === 429) {
        const retry = res.headers.get("Retry-After");
        const retryMs = retry ? Number(retry) * 1000 : rateLimitRef.current.backoffMs;
        rateLimitRef.current.until = Date.now() + retryMs;
        rateLimitRef.current.backoffMs = Math.min(
          rateLimitRef.current.backoffMs * 2,
          60000
        );
        setError(`Spotify is even druk. Opnieuw in ${Math.ceil(retryMs / 1000)}s`);
        return null;
      }
      if (!res.ok) return null;
      rateLimitRef.current.backoffMs = 5000;
      return res;
    }

    async function poll() {
      const token = accessTokenRef.current;
      if (!token || cancelled) return;
      const res = await spotifyRequest("https://api.spotify.com/v1/me/player");
      if (!res) {
        scheduleNext();
        return;
      }
      const data = await res.json();
      if (!data || cancelled) return;
      const device = data.device;
      const recentlySelected = Date.now() - lastDeviceSelectRef.current < 3000;
      if (device?.id && (!recentlySelected || device.id === pendingDeviceIdRef.current)) {
        setActiveDevice(device.id, device.name ?? null);
        setActiveDeviceRestricted(Boolean(device.is_restricted));
        setActiveDeviceSupportsVolume(device.supports_volume !== false);
        if (device.id === pendingDeviceIdRef.current) {
          pendingDeviceIdRef.current = null;
        }
      }
      const item = data.item;
      if (item) {
        const trackId = item.id ?? null;
        const isNewTrack = trackId && trackId !== lastTrackIdRef.current;
        if (isNewTrack) {
          lastTrackIdRef.current = trackId;
          if (pendingTrackIdRef.current === trackId) {
            pendingTrackIdRef.current = null;
          }
          trackChangeLockUntilRef.current = Date.now() + 1200;
        }
        setPlayerState((prev) => ({
          name: item.name ?? prev?.name ?? "Unknown track",
          artists: (item.artists ?? []).map((a: any) => a.name).join(", "),
          album: item.album?.name ?? prev?.album ?? "",
          coverUrl: item.album?.images?.[0]?.url ?? prev?.coverUrl ?? null,
          paused: Boolean(!data.is_playing),
          positionMs: isNewTrack ? 0 : data.progress_ms ?? 0,
          durationMs: item.duration_ms ?? 0,
        }));
        const allowProgressUpdate = Date.now() >= trackChangeLockUntilRef.current;
        setPositionMs(isNewTrack || !allowProgressUpdate ? 0 : data.progress_ms ?? 0);
        setDurationMs(item.duration_ms ?? 0);
        if (onTrackChange) onTrackChange(item.id ?? null);
      }
      if (typeof device?.volume_percent === "number") {
        setVolume(device.volume_percent / 100);
      }
      setError(null);
      scheduleNext(data?.is_playing);
    }

    function scheduleNext(isPlaying?: boolean) {
      if (cancelled) return;
      const baseDelay = isPlaying ? 5000 : 10000;
      const waitExtra = Math.max(rateLimitRef.current.until - Date.now(), 0);
      const delay = Math.min(baseDelay + waitExtra, 20000);
      if (timer) clearTimeout(timer);
      timer = setTimeout(poll, delay);
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [accessToken, onTrackChange, setActiveDevice]);

  async function handleDeviceChange(targetId: string) {
    const token = accessTokenRef.current;
    if (!token || !targetId) return;
    if (Date.now() < rateLimitRef.current.until) return;
    setActiveDevice(targetId);
    pendingDeviceIdRef.current = targetId;
    lastDeviceSelectRef.current = Date.now();
    const res = await fetch("https://api.spotify.com/v1/me/player", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ device_ids: [targetId], play: false }),
    });
    if (res.status === 429) {
      const retry = res.headers.get("Retry-After");
      const retryMs = retry ? Number(retry) * 1000 : rateLimitRef.current.backoffMs;
      rateLimitRef.current.until = Date.now() + retryMs;
      rateLimitRef.current.backoffMs = Math.min(
        rateLimitRef.current.backoffMs * 2,
        60000
      );
      setError(`Spotify is even druk. Opnieuw in ${Math.ceil(retryMs / 1000)}s`);
      return;
    }
    rateLimitRef.current.backoffMs = 5000;
    setDeviceId(targetId);
    deviceIdRef.current = targetId;
    refreshDevices();
    setTimeout(refreshDevices, 800);
  }

  async function handleTogglePlay() {
    const token = accessTokenRef.current;
    const currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
    if (!token || !currentDevice) {
      await playerRef.current?.togglePlay?.();
      return;
    }
    if (Date.now() < rateLimitRef.current.until) return;
    if (currentDevice === sdkDeviceIdRef.current) {
      await playerRef.current?.activateElement?.();
      await playerRef.current?.togglePlay?.();
      return;
    }
    const endpoint = playerState?.paused ? "play" : "pause";
    const res = await fetch(
      `https://api.spotify.com/v1/me/player/${endpoint}?device_id=${currentDevice}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (res.status === 429) {
      const retry = res.headers.get("Retry-After");
      const retryMs = retry ? Number(retry) * 1000 : rateLimitRef.current.backoffMs;
      rateLimitRef.current.until = Date.now() + retryMs;
      rateLimitRef.current.backoffMs = Math.min(
        rateLimitRef.current.backoffMs * 2,
        60000
      );
      setError(`Spotify is even druk. Opnieuw in ${Math.ceil(retryMs / 1000)}s`);
      return;
    }
    rateLimitRef.current.backoffMs = 5000;
  }

  async function handleNext() {
    const token = accessTokenRef.current;
    const currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
    if (!token || !currentDevice) return;
    if (Date.now() < rateLimitRef.current.until) return;
    if (currentDevice === sdkDeviceIdRef.current) {
      await playerRef.current?.nextTrack?.();
      return;
    }
    const res = await fetch(
      `https://api.spotify.com/v1/me/player/next?device_id=${currentDevice}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (res.status === 429) {
      const retry = res.headers.get("Retry-After");
      const retryMs = retry ? Number(retry) * 1000 : rateLimitRef.current.backoffMs;
      rateLimitRef.current.until = Date.now() + retryMs;
      rateLimitRef.current.backoffMs = Math.min(
        rateLimitRef.current.backoffMs * 2,
        60000
      );
      setError(`Spotify is even druk. Opnieuw in ${Math.ceil(retryMs / 1000)}s`);
      return;
    }
    rateLimitRef.current.backoffMs = 5000;
  }

  async function handlePrevious() {
    const token = accessTokenRef.current;
    const currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
    if (!token || !currentDevice) return;
    if (Date.now() < rateLimitRef.current.until) return;
    if (currentDevice === sdkDeviceIdRef.current) {
      await playerRef.current?.previousTrack?.();
      return;
    }
    const res = await fetch(
      `https://api.spotify.com/v1/me/player/previous?device_id=${currentDevice}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (res.status === 429) {
      const retry = res.headers.get("Retry-After");
      const retryMs = retry ? Number(retry) * 1000 : rateLimitRef.current.backoffMs;
      rateLimitRef.current.until = Date.now() + retryMs;
      rateLimitRef.current.backoffMs = Math.min(
        rateLimitRef.current.backoffMs * 2,
        60000
      );
      setError(`Spotify is even druk. Opnieuw in ${Math.ceil(retryMs / 1000)}s`);
      return;
    }
    rateLimitRef.current.backoffMs = 5000;
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
    const currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
    if (!token || !currentDevice) return;
    if (Date.now() < rateLimitRef.current.until) return;
    if (currentDevice === sdkDeviceIdRef.current) {
      await playerRef.current?.seek?.(Math.floor(nextMs));
      setPositionMs(nextMs);
      return;
    }
    const res = await fetch(
      `https://api.spotify.com/v1/me/player/seek?device_id=${currentDevice}&position_ms=${Math.floor(
        nextMs
      )}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (res.status === 429) {
      const retry = res.headers.get("Retry-After");
      const retryMs = retry ? Number(retry) * 1000 : rateLimitRef.current.backoffMs;
      rateLimitRef.current.until = Date.now() + retryMs;
      rateLimitRef.current.backoffMs = Math.min(
        rateLimitRef.current.backoffMs * 2,
        60000
      );
      setError(`Spotify is even druk. Opnieuw in ${Math.ceil(retryMs / 1000)}s`);
      return;
    }
    rateLimitRef.current.backoffMs = 5000;
    setPositionMs(nextMs);
  }

  async function handleVolume(nextVolume: number) {
    const clamped = Math.max(0, Math.min(1, nextVolume));
    setVolume(clamped);
    if (
      activeDeviceIdRef.current &&
      activeDeviceIdRef.current !== sdkDeviceIdRef.current
    ) {
      const token = accessTokenRef.current;
      if (!token) return;
      if (Date.now() < rateLimitRef.current.until) return;
      const res = await fetch(
        `https://api.spotify.com/v1/me/player/volume?volume_percent=${Math.round(
          clamped * 100
        )}&device_id=${activeDeviceIdRef.current}`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (res.status === 429) {
        const retry = res.headers.get("Retry-After");
        const retryMs = retry ? Number(retry) * 1000 : rateLimitRef.current.backoffMs;
        rateLimitRef.current.until = Date.now() + retryMs;
        rateLimitRef.current.backoffMs = Math.min(
          rateLimitRef.current.backoffMs * 2,
          30000
        );
        setError(`Spotify is even druk. Opnieuw in ${Math.ceil(retryMs / 1000)}s`);
        return;
      }
      rateLimitRef.current.backoffMs = 2500;
      return;
    }
    await playerRef.current?.setVolume?.(clamped);
  }

  async function transferPlayback(id: string, play = false) {
    const token = accessTokenRef.current;
    if (!token) return;
    if (Date.now() < rateLimitRef.current.until) return;
    const res = await fetch("https://api.spotify.com/v1/me/player", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ device_ids: [id], play }),
    });
    if (res.status === 429) {
      const retry = res.headers.get("Retry-After");
      const retryMs = retry ? Number(retry) * 1000 : rateLimitRef.current.backoffMs;
      rateLimitRef.current.until = Date.now() + retryMs;
      rateLimitRef.current.backoffMs = Math.min(
        rateLimitRef.current.backoffMs * 2,
        60000
      );
      setError(`Spotify is even druk. Opnieuw in ${Math.ceil(retryMs / 1000)}s`);
      return;
    }
    rateLimitRef.current.backoffMs = 5000;
  }

  if (sessionStatus === "loading") {
    return (
      <div className="player-card">
        <div className="player-meta">
          <div className="player-title">Spotify Player</div>
          <div className="text-body">Spotify‑sessie verbinden...</div>
        </div>
      </div>
    );
  }

  if (!canUseSdk) {
    return (
      <div className="player-card">
        <div className="player-meta">
          <div className="player-title">Spotify Player</div>
          <div className="text-body">
            Verbind Spotify om in de browser af te spelen.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="player-card">
      <div className="player-cover">
        {playerState?.coverUrl ? (
          <Image
            src={playerState.coverUrl}
            alt={playerState.album || "Album"}
            width={64}
            height={64}
            unoptimized
          />
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
        {error ? <div className="text-subtle">Probleem met afspelen: {error}</div> : null}
        {activeDeviceRestricted ? (
          <div className="text-subtle">
            Dit apparaat ondersteunt geen afstandsbediening.
          </div>
        ) : null}
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
          <span>
            {activeDeviceName
              ? `Spotify Connect • ${activeDeviceName}`
              : deviceId
              ? "Spotify Connect"
              : "Verbinden..."}
          </span>
          <button
            type="button"
            className="detail-btn"
            aria-label="Apparaten vernieuwen"
            title="Apparaten vernieuwen"
            onClick={refreshDevices}
          >
            ↻
          </button>
        </div>
        <div className="player-device-select">
          <div className="combo" style={{ width: "100%" }}>
            <button
              type="button"
              className="combo-input"
              onMouseDown={() => setDeviceMenuOpen((prev) => !prev)}
              onBlur={() => {
                setTimeout(() => {
                  if (!deviceCloseRef.current) setDeviceMenuOpen(false);
                  deviceCloseRef.current = false;
                }, 100);
              }}
              aria-label="Kies een Spotify‑apparaat"
              aria-haspopup="listbox"
              aria-expanded={deviceMenuOpen}
            >
              {devices.find((d) => d.id === (activeDeviceId || deviceId))?.name ||
                "Kies apparaat"}
            </button>
            {deviceMenuOpen ? (
              <div className="combo-list" role="listbox">
                {devices.length === 0 ? (
                  <div className="combo-empty">Geen apparaten gevonden.</div>
                ) : (
                  devices.map((device) => (
                    <button
                      key={device.id}
                      type="button"
                      role="option"
                      aria-selected={device.id === (activeDeviceId || deviceId)}
                      className={`combo-item${
                        device.id === (activeDeviceId || deviceId) ? " active" : ""
                      }`}
                      onMouseDown={() => {
                        deviceCloseRef.current = true;
                        handleDeviceChange(device.id);
                        setDeviceMenuOpen(false);
                      }}
                    >
                      {device.name}{" "}
                      <span className="text-subtle">({device.type})</span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>
        </div>
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
            disabled={!activeDeviceSupportsVolume}
          />
        </div>
      </div>
    </div>
  );
}
