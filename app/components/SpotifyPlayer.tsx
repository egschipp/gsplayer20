"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { hasPlaybackScopes } from "@/lib/spotify/scopes";

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
  const scope = session?.scope as string | undefined;
  const playbackAllowed = hasPlaybackScopes(scope);
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
  const [shuffleOn, setShuffleOn] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [volume, setVolume] = useState(0.5);
  const [muted, setMuted] = useState(false);
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
  const [deviceMissing, setDeviceMissing] = useState(false);
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const deviceCloseRef = useRef(false);
  const lastDeviceSelectRef = useRef(0);
  const pendingDeviceIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playbackTouched, setPlaybackTouched] = useState(false);
  const playerRef = useRef<any>(null);
  const deviceIdRef = useRef<string | null>(null);
  const accessTokenRef = useRef<string | undefined>(accessToken);
  const sdkDeviceIdRef = useRef<string | null>(null);
  const activeDeviceIdRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  const rateLimitRef = useRef({ until: 0, backoffMs: 5000 });
  const lastRequestAtRef = useRef(0);
  const lastDevicesRefreshRef = useRef(0);
  const lastSdkEventAtRef = useRef(0);
  const sdkReadyRef = useRef(false);
  const seekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isScrubbingRef = useRef(false);
  const lastUserSeekAtRef = useRef(0);
  const lastUserVolumeAtRef = useRef(0);
  const lastNonZeroVolumeRef = useRef(0.5);

  function formatPlayerError(message?: string | null) {
    if (!message) return null;
    const lower = String(message).toLowerCase();
    if (lower.includes("invalid token scopes") || lower.includes("insufficient_scope")) {
      return "Ontbrekende Spotify‑rechten. Koppel opnieuw.";
    }
    if (lower.includes("authentication") || lower.includes("token")) {
      return "Verbinding met Spotify is verlopen. Koppel opnieuw.";
    }
    return message;
  }

  const playerErrorMessage = formatPlayerError(error);
  const lastTrackIdRef = useRef<string | null>(null);
  const pendingTrackIdRef = useRef<string | null>(null);
  const trackChangeLockUntilRef = useRef(0);
  const lastProgressSyncRef = useRef(0);
  const lastKnownPositionRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canUseSdk = useMemo(
    () => Boolean(accessToken) && playbackAllowed,
    [accessToken, playbackAllowed]
  );

  const applySdkState = useCallback(
    (state: any) => {
      if (!state) return;
      lastSdkEventAtRef.current = Date.now();
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
      setPlayerState((prev) => {
        const next = {
          name: current?.name ?? prev?.name ?? "Unknown track",
          artists: (current?.artists ?? [])
            .map((a: any) => a.name)
            .join(", "),
          album: current?.album?.name ?? prev?.album ?? "",
          coverUrl: current?.album?.images?.[0]?.url ?? prev?.coverUrl ?? null,
          paused: Boolean(state.paused),
          positionMs: isNewTrack ? 0 : nextPosition,
          durationMs: nextDuration,
        };
        if (
          prev &&
          prev.name === next.name &&
          prev.artists === next.artists &&
          prev.album === next.album &&
          prev.coverUrl === next.coverUrl &&
          prev.paused === next.paused &&
          prev.positionMs === next.positionMs &&
          prev.durationMs === next.durationMs
        ) {
          return prev;
        }
        return next;
      });
      const allowProgressUpdate = Date.now() >= trackChangeLockUntilRef.current;
      const safePosition = isNewTrack || !allowProgressUpdate ? 0 : nextPosition;
      if (!isScrubbingRef.current) {
        setPositionMs(safePosition);
        lastKnownPositionRef.current = safePosition;
      }
      setDurationMs(nextDuration);
      if (onTrackChange) onTrackChange(trackId);
    },
    [onTrackChange]
  );

  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    return () => {
      if (seekTimerRef.current) clearTimeout(seekTimerRef.current);
      if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  const setActiveDevice = useCallback((id: string | null, name?: string | null) => {
    setActiveDeviceId(id);
    activeDeviceIdRef.current = id;
    if (name !== undefined) {
      setActiveDeviceName(name);
    }
  }, []);

  const refreshDevices = useCallback(async (force = false) => {
    const token = accessTokenRef.current;
    if (!token) return;
    const now = Date.now();
    if (!force && now - lastDevicesRefreshRef.current < 3000) return;
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
    const mapped = list.map((d: any) => ({
      id: d.id,
      name: d.name,
      isActive: Boolean(d.is_active),
      type: d.type,
      isRestricted: Boolean(d.is_restricted),
      supportsVolume: d.supports_volume !== false,
    }));
    setDevices(mapped);
    const active = list.find((d: any) => d.is_active);
    if (active?.id) {
      setActiveDevice(active.id, active.name ?? null);
      setActiveDeviceRestricted(Boolean(active.is_restricted));
      setActiveDeviceSupportsVolume(active.supports_volume !== false);
    }
  }, [setActiveDevice]);

  useEffect(() => {
    if (!accessToken) return;
    const interval = setInterval(() => {
      refreshDevices();
    }, 10000);
    return () => clearInterval(interval);
  }, [accessToken, refreshDevices]);

  useEffect(() => {
    if (!canUseSdk) {
      onReady(null);
      if (accessToken && !playbackAllowed) {
        setError("Ontbrekende Spotify‑rechten. Koppel opnieuw.");
      }
      return;
    }

    if (window.Spotify) {
      const cleanup = initializePlayer();
      return () => {
        if (typeof cleanup === "function") cleanup();
      };
    }

    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    document.body.appendChild(script);
    let cleanup: (() => void) | undefined;
    window.onSpotifyWebPlaybackSDKReady = () => {
      cleanup = initializePlayer();
    };

    return () => {
      if (script.parentNode) script.parentNode.removeChild(script);
      if (typeof cleanup === "function") cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseSdk, accessToken]);

  function initializePlayer() {
    if (!accessToken || readyRef.current) return;
    readyRef.current = true;

    const player = new window.Spotify.Player({
      name: "GSPlayer20 Web",
      getOAuthToken: (cb: (token: string) => void) => cb(accessToken),
      volume: 0.5,
    });

    const onSdkReady = async ({ device_id }: { device_id: string }) => {
      setDeviceId(device_id);
      deviceIdRef.current = device_id;
      sdkDeviceIdRef.current = device_id;
      sdkReadyRef.current = true;
      lastSdkEventAtRef.current = Date.now();
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
    };

    const onNotReady = () => {
      setDeviceId(null);
      sdkDeviceIdRef.current = null;
      sdkReadyRef.current = false;
    };

    const onStateChanged = (state: any) => {
      applySdkState(state);
    };

    const onInitError = ({ message }: { message: string }) => {
      setError(message);
    };
    const onAuthError = ({ message }: { message: string }) => {
      setError(message);
    };
    const onAccountError = ({ message }: { message: string }) => {
      setError(message);
    };
    const onAutoplayFailed = () => {
      setError("Autoplay is geblokkeerd door de browser. Klik op Play.");
    };

    player.addListener("ready", onSdkReady);
    player.addListener("not_ready", onNotReady);
    player.addListener("player_state_changed", onStateChanged);
    player.addListener("initialization_error", onInitError);
    player.addListener("authentication_error", onAuthError);
    player.addListener("account_error", onAccountError);
    player.addListener("autoplay_failed", onAutoplayFailed);

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

    return () => {
      player.removeListener("ready", onSdkReady);
      player.removeListener("not_ready", onNotReady);
      player.removeListener("player_state_changed", onStateChanged);
      player.removeListener("initialization_error", onInitError);
      player.removeListener("authentication_error", onAuthError);
      player.removeListener("account_error", onAccountError);
      player.removeListener("autoplay_failed", onAutoplayFailed);
      player.disconnect();
    };
  }

  useEffect(() => {
    if (!playerState || playerState.paused) return;
    const interval = setInterval(() => {
      if (isScrubbingRef.current) return;
      setPositionMs((prev) => {
        const next = Math.min(prev + 500, durationMs || prev + 500);
        lastKnownPositionRef.current = next;
        return next;
      });
    }, 500);
    return () => clearInterval(interval);
  }, [playerState, durationMs]);

  useEffect(() => {
    if (!accessToken) return;
    refreshDevices();
  }, [accessToken, deviceId, refreshDevices]);

  useEffect(() => {
    function handleFocus() {
      refreshDevices();
    }
    if (typeof window === "undefined") return;
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refreshDevices]);

  useEffect(() => {
    const now = Date.now();
    if (!canUseSdk) {
      setDeviceMissing(false);
      return;
    }
    if (now - lastDevicesRefreshRef.current < 2000) {
      return;
    }
    if (!activeDeviceId && !deviceId && devices.length === 0) {
      setDeviceMissing(true);
    } else {
      setDeviceMissing(false);
    }
  }, [activeDeviceId, deviceId, devices, canUseSdk]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;

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
      const now = Date.now();
      if (sdkReadyRef.current && now - lastSdkEventAtRef.current < 4000) {
        scheduleNext();
        return;
      }
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
        const nextPosition = isNewTrack ? 0 : data.progress_ms ?? 0;
        const positionDelta = nextPosition - lastKnownPositionRef.current;
        const shouldSyncPosition =
          Math.abs(positionDelta) > 2200 ||
          Date.now() - lastProgressSyncRef.current > 6000;
        setPlayerState((prev) => {
          const next = {
            name: item.name ?? prev?.name ?? "Unknown track",
            artists: (item.artists ?? []).map((a: any) => a.name).join(", "),
            album: item.album?.name ?? prev?.album ?? "",
            coverUrl: item.album?.images?.[0]?.url ?? prev?.coverUrl ?? null,
            paused: Boolean(!data.is_playing),
            positionMs: nextPosition,
            durationMs: item.duration_ms ?? 0,
          };
          if (
            prev &&
            prev.name === next.name &&
            prev.artists === next.artists &&
            prev.album === next.album &&
            prev.coverUrl === next.coverUrl &&
            prev.paused === next.paused &&
            prev.positionMs === next.positionMs &&
            prev.durationMs === next.durationMs
          ) {
            return prev;
          }
          return next;
        });
        const allowProgressUpdate = Date.now() >= trackChangeLockUntilRef.current;
        if (shouldSyncPosition && !isScrubbingRef.current) {
          lastProgressSyncRef.current = Date.now();
          const synced = isNewTrack || !allowProgressUpdate ? 0 : nextPosition;
          if (
            positionDelta < -1200 &&
            data?.is_playing &&
            Date.now() - lastUserSeekAtRef.current > 1500
          ) {
            // Avoid small backward jumps while playing unless the user just sought.
          } else {
            setPositionMs(synced);
            lastKnownPositionRef.current = synced;
          }
        }
        setDurationMs(item.duration_ms ?? 0);
        if (onTrackChange) onTrackChange(item.id ?? null);
      }
      if (typeof device?.volume_percent === "number") {
        if (Date.now() - lastUserVolumeAtRef.current > 1500) {
          const nextVol = device.volume_percent / 100;
          setVolume(nextVol);
          if (nextVol > 0) {
            lastNonZeroVolumeRef.current = nextVol;
            setMuted(false);
          } else {
            setMuted(true);
          }
        }
      }
      if (typeof data?.shuffle_state === "boolean") {
        setShuffleOn(data.shuffle_state);
      }
      setError(null);
      scheduleNext(data?.is_playing);
    }

    function scheduleNext(isPlaying?: boolean) {
      if (cancelled) return;
      const baseDelay = isPlaying ? 3500 : 8000;
      const waitExtra = Math.max(rateLimitRef.current.until - Date.now(), 0);
      const delay = Math.min(baseDelay + waitExtra, 15000);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = setTimeout(poll, delay);
    }

    poll();
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
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
    refreshDevices(true);
    setTimeout(() => refreshDevices(true), 800);
  }

  async function handleTogglePlay() {
    setPlaybackTouched(true);
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
    setPlaybackTouched(true);
    const token = accessTokenRef.current;
    const currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
    if (!token || !currentDevice) return;
    if (Date.now() < rateLimitRef.current.until) return;
    if (currentDevice === sdkDeviceIdRef.current) {
      await playerRef.current?.nextTrack?.();
      setTimeout(async () => {
        const state = await playerRef.current?.getCurrentState?.();
        if (state) applySdkState(state);
      }, 350);
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
    pendingTrackIdRef.current = null;
  }

  async function handlePrevious() {
    setPlaybackTouched(true);
    const token = accessTokenRef.current;
    const currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
    if (!token || !currentDevice) return;
    if (Date.now() < rateLimitRef.current.until) return;
    if (currentDevice === sdkDeviceIdRef.current) {
      await playerRef.current?.previousTrack?.();
      setTimeout(async () => {
        const state = await playerRef.current?.getCurrentState?.();
        if (state) applySdkState(state);
      }, 350);
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

  async function handleToggleShuffle() {
    setPlaybackTouched(true);
    const token = accessTokenRef.current;
    const currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
    if (!token || !currentDevice) return;
    if (Date.now() < rateLimitRef.current.until) return;
    const next = !shuffleOn;
    const res = await fetch(
      `https://api.spotify.com/v1/me/player/shuffle?state=${next ? "true" : "false"}&device_id=${currentDevice}`,
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
    setShuffleOn(next);
  }

  function formatTime(ms?: number) {
    if (!ms || ms < 0) return "0:00";
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, "0")}`;
  }

  async function handleSeek(nextMs: number) {
    setPlaybackTouched(true);
    const token = accessTokenRef.current;
    const currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
    if (!token || !currentDevice) return;
    if (Date.now() < rateLimitRef.current.until) return;
    setPositionMs(nextMs);
    lastUserSeekAtRef.current = Date.now();
    if (seekTimerRef.current) clearTimeout(seekTimerRef.current);
    seekTimerRef.current = setTimeout(async () => {
      if (currentDevice === sdkDeviceIdRef.current) {
        await playerRef.current?.seek?.(Math.floor(nextMs));
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
    }, 120);
  }

  async function handleVolume(nextVolume: number) {
    setPlaybackTouched(true);
    const clamped = Math.max(0, Math.min(1, nextVolume));
    setVolume(clamped);
    lastUserVolumeAtRef.current = Date.now();
    if (clamped > 0) {
      lastNonZeroVolumeRef.current = clamped;
      if (muted) setMuted(false);
    } else {
      if (!muted) setMuted(true);
    }
    if (
      activeDeviceIdRef.current &&
      activeDeviceIdRef.current !== sdkDeviceIdRef.current
    ) {
      const token = accessTokenRef.current;
      if (!token) return;
      if (Date.now() < rateLimitRef.current.until) return;
      if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
      volumeTimerRef.current = setTimeout(async () => {
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
            60000
          );
          setError(`Spotify is even druk. Opnieuw in ${Math.ceil(retryMs / 1000)}s`);
          return;
        }
        rateLimitRef.current.backoffMs = 5000;
      }, 120);
      return;
    }
    if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
    volumeTimerRef.current = setTimeout(async () => {
      await playerRef.current?.setVolume?.(clamped);
    }, 120);
  }

  async function handleToggleMute() {
    setPlaybackTouched(true);
    if (muted || volume === 0) {
      const restore = Math.max(0.05, lastNonZeroVolumeRef.current || 0.5);
      setMuted(false);
      await handleVolume(restore);
      return;
    }
    lastNonZeroVolumeRef.current = volume || lastNonZeroVolumeRef.current || 0.5;
    setMuted(true);
    await handleVolume(0);
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
          {!playbackAllowed && accessToken ? (
            <div className="text-subtle">
              Je mist rechten voor afspelen. Koppel opnieuw om door te gaan.
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="player-card">
      <div className="player-main">
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
        <div className="player-meta player-meta-wide">
          <div className="player-title">{playerState?.name || "Ready to play"}</div>
          <div className="text-body">
            {playerState?.artists || "Select a track to start playback"}
          </div>
          {playerState?.album ? (
            <div className="text-subtle">{playerState.album}</div>
          ) : null}
        {playerErrorMessage && playbackTouched ? (
          <div className="text-subtle">
            Probleem met afspelen: {playerErrorMessage}
            {playerErrorMessage.includes("Koppel opnieuw") ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ marginLeft: 8 }}
                  onClick={() => {
                    window.location.href = "/api/auth/login";
                  }}
                >
                  Opnieuw verbinden
                </button>
              ) : null}
            </div>
          ) : null}
        {activeDeviceRestricted ? (
          <div className="text-subtle">
            Dit apparaat ondersteunt geen afstandsbediening.
          </div>
        ) : null}
        {deviceMissing ? (
          <div className="text-subtle">
            Geen Spotify‑apparaat geselecteerd. Kies een apparaat om af te spelen.
          </div>
        ) : null}
        </div>
        <div className="player-controls">
          <div
            className={`player-control player-control-ghost player-control-grad${
              shuffleOn ? " active" : ""
            }`}
            role="button"
            tabIndex={0}
            aria-label={shuffleOn ? "Shuffle uit" : "Shuffle aan"}
            title={shuffleOn ? "Shuffle uit" : "Shuffle aan"}
            onClick={handleToggleShuffle}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handleToggleShuffle();
              }
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M11.5 2a.5.5 0 0 0 0 1h1.086l-2.54 2.54-2.01-2.01a.5.5 0 0 0-.707 0L2 8.86a.5.5 0 1 0 .707.707l4.83-4.83 2.01 2.01a.5.5 0 0 0 .707 0L13.5 3.5V4.6a.5.5 0 0 0 1 0V2.5a.5.5 0 0 0-.5-.5h-2.5zm1 10H11.4a.5.5 0 0 0 0 1h2.1a.5.5 0 0 0 .5-.5V10a.5.5 0 0 0-1 0v1.1l-2.747-2.746a.5.5 0 0 0-.707 0l-2.01 2.01-1.83-1.83a.5.5 0 0 0-.707.707l2.183 2.183a.5.5 0 0 0 .707 0l2.01-2.01 2.6 2.6a.5.5 0 0 0 .707-.707L12.5 11.1V12z" />
            </svg>
          </div>
          <div
            className="player-control player-control-ghost player-control-grad"
            role="button"
            tabIndex={0}
            aria-label="Previous"
            title="Previous"
            onClick={handlePrevious}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handlePrevious();
              }
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M3.5 3.5a.5.5 0 0 0-1 0v9a.5.5 0 0 0 1 0v-9zm1.6 4.1 6.2 4.1a.5.5 0 0 0 .8-.4V4.7a.5.5 0 0 0-.8-.4L5.1 8.4a.5.5 0 0 0 0 .8z" />
            </svg>
          </div>
          <div
            className="player-control player-control-play player-control-grad"
            role="button"
            tabIndex={0}
            aria-label={playerState?.paused ? "Play" : "Pause"}
            title={playerState?.paused ? "Play" : "Pause"}
            onClick={handleTogglePlay}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handleTogglePlay();
              }
            }}
          >
            {playerState?.paused ? (
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M4.5 3.5v9l8-4.5-8-4.5z" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" />
              </svg>
            )}
          </div>
          <div
            className="player-control player-control-ghost player-control-grad"
            role="button"
            tabIndex={0}
            aria-label="Next"
            title="Next"
            onClick={handleNext}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handleNext();
              }
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M12.5 3.5a.5.5 0 0 0-1 0v9a.5.5 0 0 0 1 0v-9zM10.9 8.4 4.7 4.3a.5.5 0 0 0-.8.4v6.6a.5.5 0 0 0 .8.4l6.2-4.1a.5.5 0 0 0 0-.8z" />
            </svg>
          </div>
        </div>
        <div className="player-progress player-progress-main">
          <span className="text-subtle">{formatTime(positionMs)}</span>
          <input
            type="range"
            min={0}
            max={durationMs || 1}
            value={Math.min(positionMs, durationMs || 1)}
            onChange={(event) => setPositionMs(Number(event.target.value))}
            onMouseDown={() => {
              isScrubbingRef.current = true;
            }}
            onTouchStart={() => {
              isScrubbingRef.current = true;
            }}
            onMouseUp={() => {
              if (!isScrubbingRef.current) return;
              isScrubbingRef.current = false;
              handleSeek(positionMs);
            }}
            onTouchEnd={() => {
              if (!isScrubbingRef.current) return;
              isScrubbingRef.current = false;
              handleSeek(positionMs);
            }}
            className="player-slider"
            aria-label="Seek"
          />
          <span className="text-subtle">{formatTime(durationMs)}</span>
        </div>
      </div>
      <div className="player-connect">
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
            onClick={() => refreshDevices(true)}
          >
            ↻
          </button>
        </div>
        <div className="player-device-select">
          <div className="combo" style={{ width: "100%" }}>
            <button
              type="button"
              className="combo-input"
              onMouseDown={() => {
                setDeviceMenuOpen((prev) => !prev);
                refreshDevices(true);
              }}
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
          <button
            type="button"
            className={`player-control player-control-ghost volume-toggle${
              muted || volume === 0 ? " active" : ""
            }`}
            aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
            title={muted || volume === 0 ? "Unmute" : "Mute"}
            onClick={handleToggleMute}
          >
            {muted || volume === 0 ? "🔇" : "🔊"}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(event) => handleVolume(Number(event.target.value))}
            className="player-slider player-slider-volume"
            aria-label="Volume"
            disabled={!activeDeviceSupportsVolume}
          />
        </div>
      </div>
    </div>
  );
}
