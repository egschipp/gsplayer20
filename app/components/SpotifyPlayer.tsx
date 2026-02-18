"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSession, useSession } from "next-auth/react";
import { usePathname } from "next/navigation";
import {
  SPOTIFY_PLAYBACK_SCOPES,
  hasPlaybackScopes,
  parseScopes,
} from "@/lib/spotify/scopes";
import { usePlaybackCommandQueue } from "./player/usePlaybackCommandQueue";
import { useQueueStore } from "@/lib/queue/QueueProvider";
import { useQueuePlayback } from "@/lib/playback/QueuePlaybackProvider";
import { useStableMenu } from "@/lib/hooks/useStableMenu";

declare global {
  interface Window {
    Spotify: any;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

const PLAYER_FETCH_TIMEOUT_MS = 12000;
const PLAYER_FETCH_MAX_ATTEMPTS = 3;
const LOCAL_WEBPLAYER_NAME = "Georgies Webplayer";
const DEVICE_SELECTION_HOLD_MS = 45_000;

function detectWebplayerPlatform() {
  if (typeof navigator === "undefined") return "";
  const ua = navigator.userAgent.toLowerCase();
  const maxTouchPoints = Number((navigator as Navigator).maxTouchPoints ?? 0);
  if (/ipad/.test(ua)) return "iPad";
  if (/macintosh/.test(ua) && maxTouchPoints > 1) return "iPad";
  if (/iphone/.test(ua)) return "iPhone";
  if (/android/.test(ua)) return "Android";
  if (/macintosh|mac os x/.test(ua)) return "Mac";
  if (/windows/.test(ua)) return "Windows";
  return "";
}

export type PlayerApi = {
  primePlaybackGesture?: () => void;
  playQueue: (uris: string[], offsetUri?: string, offsetIndex?: number | null) => Promise<void>;
  playContext: (
    contextUri: string,
    offsetPosition?: number | null,
    offsetUri?: string
  ) => Promise<void>;
  togglePlay: () => Promise<void>;
  next: () => Promise<void>;
  previous: () => Promise<void>;
};

type PlayerProps = {
  onReady: (api: PlayerApi | null) => void;
  onTrackChange?: (trackId: string | null) => void;
};

function getWebPlaybackSdkSupport() {
  if (typeof window === "undefined") {
    return { supported: false, reason: "Webplayer vereist een browsercontext." };
  }
  if (!window.isSecureContext) {
    return {
      supported: false,
      reason: "Webplayer vereist HTTPS (secure context).",
    };
  }
  const hasAudioContext =
    typeof window.AudioContext !== "undefined" ||
    typeof (window as any).webkitAudioContext !== "undefined";
  const hasMediaSource = typeof (window as any).MediaSource !== "undefined";
  if (!hasAudioContext || !hasMediaSource) {
    return {
      supported: false,
      reason: "Browser ondersteunt Spotify Web Playback niet volledig.",
    };
  }
  return { supported: true, reason: null as string | null };
}

async function readJsonSafely<T = any>(
  res: Response | null | undefined
): Promise<T | null> {
  if (!res) return null;
  if (res.status === 204 || res.status === 205 || res.status === 304) return null;
  if (res.headers.get("content-length") === "0") return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export default function SpotifyPlayer({ onReady, onTrackChange }: PlayerProps) {
  const { data: session, status: sessionStatus } = useSession();
  const pathname = usePathname();
  const customQueue = useQueueStore();
  const customQueuePlayback = useQueuePlayback();
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
  const [currentTrackIdState, setCurrentTrackIdState] = useState<string | null>(null);
  const [currentTrackLiked, setCurrentTrackLiked] = useState<boolean | null>(null);
  const [likedStateLoading, setLikedStateLoading] = useState(false);
  const [likedStateSaving, setLikedStateSaving] = useState(false);
  const [shuffleOn, setShuffleOn] = useState(false);
  const [shufflePending, setShufflePending] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [volume, setVolume] = useState(0.5);
  const [muted, setMuted] = useState(false);
  const [repeatMode, setRepeatMode] = useState<"off" | "context" | "track">("off");
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueItems, setQueueItems] = useState<
    { id: string; name: string; artists: string; coverUrl: string | null }[]
  >([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [devices, setDevices] = useState<
    {
      id: string;
      name: string;
      isActive: boolean;
      type: string;
      isRestricted?: boolean;
      supportsVolume?: boolean;
      selectable?: boolean;
      unavailableReason?: string | null;
    }[]
  >([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [activeDeviceName, setActiveDeviceName] = useState<string | null>(null);
  const [activeDeviceRestricted, setActiveDeviceRestricted] = useState(false);
  const [activeDeviceSupportsVolume, setActiveDeviceSupportsVolume] = useState(true);
  const [sdkReadyState, setSdkReadyState] = useState(false);
  const [sdkLastError, setSdkLastError] = useState<string | null>(null);
  const [sdkLifecycle, setSdkLifecycle] = useState<
    "idle" | "loading" | "connecting" | "ready" | "error"
  >("idle");
  const [accountProduct, setAccountProduct] = useState<string | null>(null);
  const [accountProductChecked, setAccountProductChecked] = useState(false);
  const [deviceMissing, setDeviceMissing] = useState(false);
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const lastDeviceSelectRef = useRef(0);
  const pendingDeviceIdRef = useRef<string | null>(null);
  const preferSdkDeviceRef = useRef(true);
  const lastConfirmedActiveDeviceRef = useRef<{ id: string; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playbackTouched, setPlaybackTouched] = useState(false);
  const [optimisticTrack, setOptimisticTrack] = useState<{
    name: string;
    artists: string;
    album: string;
    coverUrl: string | null;
  } | null>(null);
  const playerRef = useRef<any>(null);
  const deviceIdRef = useRef<string | null>(null);
  const accessTokenRef = useRef<string | undefined>(accessToken);
  const sdkDeviceIdRef = useRef<string | null>(null);
  const activeDeviceIdRef = useRef<string | null>(null);
  const activeDeviceNameRef = useRef<string | null>(null);
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
  const likedCacheRef = useRef<Map<string, boolean>>(new Map());
  const likedRequestIdRef = useRef(0);
  const lastSdkStateRef = useRef<any>(null);
  const lastIsPlayingRef = useRef(false);
  const playerStateRef = useRef<typeof playerState>(null);
  const shuffleOnRef = useRef(shuffleOn);
  const shufflePendingRef = useRef(false);
  const lastShuffleSyncRef = useRef(0);
  const queueUrisRef = useRef<string[] | null>(null);
  const queueIndexRef = useRef(0);
  const queueOrderRef = useRef<number[] | null>(null);
  const queuePosRef = useRef(0);
  const queueModeRef = useRef<"queue" | "context" | null>(null);
  const shuffleInitDoneRef = useRef(false);
  const [deviceReady, setDeviceReady] = useState(false);
  const { enqueue: enqueueCommand, busy: commandBusy } = usePlaybackCommandQueue();
  const lastCommandAtRef = useRef(0);
  const playbackRecoveryRef = useRef(false);
  const deviceMenu = useStableMenu<HTMLDivElement>({
    onClose: () => setDeviceMenuOpen(false),
  });

  function formatPlayerError(message?: string | null) {
    if (!message) return null;
    const lower = String(message).toLowerCase();
    if (lower.includes("invalid token scopes") || lower.includes("insufficient_scope")) {
      return "Ontbrekende Spotify‑rechten. Koppel opnieuw.";
    }
    if (lower.includes("403")) {
      return "Ontbrekende Spotify‑rechten. Koppel opnieuw.";
    }
    if (lower.includes("401")) {
      return "Spotify‑sessie verlopen. Koppel opnieuw.";
    }
    if (lower.includes("authentication") || lower.includes("token")) {
      return "Verbinding met Spotify is verlopen. Koppel opnieuw.";
    }
    if (lower.includes("premium")) {
      return "Spotify Premium is vereist voor Web Playback.";
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
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const playerCleanupRef = useRef<(() => void) | null>(null);
  const autoBootAttemptedRef = useRef(false);

  const playbackSessionReady = useMemo(
    () => Boolean(accessToken) && playbackAllowed,
    [accessToken, playbackAllowed]
  );
  const missingPlaybackScopes = useMemo(() => {
    const granted = parseScopes(scope);
    return SPOTIFY_PLAYBACK_SCOPES.filter((required) => !granted.has(required));
  }, [scope]);
  const localWebplayerPlatform = useMemo(() => detectWebplayerPlatform(), []);
  const localWebplayerName = useMemo(
    () =>
      localWebplayerPlatform
        ? `${LOCAL_WEBPLAYER_NAME} - ${localWebplayerPlatform}`
        : LOCAL_WEBPLAYER_NAME,
    [localWebplayerPlatform]
  );
  const localWebplayerType = "Webplayer";
  const sdkSupport = useMemo(() => getWebPlaybackSdkSupport(), []);
  const sdkSupported = sdkSupport.supported;
  const premiumRequired =
    accountProductChecked && Boolean(accountProduct) && accountProduct !== "premium";
  const canUseSdk = playbackSessionReady && sdkSupported && !premiumRequired;
  const withDeviceId = (baseUrl: string, targetDeviceId: string) => {
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}device_id=${encodeURIComponent(targetDeviceId)}`;
  };

  const kickstartLocalPlayer = useCallback(async () => {
    setPlaybackTouched(true);
    preferSdkDeviceRef.current = true;
    setSdkLastError(null);
    if (
      canUseSdk &&
      !playerRef.current &&
      typeof window !== "undefined" &&
      window.Spotify &&
      !readyRef.current
    ) {
      const cleanup = initializePlayer();
      if (typeof cleanup === "function") {
        playerCleanupRef.current = cleanup;
      }
    }
    try {
      await playerRef.current?.activateElement?.();
    } catch {
      // ignore activation issues; connect can still succeed
    }
    try {
      const connected = await playerRef.current?.connect?.();
      if (connected === false) {
        setSdkLastError("Lokale webplayer kon niet verbinden.");
      }
    } catch {
      setSdkLastError("Lokale webplayer kon niet verbinden.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseSdk]);
  const isCustomQueueActive =
    customQueue.mode === "queue" && customQueue.items.length > 0;
  const isQueuePage = (pathname ?? "").startsWith("/queue");
  const isCurrentTrackFromCustomQueue = useMemo(() => {
    if (!currentTrackIdState) return false;
    return customQueue.items.some((item) => item.trackId === currentTrackIdState);
  }, [currentTrackIdState, customQueue.items]);
  const selectableDevicesCount = useMemo(
    () => devices.filter((device) => device.selectable).length,
    [devices]
  );

  useEffect(() => {
    playerStateRef.current = playerState;
  }, [playerState]);

  useEffect(() => {
    activeDeviceNameRef.current = activeDeviceName;
  }, [activeDeviceName]);


  useEffect(() => {
    shuffleOnRef.current = shuffleOn;
  }, [shuffleOn]);

  const applyRateLimit = useCallback((res: Response) => {
    if (res.status !== 429) return false;
    const retry = res.headers.get("Retry-After");
    const parsedRetryMs = retry ? Number(retry) * 1000 : NaN;
    const retryMs =
      Number.isFinite(parsedRetryMs) && parsedRetryMs > 0
        ? parsedRetryMs
        : rateLimitRef.current.backoffMs;
    rateLimitRef.current.until = Date.now() + retryMs;
    rateLimitRef.current.backoffMs = Math.min(
      rateLimitRef.current.backoffMs * 2,
      60000
    );
    setError(`Spotify is even druk. Opnieuw in ${Math.ceil(retryMs / 1000)}s`);
    return true;
  }, []);

  const refreshClientAccessToken = useCallback(async () => {
    try {
      const next = await getSession();
      const nextToken = next?.accessToken as string | undefined;
      if (!nextToken) return null;
      accessTokenRef.current = nextToken;
      return nextToken;
    } catch {
      return null;
    }
  }, []);

  const spotifyApiFetch = useCallback(
    async (url: string, options?: RequestInit) => {
      let token = accessTokenRef.current;
      if (!token) return null;
      if (Date.now() < rateLimitRef.current.until) return null;
      const method = String(options?.method ?? "GET").toUpperCase();
      const isPlayerStateGet =
        method === "GET" && url === "https://api.spotify.com/v1/me/player";
      const isPlayerDevicesGet =
        method === "GET" && url === "https://api.spotify.com/v1/me/player/devices";
      const playerProxyUrl = isPlayerStateGet
        ? "/api/spotify/me/player?raw=1"
        : isPlayerDevicesGet
        ? "/api/spotify/me/player/devices"
        : null;
      const isPlaybackCommand =
        method !== "GET" && url.includes("https://api.spotify.com/v1/me/player");

      for (let attempt = 1; attempt <= PLAYER_FETCH_MAX_ATTEMPTS; attempt += 1) {
        if (Date.now() < rateLimitRef.current.until) return null;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PLAYER_FETCH_TIMEOUT_MS);
        try {
          const res = playerProxyUrl
            ? await fetch(playerProxyUrl, {
                method: "GET",
                cache: "no-store",
                credentials: "include",
                signal: controller.signal,
              })
            : await fetch(url, {
                ...options,
                headers: { Authorization: `Bearer ${token}`, ...options?.headers },
                signal: controller.signal,
              });

          if (applyRateLimit(res)) return null;

          if (res.ok) {
            rateLimitRef.current.backoffMs = 5000;
            return res;
          }

          if (res.status === 401) {
            if (playerProxyUrl) {
              setError("Spotify‑sessie verlopen. Koppel opnieuw.");
              return res;
            }
            const refreshed = await refreshClientAccessToken();
            if (refreshed && refreshed !== token) {
              token = refreshed;
              continue;
            }
            setError("Spotify‑sessie verlopen. Koppel opnieuw.");
            return res;
          }

          if (res.status === 403 && isPlaybackCommand) {
            setError("Ontbrekende Spotify‑rechten. Koppel opnieuw.");
            return res;
          }

          const retryableStatus =
            res.status === 500 ||
            res.status === 502 ||
            res.status === 503 ||
            res.status === 504 ||
            (isPlaybackCommand && res.status === 404);
          const hasMoreAttempts = attempt < PLAYER_FETCH_MAX_ATTEMPTS;
          if (retryableStatus && hasMoreAttempts) {
            const retryAfterHeader = res.headers.get("Retry-After");
            const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
            const waitMs =
              Number.isFinite(retryAfterMs) && retryAfterMs > 0
                ? retryAfterMs
                : Math.min(250 * attempt * attempt, 1500);
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            continue;
          }

          return res;
        } catch (error) {
          const isAbort =
            error instanceof DOMException && error.name === "AbortError";
          const isFetchError =
            String((error as Error)?.message ?? error)
              .toLowerCase()
              .includes("fetch");
          const isAccessControlError =
            String((error as Error)?.message ?? error)
              .toLowerCase()
              .includes("access control");
          const retryable = isAbort || isFetchError || isAccessControlError;
          if (!retryable || attempt >= PLAYER_FETCH_MAX_ATTEMPTS) {
            if (isPlaybackCommand) {
              setError("Spotify‑verbinding is instabiel. Probeer opnieuw.");
            }
            return null;
          }
          const waitMs = Math.min(250 * attempt * attempt, 1500);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        } finally {
          clearTimeout(timeout);
        }
      }

      return null;
    },
    [applyRateLimit, refreshClientAccessToken]
  );

  const enqueuePlaybackCommand = useCallback(
    async (fn: () => Promise<void>) => {
      lastCommandAtRef.current = Date.now();
      return enqueueCommand(fn);
    },
    [enqueueCommand]
  );

  async function ensureActiveDevice(
    targetId: string,
    token: string,
    shouldPlay = false
  ) {
    const confirmed = lastConfirmedActiveDeviceRef.current;
    if (
      confirmed &&
      confirmed.id === targetId &&
      Date.now() - confirmed.at < 12000
    ) {
      setDeviceReady(true);
      return true;
    }
    try {
      const currentRes = await spotifyApiFetch("https://api.spotify.com/v1/me/player");
      if (currentRes?.ok) {
        const current = await readJsonSafely(currentRes);
        if (current?.device?.id === targetId) {
          lastConfirmedActiveDeviceRef.current = { id: targetId, at: Date.now() };
          setDeviceReady(true);
          return true;
        }
      }
    } catch {
      // ignore
    }

    const transferred = await transferPlayback(targetId, shouldPlay);
    if (!transferred) {
      lastConfirmedActiveDeviceRef.current = null;
      setDeviceReady(false);
      return false;
    }
    const delays = [250, 500, 900, 1400, 2000];
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      try {
        const res = await spotifyApiFetch("https://api.spotify.com/v1/me/player");
        if (res?.ok) {
          const data = await readJsonSafely(res);
          if (data?.device?.id === targetId) {
            lastConfirmedActiveDeviceRef.current = { id: targetId, at: Date.now() };
            setDeviceReady(true);
            return true;
          }
        }
      } catch {
        // ignore
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
    lastConfirmedActiveDeviceRef.current = null;
    setDeviceReady(false);
    return false;
  }

  const getIndexFromTrackId = useCallback((uris: string[], trackId?: string | null) => {
    if (!trackId) return -1;
    const target = String(trackId);
    return uris.findIndex((uri) => uri.split(":").pop() === target);
  }, []);

  const buildShuffleOrder = useCallback((count: number, startIndex: number) => {
    const indices = Array.from({ length: count }, (_, i) => i);
    if (count <= 1) return indices;
    const rest = indices.filter((i) => i !== startIndex);
    for (let i = rest.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    return [startIndex, ...rest];
  }, []);

  const syncQueuePositionFromTrack = useCallback((trackId?: string | null) => {
    if (!trackId || queueModeRef.current !== "queue" || !queueUrisRef.current?.length) return;
    const index = getIndexFromTrackId(queueUrisRef.current, trackId);
    if (index < 0) return;
    queueIndexRef.current = index;
    if (!queueOrderRef.current?.length) return;
    const pos = queueOrderRef.current.indexOf(index);
    if (pos >= 0) queuePosRef.current = pos;
  }, [getIndexFromTrackId]);

  const rebuildQueueOrder = useCallback((nextShuffle: boolean, forceRebuild = false) => {
    if (queueModeRef.current !== "queue" || !queueUrisRef.current?.length) return;
    const uris = queueUrisRef.current;
    const activeTrackId = lastTrackIdRef.current || pendingTrackIdRef.current;
    const currentIndex = getIndexFromTrackId(uris, activeTrackId);
    const startIndex = currentIndex >= 0 ? currentIndex : queueIndexRef.current;
    queueIndexRef.current = Math.max(0, startIndex);
    if (nextShuffle) {
      if (
        !forceRebuild &&
        queueOrderRef.current?.length === uris.length &&
        queueOrderRef.current.includes(queueIndexRef.current)
      ) {
        queuePosRef.current = queueOrderRef.current.indexOf(queueIndexRef.current);
        return;
      }
      queueOrderRef.current = buildShuffleOrder(uris.length, queueIndexRef.current);
      queuePosRef.current = queueOrderRef.current.indexOf(queueIndexRef.current);
      if (queuePosRef.current < 0) queuePosRef.current = 0;
      return;
    }
    queueOrderRef.current = null;
    queuePosRef.current = queueIndexRef.current;
  }, [buildShuffleOrder, getIndexFromTrackId]);

  async function confirmShuffleState(expectedState?: boolean) {
    const delays = [0, 180, 380, 650];
    for (const delay of delays) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      const res = await spotifyApiFetch("https://api.spotify.com/v1/me/player");
      if (!res?.ok) continue;
      const data = await readJsonSafely(res);
      if (typeof data?.shuffle_state !== "boolean") continue;
      if (typeof expectedState === "boolean" && data.shuffle_state !== expectedState) {
        continue;
      }
      setShuffleOn(data.shuffle_state);
      shuffleOnRef.current = data.shuffle_state;
      lastShuffleSyncRef.current = Date.now();
      return data.shuffle_state;
    }
    return null;
  }

  async function setRemoteShuffleState(
    nextState: boolean,
    device: string,
    token: string,
    ensureDevice = true
  ): Promise<boolean> {
    if (ensureDevice) {
      const ready = await ensureActiveDevice(device, token, false);
      if (!ready) return false;
    }
    const res = await spotifyApiFetch(
      withDeviceId(
        `https://api.spotify.com/v1/me/player/shuffle?state=${
          nextState ? "true" : "false"
        }`,
        device
      ),
      { method: "PUT" }
    );
    if (!res?.ok) return false;
    setShuffleOn(nextState);
    shuffleOnRef.current = nextState;
    lastShuffleSyncRef.current = Date.now();
    rebuildQueueOrder(nextState, nextState);
    const confirmed = await confirmShuffleState(nextState);
    if (typeof confirmed === "boolean") {
      rebuildQueueOrder(confirmed, false);
      return true;
    }
    setTimeout(() => {
      syncPlaybackState().catch(() => undefined);
    }, 700);
    return true;
  }

  async function playUrisAtIndex(
    uris: string[],
    index: number,
    deviceId: string,
    token: string
  ) {
    const offsetUri = uris[index];
    if (!offsetUri) return;
    const id = offsetUri.split(":").pop() || null;
    pendingTrackIdRef.current = id;
    trackChangeLockUntilRef.current = Date.now() + 2000;
    setPositionMs(0);
    if (deviceId === sdkDeviceIdRef.current) {
      await playerRef.current?.activateElement?.();
    }
    const ready = await ensureActiveDevice(deviceId, token, true);
    if (!ready) {
      setError("Spotify‑apparaat is nog niet klaar. Probeer opnieuw.");
      return;
    }
    const payload = {
      uris,
      offset: { uri: offsetUri },
      position_ms: 0,
    };
    const res = await spotifyApiFetch(
      withDeviceId("https://api.spotify.com/v1/me/player/play", deviceId),
      { method: "PUT", body: JSON.stringify(payload) }
    );
    if (res && res.ok) {
      setPositionMs(0);
      lastKnownPositionRef.current = 0;
      setTimeout(() => {
        spotifyApiFetch(
          withDeviceId(
            "https://api.spotify.com/v1/me/player/seek?position_ms=0",
            deviceId
          ),
          { method: "PUT" }
        ).catch(() => undefined);
      }, 200);
      setTimeout(() => {
        syncPlaybackState().catch(() => undefined);
      }, 280);
    }
  }

  const setActiveDevice = useCallback((id: string | null, name?: string | null) => {
    setActiveDeviceId(id);
    activeDeviceIdRef.current = id;
    if (name !== undefined) {
      setActiveDeviceName(name);
    }
  }, []);

  const shouldAdoptRemoteDevice = useCallback((remoteDeviceId?: string | null) => {
    if (!remoteDeviceId) return false;
    const pendingId = pendingDeviceIdRef.current;
    if (pendingId) {
      const pendingFresh =
        Date.now() - lastDeviceSelectRef.current < DEVICE_SELECTION_HOLD_MS;
      if (!pendingFresh) {
        pendingDeviceIdRef.current = null;
      } else {
        return remoteDeviceId === pendingId;
      }
    }
    const selectedId = activeDeviceIdRef.current;
    if (!selectedId) return true;
    if (remoteDeviceId === selectedId) return true;
    const heldSelection =
      Date.now() - lastDeviceSelectRef.current < DEVICE_SELECTION_HOLD_MS;
    if (heldSelection) return false;
    return true;
  }, []);
  
  const clearPendingDeviceIfStale = useCallback(() => {
    const pendingId = pendingDeviceIdRef.current;
    if (!pendingId) return;
    const pendingFresh =
      Date.now() - lastDeviceSelectRef.current < DEVICE_SELECTION_HOLD_MS;
    if (pendingFresh) return;
    pendingDeviceIdRef.current = null;
  }, []);

  const fetchQueue = useCallback(async () => {
    if (!accessTokenRef.current) return;
    setQueueLoading(true);
    setQueueError(null);
    try {
      const res = await spotifyApiFetch("https://api.spotify.com/v1/me/player/queue");
      if (!res?.ok) {
        setQueueError("Queue ophalen lukt nu niet.");
        return;
      }
      const data = await readJsonSafely(res);
      const nextTracks = Array.isArray(data?.queue) ? data.queue : [];
      const mapped = nextTracks.map((track: any) => ({
        id: track?.id ?? crypto.randomUUID(),
        name: track?.name ?? "Onbekend nummer",
        artists: Array.isArray(track?.artists)
          ? track.artists.map((a: any) => a?.name).filter(Boolean).join(", ")
          : "",
        coverUrl: track?.album?.images?.[0]?.url ?? null,
      }));
      setQueueItems(mapped);
    } catch {
      setQueueError("Queue ophalen lukt nu niet.");
    } finally {
      setQueueLoading(false);
    }
  }, [spotifyApiFetch]);

  const syncPlaybackState = useCallback(async () => {
    const res = await spotifyApiFetch("https://api.spotify.com/v1/me/player");
    if (!res?.ok) return;
    const data = await readJsonSafely(res);
    const device = data?.device;
    if (shouldAdoptRemoteDevice(device?.id ?? null)) {
      setActiveDevice(device.id, device.name ?? null);
      setActiveDeviceRestricted(Boolean(device.is_restricted));
      setActiveDeviceSupportsVolume(device.supports_volume !== false);
      lastConfirmedActiveDeviceRef.current = { id: device.id, at: Date.now() };
      if (device.id === pendingDeviceIdRef.current) {
        pendingDeviceIdRef.current = null;
      }
    }
    const item = data?.item;
    if (item) {
      const trackId = item.id ?? null;
      const isNewTrack = trackId && trackId !== lastTrackIdRef.current;
      if (isNewTrack) {
        lastTrackIdRef.current = trackId;
        if (pendingTrackIdRef.current === trackId) {
          pendingTrackIdRef.current = null;
        }
        trackChangeLockUntilRef.current = Date.now() + 1200;
        setOptimisticTrack(null);
      }
      const nextPosition = isNewTrack ? 0 : data.progress_ms ?? 0;
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
      const syncedPosition = isNewTrack || !allowProgressUpdate ? 0 : nextPosition;
      if (!isScrubbingRef.current) {
        setPositionMs(syncedPosition);
        lastKnownPositionRef.current = syncedPosition;
      }
      setDurationMs(item.duration_ms ?? 0);
      setCurrentTrackIdState(trackId);
      if (onTrackChange) onTrackChange(trackId);
      syncQueuePositionFromTrack(trackId);
    }
    if (typeof data?.is_playing === "boolean") {
      lastIsPlayingRef.current = data.is_playing;
    }
    if (
      typeof data?.shuffle_state === "boolean" &&
      !(queueModeRef.current === "queue" && queueUrisRef.current?.length)
    ) {
      setShuffleOn(data.shuffle_state);
      shuffleOnRef.current = data.shuffle_state;
      lastShuffleSyncRef.current = Date.now();
      rebuildQueueOrder(data.shuffle_state, false);
    }
    if (typeof data?.repeat_state === "string") {
      const mode =
        data.repeat_state === "track"
          ? "track"
          : data.repeat_state === "context"
          ? "context"
          : "off";
      setRepeatMode(mode);
    }
    if (typeof device?.volume_percent === "number") {
      const nextVol = device.volume_percent / 100;
      setVolume(nextVol);
      if (nextVol > 0) lastNonZeroVolumeRef.current = nextVol;
    }
  }, [
    onTrackChange,
    rebuildQueueOrder,
    setActiveDevice,
    shouldAdoptRemoteDevice,
    spotifyApiFetch,
    syncQueuePositionFromTrack,
  ]);

  useEffect(() => {
    if (!accessToken || !currentTrackIdState) {
      setCurrentTrackLiked(null);
      setLikedStateLoading(false);
      return;
    }

    const cached = likedCacheRef.current.get(currentTrackIdState);
    if (typeof cached === "boolean") {
      setCurrentTrackLiked(cached);
      setLikedStateLoading(false);
      return;
    }

    let cancelled = false;
    const requestId = ++likedRequestIdRef.current;
    setLikedStateLoading(true);

    fetch(
      `/api/spotify/me/tracks/liked?trackId=${encodeURIComponent(currentTrackIdState)}`,
      { cache: "no-store" }
    )
      .then(async (res) => {
        if (!res.ok) return null;
        return res.json().catch(() => null);
      })
      .then((data) => {
        if (cancelled || likedRequestIdRef.current !== requestId) return;
        const liked = Boolean(data?.liked);
        likedCacheRef.current.set(currentTrackIdState, liked);
        setCurrentTrackLiked(liked);
      })
      .catch(() => {
        if (cancelled || likedRequestIdRef.current !== requestId) return;
        setCurrentTrackLiked(null);
      })
      .finally(() => {
        if (cancelled || likedRequestIdRef.current !== requestId) return;
        setLikedStateLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, currentTrackIdState]);

  const emitLikedTracksUpdated = useCallback(
    (trackId: string, action: "added" | "removed") => {
      if (typeof window === "undefined") return;
      const at = Date.now();
      window.dispatchEvent(
        new CustomEvent("gs-liked-tracks-updated", {
          detail: { trackId, action, at },
        })
      );
      try {
        window.localStorage.setItem("gs_liked_tracks_updated_at", String(at));
      } catch {
        // ignore storage issues
      }
    },
    []
  );

  const handleLikeCurrentTrack = useCallback(async () => {
    if (!currentTrackIdState) return;
    if (likedStateSaving || likedStateLoading) return;
    const removing = currentTrackLiked === true;

    const previousLiked = currentTrackLiked;
    setLikedStateSaving(true);
    setCurrentTrackLiked(!removing);
    likedCacheRef.current.set(currentTrackIdState, !removing);

    try {
      const res = await fetch("/api/spotify/me/tracks/liked", {
        method: removing ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId: currentTrackIdState }),
      });
      if (!res.ok) {
        throw new Error(`LIKE_FAILED_${res.status}`);
      }
      const data = await res.json().catch(() => null);
      const liked = typeof data?.liked === "boolean" ? data.liked : !removing;
      likedCacheRef.current.set(currentTrackIdState, liked);
      setCurrentTrackLiked(liked);
      setError(null);
      if ((!removing && liked) || (removing && !liked)) {
        emitLikedTracksUpdated(currentTrackIdState, removing ? "removed" : "added");
      }
    } catch {
      const rollback = previousLiked ?? false;
      likedCacheRef.current.set(currentTrackIdState, rollback);
      setCurrentTrackLiked(rollback);
      setError(
        removing
          ? "Track verwijderen uit Liked Songs lukt nu niet."
          : "Track toevoegen aan Liked Songs lukt nu niet."
      );
    } finally {
      setLikedStateSaving(false);
    }
  }, [
    currentTrackIdState,
    currentTrackLiked,
    emitLikedTracksUpdated,
    likedStateLoading,
    likedStateSaving,
  ]);

  const applySdkState = useCallback(
    (state: any) => {
      if (!state) return;
      lastSdkStateRef.current = state;
      lastIsPlayingRef.current = Boolean(!state.paused);
      lastSdkEventAtRef.current = Date.now();
      if (
        activeDeviceIdRef.current &&
        activeDeviceIdRef.current !== sdkDeviceIdRef.current
      ) {
        return;
      }
      const stateDeviceId = state?.device?.id ?? null;
      if (pendingDeviceIdRef.current && stateDeviceId === pendingDeviceIdRef.current) {
        setActiveDevice(stateDeviceId, state?.device?.name ?? null);
        setActiveDeviceRestricted(Boolean(state?.device?.is_restricted));
        setActiveDeviceSupportsVolume(state?.device?.supports_volume !== false);
        pendingDeviceIdRef.current = null;
        setDeviceReady(true);
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
        setOptimisticTrack(null);
      }
      if (current?.name) {
        setError(null);
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
      setCurrentTrackIdState(trackId);
      if (onTrackChange) onTrackChange(trackId);
      syncQueuePositionFromTrack(trackId);
      if (trackId && Date.now() - lastProgressSyncRef.current > 5000) {
        lastProgressSyncRef.current = Date.now();
        try {
          window.localStorage.setItem(
            "gs_last_playback",
            JSON.stringify({
              trackId,
              positionMs: safePosition,
              deviceId: stateDeviceId,
              updatedAt: Date.now(),
            })
          );
        } catch {
          // ignore storage issues
        }
      }
    },
    [onTrackChange, setActiveDevice, syncQueuePositionFromTrack]
  );

  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) {
      setAccountProduct(null);
      setAccountProductChecked(false);
      return;
    }
    let cancelled = false;
    fetch("/api/spotify/user-status", { cache: "no-store" })
      .then(async (res) => {
        const payload = await res.json().catch(() => null);
        return { ok: res.ok, status: res.status, payload };
      })
      .then((result) => {
        if (cancelled) return;
        const productRaw = result?.payload?.profile?.product;
        const product =
          typeof productRaw === "string" ? productRaw.trim().toLowerCase() : null;
        setAccountProduct(product);
        setAccountProductChecked(true);
        if (product && product !== "premium") {
          setSdkLastError("Spotify Premium is vereist voor Web Playback.");
          setSdkLifecycle("error");
          setError("Spotify Premium is vereist voor Web Playback.");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setAccountProductChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  useEffect(() => {
    return () => {
      if (seekTimerRef.current) clearTimeout(seekTimerRef.current);
      if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, []);

  const refreshDevices = useCallback(async (force = false) => {
    const token = accessTokenRef.current;
    if (!token) return;
    const now = Date.now();
    if (!force && now - lastDevicesRefreshRef.current < 3000) return;
    lastDevicesRefreshRef.current = now;
    if (!force && now < rateLimitRef.current.until) return;

    let data: any = null;
    let playbackState: any = null;
    const direct = await spotifyApiFetch("https://api.spotify.com/v1/me/player/devices");
    if (direct?.ok) {
      data = await direct.json().catch(() => null);
    }
    if (!data) {
      try {
        const proxyRes = await fetch("/api/spotify/me/player/devices", {
          cache: "no-store",
          credentials: "include",
        });
        if (proxyRes.ok) {
          data = await proxyRes.json().catch(() => null);
        }
      } catch {
        // ignore proxy fallback issues
      }
    }
    try {
      const playbackRes = await spotifyApiFetch("https://api.spotify.com/v1/me/player");
      if (playbackRes?.ok) {
        playbackState = await playbackRes.json().catch(() => null);
      }
    } catch {
      // ignore playback-state merge errors
    }

    setDevicesLoaded(true);
    if (!data && !playbackState?.device) {
      return;
    }
    const list = Array.isArray(data?.devices) ? data.devices : [];
    const mergedList = [...list];
    if (playbackState?.device) {
      mergedList.push({
        ...playbackState.device,
        is_active: true,
      });
    }
    const deduped = new Map<string, any>();
    let unavailableCounter = 0;
    for (const d of mergedList) {
      const key =
        typeof d?.id === "string" && d.id
          ? d.id
          : `unavailable:${String(d?.name ?? "Onbekend")}:${String(
              d?.type ?? "Unknown"
            )}:${unavailableCounter++}`;
      if (!deduped.has(key)) {
        deduped.set(key, d);
        continue;
      }
      const existing = deduped.get(key);
      if (existing && !existing.is_active && d?.is_active) {
        deduped.set(key, d);
      }
    }
    const currentSelectedId = activeDeviceIdRef.current;
    const sdkDeviceId = sdkDeviceIdRef.current;
    if (canUseSdk && sdkReadyRef.current && sdkDeviceId && !deduped.has(sdkDeviceId)) {
      deduped.set(sdkDeviceId, {
        id: sdkDeviceId,
        name: localWebplayerName,
        is_active: currentSelectedId === sdkDeviceId,
        type: localWebplayerType,
        is_restricted: false,
        supports_volume: true,
      });
    }
    const localNameLower = localWebplayerName.trim().toLowerCase();
    const localNameEntries = Array.from(deduped.entries()).filter(([, d]) => {
      return String(d?.name ?? "")
        .trim()
        .toLowerCase() === localNameLower;
    });
    if (localNameEntries.length > 1) {
      const preferredKey =
        (sdkDeviceId && deduped.has(sdkDeviceId)
          ? sdkDeviceId
          : localNameEntries.find(([, d]) => Boolean(d?.is_active))?.[0]) ??
        localNameEntries[0][0];
      for (const [key] of localNameEntries) {
        if (key !== preferredKey) {
          deduped.delete(key);
        }
      }
    }
    const mapped = Array.from(deduped.entries()).map(([key, d]: [string, any]) => {
      const id = typeof d?.id === "string" && d.id ? d.id : key;
      const isLocalSdkDevice = Boolean(sdkDeviceIdRef.current && id === sdkDeviceIdRef.current);
      return {
        id,
        name: d?.name ?? "Onbekend apparaat",
        isActive: Boolean(d.is_active),
        type: isLocalSdkDevice ? localWebplayerType : d?.type ?? "Unknown",
        isRestricted: Boolean(d.is_restricted),
        supportsVolume: d.supports_volume !== false,
        selectable: Boolean(d?.id),
        unavailableReason:
          typeof d?.id === "string" && d.id
            ? null
            : "Open Spotify op dit apparaat en start een track zodat het als Connect-device beschikbaar wordt.",
      };
    });
    setDevices(mapped);
    const selectableById = new Map(
      mapped
        .filter((device) => device.selectable)
        .map((device) => [device.id, device])
    );
    const selectedDevice = activeDeviceIdRef.current
      ? selectableById.get(activeDeviceIdRef.current)
      : null;
    const sdkDevice = sdkDeviceIdRef.current
      ? selectableById.get(sdkDeviceIdRef.current)
      : null;
    const active = mapped.find((device) => device.isActive && device.selectable);
    const selectionHeld =
      Date.now() - lastDeviceSelectRef.current < DEVICE_SELECTION_HOLD_MS;
    if (sdkDevice?.id && canUseSdk && preferSdkDeviceRef.current) {
      setActiveDevice(sdkDevice.id, sdkDevice.name ?? localWebplayerName);
      setActiveDeviceRestricted(Boolean(sdkDevice.isRestricted));
      setActiveDeviceSupportsVolume(sdkDevice.supportsVolume !== false);
    } else if (
      selectedDevice?.id &&
      (selectionHeld || !active?.id || active.id === selectedDevice.id)
    ) {
      setActiveDevice(selectedDevice.id, selectedDevice.name ?? null);
      setActiveDeviceRestricted(Boolean(selectedDevice.isRestricted));
      setActiveDeviceSupportsVolume(selectedDevice.supportsVolume !== false);
    } else if (active?.id) {
      lastConfirmedActiveDeviceRef.current = { id: active.id, at: Date.now() };
      setActiveDevice(active.id, active.name ?? null);
      setActiveDeviceRestricted(Boolean(active.isRestricted));
      setActiveDeviceSupportsVolume(active.supportsVolume !== false);
    } else if (sdkDevice?.id && canUseSdk && !activeDeviceIdRef.current) {
      setActiveDevice(sdkDevice.id, sdkDevice.name ?? localWebplayerName);
      setActiveDeviceRestricted(Boolean(sdkDevice.isRestricted));
      setActiveDeviceSupportsVolume(sdkDevice.supportsVolume !== false);
    }
  }, [canUseSdk, localWebplayerName, localWebplayerType, setActiveDevice, spotifyApiFetch]);

  const startLocalWebPlayerFromConnect = useCallback(() => {
    preferSdkDeviceRef.current = true;
    setSdkLifecycle("connecting");
    void kickstartLocalPlayer();
    refreshDevices(true);
    window.setTimeout(() => refreshDevices(true), 900);
    window.setTimeout(() => refreshDevices(true), 2200);
  }, [kickstartLocalPlayer, refreshDevices]);

  useEffect(() => {
    if (!canUseSdk || !accessToken) return;
    if (sdkReadyRef.current || playerRef.current) return;
    if (autoBootAttemptedRef.current) return;
    autoBootAttemptedRef.current = true;
    startLocalWebPlayerFromConnect();
  }, [accessToken, canUseSdk, startLocalWebPlayerFromConnect]);

  useEffect(() => {
    if (!canUseSdk) return;
    if (sdkReadyState) return;
    if (sdkLifecycle !== "connecting") return;
    if (sdkLastError) return;
    const timer = window.setTimeout(() => {
      if (sdkReadyRef.current) return;
      const ua = navigator.userAgent.toLowerCase();
      const isIOS = /iphone|ipad|ipod/.test(ua);
      if (isIOS) {
        setSdkLastError(
          "Webplayer wacht op iOS user gesture. Tik op Play en probeer opnieuw."
        );
      } else {
        setSdkLastError(
          "Webplayer kon niet ready worden. Controleer Premium, scopes en actieve Spotify-sessie."
        );
      }
      setSdkLifecycle("error");
    }, 12000);
    return () => window.clearTimeout(timer);
  }, [canUseSdk, sdkLifecycle, sdkLastError, sdkReadyState]);

  useEffect(() => {
    if (!accessToken) return;
    const interval = setInterval(() => {
      refreshDevices();
    }, 10000);
    return () => clearInterval(interval);
  }, [accessToken, refreshDevices]);

  useEffect(() => {
    if (!canUseSdk) return;
    let cancelled = false;

    const reconnect = async () => {
      if (cancelled) return;
      if (
        canUseSdk &&
        !playerRef.current &&
        typeof window !== "undefined" &&
        window.Spotify &&
        !readyRef.current
      ) {
        const cleanup = initializePlayer();
        if (typeof cleanup === "function") {
          playerCleanupRef.current = cleanup;
        }
      }
      const player = playerRef.current;
      if (player && !sdkReadyRef.current) {
        setSdkLifecycle((prev) => (prev === "error" ? prev : "connecting"));
        try {
          const connected = await player.connect?.();
          if (connected) {
            reconnectAttemptsRef.current = 0;
            setSdkLastError(null);
            refreshDevices(true);
          } else {
            reconnectAttemptsRef.current += 1;
          }
        } catch {
          reconnectAttemptsRef.current += 1;
        }
        if (reconnectAttemptsRef.current >= 6) {
          setSdkLastError("Lokale webplayer blijft offline. Gebruik ↻ of open Spotify app.");
          setSdkLifecycle("error");
        }
      } else {
        reconnectAttemptsRef.current = 0;
      }

      const delay = sdkReadyRef.current
        ? 12000
        : Math.min(15000, 1200 + reconnectAttemptsRef.current * 700);
      reconnectTimerRef.current = setTimeout(reconnect, delay);
    };

    reconnect();
    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseSdk, refreshDevices]);

  useEffect(() => {
    if (!canUseSdk) return;
    const onInteraction = () => {
      if (sdkReadyRef.current) return;
      void kickstartLocalPlayer();
    };
    window.addEventListener("pointerdown", onInteraction, { passive: true });
    window.addEventListener("keydown", onInteraction);
    return () => {
      window.removeEventListener("pointerdown", onInteraction);
      window.removeEventListener("keydown", onInteraction);
    };
  }, [canUseSdk, kickstartLocalPlayer]);

  useEffect(() => {
    if (!canUseSdk) {
      if (playerCleanupRef.current) {
        playerCleanupRef.current();
        playerCleanupRef.current = null;
      }
      onReady(null);
      readyRef.current = false;
      sdkReadyRef.current = false;
      autoBootAttemptedRef.current = false;
      setSdkReadyState(false);
      setSdkLastError(null);
      setSdkLifecycle("idle");
      playerRef.current = null;
      setCurrentTrackIdState(null);
      setCurrentTrackLiked(null);
      setDeviceReady(false);
      if (accessToken && !playbackAllowed) {
        setError("Ontbrekende Spotify‑rechten. Koppel opnieuw.");
      }
      return;
    }

    const mountLocalPlayer = () => {
      if (typeof window === "undefined" || !window.Spotify) return;
      if (playerRef.current) return;
      if (readyRef.current) return;
      setSdkLifecycle("connecting");
      const cleanup = initializePlayer();
      if (typeof cleanup === "function") {
        playerCleanupRef.current = cleanup;
      }
    };

    if (window.Spotify) {
      mountLocalPlayer();
      return () => {
        if (playerCleanupRef.current) {
          playerCleanupRef.current();
          playerCleanupRef.current = null;
        }
      };
    }

    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    setSdkLifecycle("loading");
    const onSdkReady = () => {
      mountLocalPlayer();
    };
    window.onSpotifyWebPlaybackSDKReady = onSdkReady;
    script.onload = () => {
      mountLocalPlayer();
    };
    script.onerror = () => {
      setSdkReadyState(false);
      setSdkLastError("Spotify Web Playback SDK laden mislukt.");
      setSdkLifecycle("error");
    };
    document.body.appendChild(script);

    return () => {
      if (window.onSpotifyWebPlaybackSDKReady === onSdkReady) {
        window.onSpotifyWebPlaybackSDKReady = undefined;
      }
      if (script.parentNode) script.parentNode.removeChild(script);
      if (playerCleanupRef.current) {
        playerCleanupRef.current();
        playerCleanupRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseSdk]);

  function initializePlayer() {
    const initialToken = accessTokenRef.current;
    if (!initialToken || readyRef.current) return;
    readyRef.current = true;
    setSdkLastError(null);
    setSdkReadyState(false);
    setSdkLifecycle("connecting");

    const player = new window.Spotify.Player({
      name: localWebplayerName,
      getOAuthToken: (cb: (token: string) => void) => {
        const token = accessTokenRef.current ?? initialToken;
        if (token) cb(token);
      },
      volume: 0.5,
    });

    const onSdkReady = async ({ device_id }: { device_id: string }) => {
      const shouldPreferSdk =
        preferSdkDeviceRef.current ||
        !activeDeviceIdRef.current ||
        activeDeviceIdRef.current === device_id;
      setDeviceId(device_id);
      deviceIdRef.current = device_id;
      sdkDeviceIdRef.current = device_id;
      sdkReadyRef.current = true;
      setSdkReadyState(true);
      setSdkLastError(null);
      setSdkLifecycle("ready");
      reconnectAttemptsRef.current = 0;
      lastSdkEventAtRef.current = Date.now();
      if (shouldPreferSdk) {
        preferSdkDeviceRef.current = true;
        // Default Spotify Connect selection to the web player on load.
        setActiveDevice(device_id, localWebplayerName);
        setActiveDeviceRestricted(false);
        setActiveDeviceSupportsVolume(true);
      }
      if (accessTokenRef.current) {
        let ready = true;
        if (shouldPreferSdk) {
          ready = await ensureActiveDevice(device_id, accessTokenRef.current, false);
          if (!ready) {
            await new Promise((resolve) => setTimeout(resolve, 700));
            ready = await ensureActiveDevice(device_id, accessTokenRef.current!, false);
          }
        }
        setDeviceReady(ready);
      } else {
        setDeviceReady(false);
      }
      refreshDevices(true);
      const token = accessTokenRef.current;
      if (token) {
        try {
          const res = await spotifyApiFetch("https://api.spotify.com/v1/me/player");
          if (res?.ok) {
            const data = await readJsonSafely(res);
            const device = data?.device;
            if (device?.id) {
              const shouldAdoptRemote =
                !preferSdkDeviceRef.current ||
                !sdkDeviceIdRef.current ||
                device.id === sdkDeviceIdRef.current;
              if (shouldAdoptRemote) {
                setActiveDevice(device.id, device.name ?? null);
                setActiveDeviceRestricted(Boolean(device.is_restricted));
                setActiveDeviceSupportsVolume(device.supports_volume !== false);
                lastConfirmedActiveDeviceRef.current = { id: device.id, at: Date.now() };
              }
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
              setCurrentTrackIdState(item.id ?? null);
              if (onTrackChange) onTrackChange(item.id ?? null);
            }
            if (typeof data?.shuffle_state === "boolean") {
              if (!(queueModeRef.current === "queue" && queueUrisRef.current?.length)) {
                setShuffleOn(data.shuffle_state);
                shuffleOnRef.current = data.shuffle_state;
                lastShuffleSyncRef.current = Date.now();
                rebuildQueueOrder(data.shuffle_state, false);
              }
            }
            if (typeof data?.repeat_state === "string") {
              const mode =
                data.repeat_state === "track"
                  ? "track"
                  : data.repeat_state === "context"
                  ? "context"
                  : "off";
              setRepeatMode(mode);
            }
          }
        } catch {
          // ignore
        }
      }
      if (!playbackRecoveryRef.current) {
        playbackRecoveryRef.current = true;
        try {
          const raw = window.localStorage.getItem("gs_last_playback");
          if (raw) {
            const stored = JSON.parse(raw) as {
              trackId?: string;
              positionMs?: number;
              deviceId?: string | null;
              updatedAt?: number;
            };
            if (stored?.trackId && stored.updatedAt && Date.now() - stored.updatedAt < 6 * 60_000) {
              const targetDevice = stored.deviceId || device_id;
              await ensureActiveDevice(targetDevice, accessTokenRef.current!, false);
              await spotifyApiFetch(
                withDeviceId("https://api.spotify.com/v1/me/player/play", targetDevice),
                {
                  method: "PUT",
                  body: JSON.stringify({
                    uris: [`spotify:track:${stored.trackId}`],
                    position_ms: Math.max(0, stored.positionMs ?? 0),
                  }),
                }
              );
            }
          }
        } catch {
          // ignore
        }
      }
      if (!shuffleInitDoneRef.current && accessTokenRef.current) {
        shuffleInitDoneRef.current = true;
        setShuffleOn(false);
        shuffleOnRef.current = false;
        rebuildQueueOrder(false, true);
        await setRemoteShuffleState(false, device_id, accessTokenRef.current, false).catch(
          () => undefined
        );
      }
    };

    const onNotReady = ({ device_id }: { device_id?: string } = {}) => {
      const knownSdkId = device_id || sdkDeviceIdRef.current;
      if (knownSdkId) {
        sdkDeviceIdRef.current = knownSdkId;
        setDeviceId(knownSdkId);
      } else {
        setDeviceId(null);
      }
      sdkReadyRef.current = false;
      setSdkReadyState(false);
      setSdkLifecycle("connecting");
      lastConfirmedActiveDeviceRef.current = null;
      setDeviceReady(false);
      refreshDevices(true);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectAttemptsRef.current = 0;
      reconnectTimerRef.current = setTimeout(() => {
        playerRef.current?.connect?.().catch?.(() => undefined);
      }, 800);
    };

    const onStateChanged = (state: any) => {
      applySdkState(state);
      if (state) {
        setSdkReadyState(true);
        setDeviceReady(true);
        setSdkLastError(null);
        setSdkLifecycle((prev) => (prev === "error" ? "ready" : prev));
      }
      if (state && !state.paused) {
        setError(null);
      }
    };

    const onInitError = ({ message }: { message: string }) => {
      setSdkReadyState(false);
      setSdkLastError(message);
      setSdkLifecycle("error");
      setError(message);
    };
    const onAuthError = async ({ message }: { message: string }) => {
      setSdkReadyState(false);
      setSdkLastError(message);
      setSdkLifecycle("connecting");
      const refreshed = await refreshClientAccessToken();
      if (!refreshed) {
        setSdkLifecycle("error");
        setError("Spotify-authenticatie verlopen. Koppel Spotify opnieuw.");
        return;
      }
      try {
        const connected = await playerRef.current?.connect?.();
        if (connected === false) {
          setSdkLifecycle("error");
          setError("Lokale webplayer kon niet opnieuw verbinden.");
          return;
        }
        setSdkLastError(null);
        setError(null);
      } catch {
        setSdkLifecycle("error");
        setError("Lokale webplayer kon niet opnieuw verbinden.");
      }
    };
    const onAccountError = ({ message }: { message: string }) => {
      setSdkReadyState(false);
      setSdkLastError(message || "Spotify Premium is vereist voor Web Playback.");
      setSdkLifecycle("error");
      setError(message || "Spotify Premium is vereist voor Web Playback.");
    };
    const onPlaybackError = ({ message }: { message: string }) => {
      setSdkLastError(message);
      setError(message);
      setSdkLifecycle("error");
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
    player.addListener("playback_error", onPlaybackError);
    player.addListener("autoplay_failed", onAutoplayFailed);

    player
      .connect()
      .then((connected: boolean) => {
        if (!connected) {
          setSdkReadyState(false);
          setSdkLastError("Lokale webplayer kon niet verbinden.");
          setSdkLifecycle("error");
        }
      })
      .catch(() => {
        setSdkReadyState(false);
        setSdkLastError("Lokale webplayer kon niet verbinden.");
        setSdkLifecycle("error");
      });
    playerRef.current = player;

    const raisePlaybackCommandError = (
      status: number | undefined,
      code: string,
      userMessage: string,
      retryAfterSec?: number
    ): never => {
      setError(userMessage);
      const error = new Error(
        typeof status === "number" ? `SPOTIFY_${status}_${code}` : `SPOTIFY_${code}`
      ) as Error & { status?: number; retryAfterSec?: number; userMessage?: string };
      if (typeof status === "number") {
        error.status = status;
      }
      if (typeof retryAfterSec === "number" && Number.isFinite(retryAfterSec)) {
        error.retryAfterSec = retryAfterSec;
      }
      error.userMessage = userMessage;
      throw error;
    };

    const api: PlayerApi = {
      primePlaybackGesture: () => {
        setPlaybackTouched(true);
        playerRef.current?.activateElement?.().catch?.(() => undefined);
        playerRef.current?.connect?.().catch?.(() => undefined);
      },
      playQueue: async (uris, offsetUri, offsetIndex) =>
        enqueuePlaybackCommand(async () => {
          const tokenValue = accessTokenRef.current;
          if (!tokenValue) {
            raisePlaybackCommandError(401, "MISSING_TOKEN", "Spotify-sessie verlopen. Log opnieuw in.");
          }
          const token = tokenValue!;
          let currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
          if (!playbackAllowed) {
            raisePlaybackCommandError(
              403,
              "MISSING_SCOPE",
              "Ontbrekende Spotify‑rechten. Koppel opnieuw."
            );
          }
          if (!currentDevice && sdkDeviceIdRef.current) {
            currentDevice = sdkDeviceIdRef.current;
            setActiveDevice(currentDevice, localWebplayerName);
          }
          if (!currentDevice) {
            raisePlaybackCommandError(
              404,
              "NO_ACTIVE_DEVICE",
              "Geen Spotify‑apparaat geselecteerd. Kies een apparaat om af te spelen."
            );
          }
          if (!Array.isArray(uris) || uris.length === 0) {
            return;
          }
          const hasIndex =
            typeof offsetIndex === "number" &&
            Number.isFinite(offsetIndex) &&
            offsetIndex >= 0 &&
            offsetIndex < uris.length;
          const resolvedIndex = hasIndex
            ? (offsetIndex as number)
            : offsetUri
            ? Math.max(0, uris.indexOf(offsetUri))
            : Math.max(0, getIndexFromTrackId(uris, pendingTrackIdRef.current));
          const resolvedUri = uris[resolvedIndex] ?? offsetUri ?? null;

          if (resolvedUri) {
            const id = resolvedUri.split(":").pop() || null;
            pendingTrackIdRef.current = id;
            trackChangeLockUntilRef.current = Date.now() + 2000;
            setPositionMs(0);
          }
          if (currentDevice === sdkDeviceIdRef.current) {
            await playerRef.current?.activateElement?.();
          }

          const payload = {
            uris,
            offset: resolvedUri ? { uri: resolvedUri } : undefined,
            position_ms: 0,
          };
          const startIndex = Math.max(0, Math.min(resolvedIndex, uris.length - 1));

          const ready = await ensureActiveDevice(currentDevice as string, token, true);
          if (!ready) {
            raisePlaybackCommandError(
              404,
              "DEVICE_NOT_READY",
              "Spotify‑apparaat is nog niet klaar. Probeer opnieuw."
            );
          }
          const shuffleReady = await setRemoteShuffleState(
            shuffleOnRef.current,
            currentDevice as string,
            token,
            false
          );
          if (!shuffleReady) {
            setError("Shuffle status kon niet worden toegepast op dit apparaat.");
          }

          const attemptPlay = async () => {
            return spotifyApiFetch(
              withDeviceId(
                "https://api.spotify.com/v1/me/player/play",
                currentDevice as string
              ),
              { method: "PUT", body: JSON.stringify(payload) }
            );
          };

          let res = await attemptPlay();
          if (res && !res.ok) {
            if (res.status === 404 || res.status >= 500) {
              refreshDevices(true);
              await new Promise((resolve) => setTimeout(resolve, 600));
              res = await attemptPlay();
            }
          }
          if (!res) {
            raisePlaybackCommandError(
              undefined,
              "PLAY_REQUEST_FAILED",
              "Spotify‑verbinding is instabiel. Probeer opnieuw."
            );
          }
          const playRes = res!;
          if (!playRes.ok && playRes.status !== 204) {
            if (playRes.status === 401) {
              raisePlaybackCommandError(401, "UNAUTHORIZED", "Spotify-sessie verlopen. Log opnieuw in.");
            }
            if (playRes.status === 403) {
              raisePlaybackCommandError(
                403,
                "FORBIDDEN",
                "Ontbrekende Spotify‑rechten. Koppel opnieuw."
              );
            }
            if (playRes.status === 404) {
              raisePlaybackCommandError(
                404,
                "NO_ACTIVE_DEVICE",
                "Geen actieve Spotify player gevonden."
              );
            }
            if (playRes.status === 429) {
              const retryAfter = Number(playRes.headers.get("Retry-After") ?? "1");
              raisePlaybackCommandError(
                429,
                "RATE_LIMITED",
                `Spotify is druk. Probeer opnieuw over ${Math.max(1, Math.round(retryAfter))}s.`,
                Number.isFinite(retryAfter) ? retryAfter : 1
              );
            }
            raisePlaybackCommandError(
              playRes.status,
              "PLAY_FAILED",
              "Afspelen lukt nu niet. Probeer opnieuw."
            );
          }
          if (playRes.ok) {
            queueModeRef.current = "queue";
            queueUrisRef.current = uris;
            queueIndexRef.current = startIndex;
            if (shuffleOnRef.current) {
              queueOrderRef.current = buildShuffleOrder(uris.length, startIndex);
              queuePosRef.current = queueOrderRef.current.indexOf(startIndex);
              if (queuePosRef.current < 0) queuePosRef.current = 0;
            } else {
              queueOrderRef.current = null;
              queuePosRef.current = startIndex;
            }
            setPositionMs(0);
            lastKnownPositionRef.current = 0;
            if (resolvedUri) {
              setTimeout(() => {
                spotifyApiFetch(
                  withDeviceId(
                    "https://api.spotify.com/v1/me/player/seek?position_ms=0",
                    currentDevice as string
                  ),
                  { method: "PUT" }
                ).catch(() => undefined);
              }, 200);
            }
            if (resolvedUri) {
              const id = resolvedUri.split(":").pop() || null;
              pendingTrackIdRef.current = id;
              trackChangeLockUntilRef.current = Date.now() + 3000;
            }
            setTimeout(() => {
              syncPlaybackState().catch(() => undefined);
            }, 280);
          }
        }),
      playContext: async (contextUri, offsetPosition, offsetUri) =>
        enqueuePlaybackCommand(async () => {
          const tokenValue = accessTokenRef.current;
          if (!tokenValue) {
            raisePlaybackCommandError(401, "MISSING_TOKEN", "Spotify-sessie verlopen. Log opnieuw in.");
          }
          const token = tokenValue!;
          let currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
          if (!playbackAllowed) {
            raisePlaybackCommandError(
              403,
              "MISSING_SCOPE",
              "Ontbrekende Spotify‑rechten. Koppel opnieuw."
            );
          }
          if (!currentDevice && sdkDeviceIdRef.current) {
            currentDevice = sdkDeviceIdRef.current;
            setActiveDevice(currentDevice, localWebplayerName);
          }
          if (!currentDevice) {
            raisePlaybackCommandError(
              404,
              "NO_ACTIVE_DEVICE",
              "Geen Spotify‑apparaat geselecteerd. Kies een apparaat om af te spelen."
            );
          }
          if (offsetUri) {
            const id = offsetUri.split(":").pop() || null;
            pendingTrackIdRef.current = id;
            trackChangeLockUntilRef.current = Date.now() + 2000;
            setPositionMs(0);
          }
          if (currentDevice === sdkDeviceIdRef.current) {
            await playerRef.current?.activateElement?.();
          }

          const ready = await ensureActiveDevice(currentDevice as string, token, true);
          if (!ready) {
            raisePlaybackCommandError(
              404,
              "DEVICE_NOT_READY",
              "Spotify‑apparaat is nog niet klaar. Probeer opnieuw."
            );
          }

          const body = {
            context_uri: contextUri,
            offset:
              typeof offsetPosition === "number"
                ? { position: Math.max(0, offsetPosition) }
                : offsetUri
                ? { uri: offsetUri }
                : undefined,
            position_ms: 0,
          };

          const res = await spotifyApiFetch(
            withDeviceId(
              "https://api.spotify.com/v1/me/player/play",
              currentDevice as string
            ),
            { method: "PUT", body: JSON.stringify(body) }
          );
          if (!res) {
            raisePlaybackCommandError(
              undefined,
              "PLAY_REQUEST_FAILED",
              "Spotify‑verbinding is instabiel. Probeer opnieuw."
            );
          }
          const contextRes = res!;
          if (!contextRes.ok && contextRes.status !== 204) {
            if (contextRes.status === 401) {
              raisePlaybackCommandError(401, "UNAUTHORIZED", "Spotify-sessie verlopen. Log opnieuw in.");
            }
            if (contextRes.status === 403) {
              raisePlaybackCommandError(
                403,
                "FORBIDDEN",
                "Ontbrekende Spotify‑rechten. Koppel opnieuw."
              );
            }
            if (contextRes.status === 404) {
              raisePlaybackCommandError(
                404,
                "NO_ACTIVE_DEVICE",
                "Geen actieve Spotify player gevonden."
              );
            }
            if (contextRes.status === 429) {
              const retryAfter = Number(contextRes.headers.get("Retry-After") ?? "1");
              raisePlaybackCommandError(
                429,
                "RATE_LIMITED",
                `Spotify is druk. Probeer opnieuw over ${Math.max(1, Math.round(retryAfter))}s.`,
                Number.isFinite(retryAfter) ? retryAfter : 1
              );
            }
            raisePlaybackCommandError(
              contextRes.status,
              "PLAY_FAILED",
              "Afspelen lukt nu niet. Probeer opnieuw."
            );
          }
          if (contextRes.ok) {
            queueModeRef.current = "context";
            queueUrisRef.current = null;
            queueOrderRef.current = null;
            queuePosRef.current = 0;
            setPositionMs(0);
            lastKnownPositionRef.current = 0;
            setTimeout(() => {
              spotifyApiFetch(
                withDeviceId(
                  "https://api.spotify.com/v1/me/player/seek?position_ms=0",
                  currentDevice as string
                ),
                { method: "PUT" }
              ).catch(() => undefined);
            }, 200);
            if (offsetUri) {
              const id = offsetUri.split(":").pop() || null;
              pendingTrackIdRef.current = id;
              trackChangeLockUntilRef.current = Date.now() + 3000;
            }
            setTimeout(() => {
              syncPlaybackState().catch(() => undefined);
            }, 280);
          }
          const shuffleReady = await setRemoteShuffleState(
            shuffleOnRef.current,
            currentDevice as string,
            token,
            false
          );
          if (!shuffleReady) {
            setError("Shuffle status kon niet worden toegepast op dit apparaat.");
          }
        }),
      togglePlay: async () =>
        handleTogglePlay(),
      next: async () => handleNext(),
      previous: async () => handlePrevious(),
    };

    onReady(api);

    return () => {
      player.removeListener("ready", onSdkReady);
      player.removeListener("not_ready", onNotReady);
      player.removeListener("player_state_changed", onStateChanged);
      player.removeListener("initialization_error", onInitError);
      player.removeListener("authentication_error", onAuthError);
      player.removeListener("account_error", onAccountError);
      player.removeListener("playback_error", onPlaybackError);
      player.removeListener("autoplay_failed", onAutoplayFailed);
      player.disconnect();
      playerRef.current = null;
      readyRef.current = false;
      sdkReadyRef.current = false;
      setSdkReadyState(false);
      setSdkLifecycle("idle");
      setDeviceReady(false);
      onReady(null);
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
    function handleFocusOrResume() {
      refreshDevices();
      syncPlaybackState().catch(() => undefined);
    }
    function handleVisibility() {
      if (document.visibilityState !== "visible") return;
      handleFocusOrResume();
    }
    if (typeof window === "undefined") return;
    window.addEventListener("focus", handleFocusOrResume);
    window.addEventListener("pageshow", handleFocusOrResume);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocusOrResume);
      window.removeEventListener("pageshow", handleFocusOrResume);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refreshDevices, syncPlaybackState]);

  useEffect(() => {
    if (queueOpen) {
      fetchQueue().catch(() => undefined);
    }
  }, [queueOpen, fetchQueue]);

  useEffect(() => {
    const now = Date.now();
    if (!canUseSdk) {
      setDeviceMissing(false);
      return;
    }
    if (!devicesLoaded) {
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
  }, [activeDeviceId, deviceId, devices, canUseSdk, devicesLoaded]);

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
      return spotifyApiFetch(url, options);
    }

    async function poll() {
      try {
        const token = accessTokenRef.current;
        if (!token || cancelled) return;
        const now = Date.now();
        const activeDevice = activeDeviceIdRef.current;
        const sdkDevice = sdkDeviceIdRef.current;
        const sdkStatePrimary =
          sdkReadyRef.current &&
          Boolean(sdkDevice) &&
          (!activeDevice || activeDevice === sdkDevice);
        if (sdkStatePrimary && now - lastSdkEventAtRef.current < 20000) {
          const isPlaying = !playerStateRef.current?.paused;
          scheduleNext(isPlaying, isPlaying ? 12000 : 15000);
          return;
        }
        const res = await spotifyRequest("https://api.spotify.com/v1/me/player");
        if (!res) {
          scheduleNext();
          return;
        }
        const data = await readJsonSafely(res);
        if (!data || cancelled) {
          scheduleNext();
          return;
        }
        const device = data.device;
        if (shouldAdoptRemoteDevice(device?.id ?? null)) {
          setActiveDevice(device.id, device.name ?? null);
          setActiveDeviceRestricted(Boolean(device.is_restricted));
          setActiveDeviceSupportsVolume(device.supports_volume !== false);
          lastConfirmedActiveDeviceRef.current = { id: device.id, at: Date.now() };
          if (device.id === pendingDeviceIdRef.current) {
            pendingDeviceIdRef.current = null;
          }
          if (
            sdkDeviceIdRef.current &&
            device.id !== sdkDeviceIdRef.current &&
            playerRef.current
          ) {
            playerRef.current.pause().catch(() => undefined);
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
          setCurrentTrackIdState(item.id ?? null);
          if (onTrackChange) onTrackChange(item.id ?? null);
          syncQueuePositionFromTrack(trackId);
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
          if (!(queueModeRef.current === "queue" && queueUrisRef.current?.length)) {
            setShuffleOn(data.shuffle_state);
            shuffleOnRef.current = data.shuffle_state;
            lastShuffleSyncRef.current = Date.now();
            rebuildQueueOrder(data.shuffle_state, false);
          }
        }
        if (typeof data?.repeat_state === "string") {
          const mode =
            data.repeat_state === "track"
              ? "track"
              : data.repeat_state === "context"
              ? "context"
              : "off";
          setRepeatMode(mode);
        }
        if (typeof data?.is_playing === "boolean") {
          lastIsPlayingRef.current = data.is_playing;
        }
        setError(null);
        scheduleNext(data?.is_playing);
      } catch {
        if (!cancelled) {
          scheduleNext();
        }
      }
    }

    function scheduleNext(isPlaying?: boolean, overrideDelay?: number) {
      if (cancelled) return;
      const baseDelay = isPlaying ? 3500 : 8000;
      const base = overrideDelay ?? baseDelay;
      const waitExtra = Math.max(rateLimitRef.current.until - Date.now(), 0);
      const delay = Math.min(base + waitExtra, 15000);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = setTimeout(poll, delay);
    }

    poll();
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [
    accessToken,
    onTrackChange,
    rebuildQueueOrder,
    setActiveDevice,
    shouldAdoptRemoteDevice,
    spotifyApiFetch,
    syncQueuePositionFromTrack,
  ]);

  async function handleDeviceChange(targetId: string) {
    const token = accessTokenRef.current;
    if (!token || !targetId) return;
    const targetDevice = devices.find((device) => device.id === targetId);
    if (!targetDevice?.selectable) {
      setError(
        targetDevice?.unavailableReason ||
          "Dit apparaat is nog niet beschikbaar. Open Spotify op het apparaat en probeer opnieuw."
      );
      return;
    }
    if (Date.now() < rateLimitRef.current.until) return;
    preferSdkDeviceRef.current = targetId === sdkDeviceIdRef.current;
    if (targetId === sdkDeviceIdRef.current) {
      try {
        await playerRef.current?.activateElement?.();
      } catch {
        // ignore activation failure; selection can still proceed
      }
    }
    const deviceName = targetDevice?.name ?? devices.find((d) => d.id === targetId)?.name;
    setActiveDevice(targetId, deviceName ?? null);
    pendingDeviceIdRef.current = targetId;
    lastDeviceSelectRef.current = Date.now();
    lastConfirmedActiveDeviceRef.current = null;
    setDeviceReady(false);
    setDeviceId(targetId);
    deviceIdRef.current = targetId;
    const shouldPlay = lastIsPlayingRef.current;
    await enqueuePlaybackCommand(async () => {
      const ready = await ensureActiveDevice(targetId, token, shouldPlay);
      if (ready) {
        lastConfirmedActiveDeviceRef.current = { id: targetId, at: Date.now() };
      } else if (pendingDeviceIdRef.current === targetId) {
        pendingDeviceIdRef.current = null;
      }
      if (ready) {
        const shuffleReady = await setRemoteShuffleState(
          shuffleOnRef.current,
          targetId,
          token,
          false
        );
        if (!shuffleReady) {
          setError("Shuffle status kon niet worden toegepast op dit apparaat.");
        }
      }
      refreshDevices(true);
      setTimeout(() => refreshDevices(true), 800);
    });
    clearPendingDeviceIfStale();
  }

  async function handleTogglePlay() {
    setPlaybackTouched(true);
    if (isCustomQueueActive && !isCurrentTrackFromCustomQueue) {
      const targetQueueId =
        customQueue.currentQueueId ?? customQueue.items[0]?.queueId ?? null;
      if (targetQueueId) {
        customQueue.setCurrentQueueId(targetQueueId);
        await customQueuePlayback.playFromQueue(targetQueueId);
        return;
      }
    }
    const token = accessTokenRef.current;
    const currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
    if (!token || !currentDevice) {
      await playerRef.current?.togglePlay?.();
      return;
    }
    if (Date.now() < rateLimitRef.current.until) return;
    await enqueuePlaybackCommand(async () => {
      if (currentDevice === sdkDeviceIdRef.current) {
        await playerRef.current?.activateElement?.();
        await playerRef.current?.togglePlay?.();
        setTimeout(() => {
          syncPlaybackState().catch(() => undefined);
        }, 220);
        return;
      }
      const ready = await ensureActiveDevice(
        currentDevice,
        token,
        !playerState?.paused
      );
      if (!ready) {
        setError("Spotify‑apparaat is nog niet klaar. Probeer opnieuw.");
        return;
      }
      const endpoint = playerState?.paused ? "play" : "pause";
      await spotifyApiFetch(
        withDeviceId(
          `https://api.spotify.com/v1/me/player/${endpoint}`,
          currentDevice
        ),
        { method: "PUT" }
      );
      setTimeout(() => {
        syncPlaybackState().catch(() => undefined);
      }, 220);
    });
  }

  async function handleNext() {
    setPlaybackTouched(true);
    if (isCustomQueueActive) {
      await customQueuePlayback.playNextFromQueue();
      return;
    }
    const token = accessTokenRef.current;
    const currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
    if (!token || !currentDevice) return;
    if (Date.now() < rateLimitRef.current.until) return;
    await enqueuePlaybackCommand(async () => {
      if (
        currentDevice === sdkDeviceIdRef.current &&
        queueModeRef.current !== "queue"
      ) {
        await playerRef.current?.nextTrack?.();
        setTimeout(() => {
          syncPlaybackState().catch(() => undefined);
        }, 220);
        return;
      }
      if (queueModeRef.current === "queue" && queueUrisRef.current?.length) {
        const ready = await ensureActiveDevice(currentDevice, token, true);
        if (!ready) {
          setError("Spotify‑apparaat is nog niet klaar. Probeer opnieuw.");
          return;
        }
        const uris = queueUrisRef.current;
        if (shuffleOnRef.current && queueOrderRef.current?.length) {
          if (queuePosRef.current >= queueOrderRef.current.length - 1) return;
          queuePosRef.current += 1;
          const nextIndex = queueOrderRef.current[queuePosRef.current];
          queueIndexRef.current = nextIndex;
          await playUrisAtIndex(uris, nextIndex, currentDevice, token);
        } else {
          const nextIndex = Math.min(queueIndexRef.current + 1, uris.length - 1);
          queueIndexRef.current = nextIndex;
          await playUrisAtIndex(uris, nextIndex, currentDevice, token);
        }
        return;
      }
      const ready = await ensureActiveDevice(currentDevice, token, true);
      if (!ready) {
        setError("Spotify‑apparaat is nog niet klaar. Probeer opnieuw.");
        return;
      }
      await spotifyApiFetch(
        withDeviceId("https://api.spotify.com/v1/me/player/next", currentDevice),
        { method: "POST" }
      );
      pendingTrackIdRef.current = null;
      setTimeout(() => {
        syncPlaybackState().catch(() => undefined);
      }, 220);
    });
  }

  async function handlePrevious() {
    setPlaybackTouched(true);
    if (isCustomQueueActive) {
      await customQueuePlayback.playPreviousFromQueue();
      return;
    }
    const token = accessTokenRef.current;
    const currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
    if (!token || !currentDevice) return;
    if (Date.now() < rateLimitRef.current.until) return;
    await enqueuePlaybackCommand(async () => {
      if (
        currentDevice === sdkDeviceIdRef.current &&
        queueModeRef.current !== "queue"
      ) {
        await playerRef.current?.previousTrack?.();
        setTimeout(() => {
          syncPlaybackState().catch(() => undefined);
        }, 220);
        return;
      }
      if (queueModeRef.current === "queue" && queueUrisRef.current?.length) {
        const ready = await ensureActiveDevice(currentDevice, token, true);
        if (!ready) {
          setError("Spotify‑apparaat is nog niet klaar. Probeer opnieuw.");
          return;
        }
        const uris = queueUrisRef.current;
        if (shuffleOnRef.current && queueOrderRef.current?.length) {
          if (queuePosRef.current <= 0) return;
          queuePosRef.current -= 1;
          const prevIndex = queueOrderRef.current[queuePosRef.current];
          queueIndexRef.current = prevIndex;
          await playUrisAtIndex(uris, prevIndex, currentDevice, token);
        } else {
          const prevIndex = Math.max(queueIndexRef.current - 1, 0);
          queueIndexRef.current = prevIndex;
          await playUrisAtIndex(uris, prevIndex, currentDevice, token);
        }
        return;
      }
      const ready = await ensureActiveDevice(currentDevice, token, true);
      if (!ready) {
        setError("Spotify‑apparaat is nog niet klaar. Probeer opnieuw.");
        return;
      }
      await spotifyApiFetch(
        withDeviceId("https://api.spotify.com/v1/me/player/previous", currentDevice),
        { method: "POST" }
      );
      setTimeout(() => {
        syncPlaybackState().catch(() => undefined);
      }, 220);
    });
  }

  async function handleToggleShuffle() {
    setPlaybackTouched(true);
    const token = accessTokenRef.current;
    const currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
    if (!token || !currentDevice || shufflePendingRef.current) return;
    if (Date.now() < rateLimitRef.current.until) return;
    const next = !shuffleOnRef.current;
    shufflePendingRef.current = true;
    setShufflePending(true);
    setShuffleOn(next);
    shuffleOnRef.current = next;
    lastShuffleSyncRef.current = Date.now();
    rebuildQueueOrder(next, next);

    await enqueuePlaybackCommand(async () => {
      try {
        const applied = await setRemoteShuffleState(next, currentDevice, token);
        if (!applied) {
          // Keep local shuffle behavior deterministic for queue-mode, even if remote sync fails.
          setError("Shuffle op Spotify Connect kon niet direct bevestigd worden.");
        } else {
          setError(null);
        }
      } finally {
        shufflePendingRef.current = false;
        setShufflePending(false);
      }
    });
  }

  async function handleToggleRepeat() {
    setPlaybackTouched(true);
    const token = accessTokenRef.current;
    const currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
    if (!token || !currentDevice) return;
    if (Date.now() < rateLimitRef.current.until) return;
    const next =
      repeatMode === "off" ? "context" : repeatMode === "context" ? "track" : "off";
    await enqueuePlaybackCommand(async () => {
      const ready = await ensureActiveDevice(currentDevice, token, false);
      if (!ready) {
        setError("Spotify‑apparaat is nog niet klaar. Probeer opnieuw.");
        return;
      }
      const res = await spotifyApiFetch(
        withDeviceId(
          `https://api.spotify.com/v1/me/player/repeat?state=${next}`,
          currentDevice
        ),
        { method: "PUT" }
      );
      if (res?.ok) {
        setRepeatMode(next);
      }
    });
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
    const fallbackDevice =
      activeDeviceIdRef.current || deviceIdRef.current || sdkDeviceIdRef.current;
    if (!token || !fallbackDevice) {
      isScrubbingRef.current = false;
      return;
    }
    if (Date.now() < rateLimitRef.current.until) {
      isScrubbingRef.current = false;
      return;
    }
    const targetMs = Math.max(0, Math.floor(nextMs));
    setPositionMs(targetMs);
    lastUserSeekAtRef.current = Date.now();
    if (seekTimerRef.current) clearTimeout(seekTimerRef.current);
    seekTimerRef.current = setTimeout(async () => {
      isScrubbingRef.current = false;
      await enqueuePlaybackCommand(async () => {
        const currentDevice =
          activeDeviceIdRef.current || deviceIdRef.current || fallbackDevice;
        if (!currentDevice) return;
        if (currentDevice === sdkDeviceIdRef.current) {
          await playerRef.current?.seek?.(targetMs);
          setTimeout(() => {
            syncPlaybackState().catch(() => undefined);
          }, 180);
          return;
        }
        const ready = await ensureActiveDevice(currentDevice, token, false);
        if (!ready) {
          setError("Spotify‑apparaat is nog niet klaar. Probeer opnieuw.");
          return;
        }
        await spotifyApiFetch(
          withDeviceId(
            `https://api.spotify.com/v1/me/player/seek?position_ms=${Math.floor(
              targetMs
            )}`,
            currentDevice
          ),
          { method: "PUT" }
        );
        setTimeout(() => {
          syncPlaybackState().catch(() => undefined);
        }, 180);
      });
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
        await enqueuePlaybackCommand(async () => {
          const volumeDevice = activeDeviceIdRef.current;
          if (!volumeDevice) return;
          await spotifyApiFetch(
            withDeviceId(
              `https://api.spotify.com/v1/me/player/volume?volume_percent=${Math.round(
                clamped * 100
              )}`,
              volumeDevice
            ),
            { method: "PUT" }
          );
        });
      }, 120);
      return;
    }
    if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
    volumeTimerRef.current = setTimeout(async () => {
      await enqueuePlaybackCommand(async () => {
        await playerRef.current?.setVolume?.(clamped);
      });
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
    if (!token) return false;
    if (Date.now() < rateLimitRef.current.until) return false;
    const waits = [0, 250, 600];

    const attemptTransfer = async (playFlag: boolean) => {
      for (let i = 0; i < waits.length; i += 1) {
        if (waits[i] > 0) {
          await new Promise((resolve) => setTimeout(resolve, waits[i]));
        }

        try {
          const proxyRes = await fetch("/api/spotify/me/player", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ device_ids: [id], play: playFlag }),
          });
          if (proxyRes.ok) return true;
          if (proxyRes.status === 401 || proxyRes.status === 403) return false;
        } catch {
          // fall back to direct call
        }

        const directRes = await spotifyApiFetch("https://api.spotify.com/v1/me/player", {
          method: "PUT",
          body: JSON.stringify({ device_ids: [id], play: playFlag }),
        });
        if (directRes?.ok) return true;
        if (directRes && (directRes.status === 401 || directRes.status === 403)) return false;
      }
      return false;
    };

    const primary = await attemptTransfer(play);
    if (primary) return true;

    // iOS/Web autoplay can block transfer-with-play; retry transfer only.
    if (play) {
      return await attemptTransfer(false);
    }
    return primary;
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
              {missingPlaybackScopes.length ? (
                <span> Ontbrekend: {missingPlaybackScopes.join(", ")}.</span>
              ) : null}
            </div>
          ) : null}
          {playbackAllowed && !sdkSupported && sdkSupport.reason ? (
            <div className="text-subtle">{sdkSupport.reason}</div>
          ) : null}
          {premiumRequired ? (
            <div className="text-subtle">
              Spotify Premium is vereist voor Web Playback.
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
        <div className="player-title-row">
          <div className="player-title">
            {optimisticTrack?.name ||
              playerState?.name ||
              (activeDeviceName ? `Afspelen op ${activeDeviceName}` : "Ready to play")}
          </div>
          {accessToken && currentTrackIdState ? (
            <button
              type="button"
              className={`player-like-btn${currentTrackLiked ? " active" : ""}`}
              aria-label={
                currentTrackLiked
                  ? "Verwijderen uit Liked Songs"
                  : "Toevoegen aan Liked Songs"
              }
              title={
                currentTrackLiked
                  ? "Verwijderen uit Liked Songs"
                  : "Toevoegen aan Liked Songs"
              }
              disabled={likedStateSaving || likedStateLoading}
              onClick={handleLikeCurrentTrack}
            >
              {likedStateSaving ? "…" : currentTrackLiked ? "−" : "+"}
            </button>
          ) : null}
        </div>
        <div className="text-body">
          {optimisticTrack?.artists ||
            playerState?.artists ||
            (activeDeviceName
              ? "Selecteer een track in Spotify"
              : "Select a track to start playback")}
        </div>
        {optimisticTrack?.album || playerState?.album ? (
          <div className="text-subtle">
            {optimisticTrack?.album || playerState?.album}
          </div>
        ) : null}
        {playerErrorMessage &&
        playbackTouched &&
        !(playerState && !playerState.paused) &&
        !optimisticTrack?.name &&
        !playerState?.name &&
        !activeDeviceName &&
        !deviceId &&
        !deviceMissing ? (
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
        {isCustomQueueActive && !isQueuePage ? (
          <div className="text-subtle">
            Custom queue actief. Bedien play/vorige/volgende vanuit de player.
          </div>
        ) : null}
        </div>
        <div className="player-controls">
          <div
            className={`player-control player-control-ghost player-control-grad shuffle-btn${
              shuffleOn ? " active" : ""
            }${shufflePending ? " pending" : ""}`}
            role="button"
            tabIndex={shufflePending ? -1 : 0}
            aria-disabled={shufflePending}
            aria-busy={shufflePending}
            aria-label={shuffleOn ? "Shuffle uit" : "Shuffle aan"}
            title={shuffleOn ? "Shuffle uit" : "Shuffle aan"}
            onClick={() => {
              if (!shufflePending) handleToggleShuffle();
            }}
            onKeyDown={(event) => {
              if (shufflePending) return;
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
          <div
            className={`player-control player-control-ghost player-control-grad${
              queueOpen || isCustomQueueActive ? " active" : ""
            }`}
            role="button"
            tabIndex={0}
            aria-label="Queue"
            title="Queue"
            onClick={() => setQueueOpen((prev) => !prev)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setQueueOpen((prev) => !prev);
              }
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M2.5 3h8a.5.5 0 0 1 0 1h-8a.5.5 0 0 1 0-1zm0 5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1 0-1zm0 5h6a.5.5 0 0 1 0 1h-6a.5.5 0 0 1 0-1z" />
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
            onChange={(event) => {
              const next = Number(event.target.value);
              isScrubbingRef.current = true;
              setPositionMs(next);
              void handleSeek(next);
            }}
            className="player-slider"
            style={{
              background: `linear-gradient(90deg, #1db954 ${Math.min(
                100,
                Math.max(
                  0,
                  durationMs ? (positionMs / durationMs) * 100 : 0
                )
              )}%, rgba(2, 154, 228, 0.2) ${Math.min(
                100,
                Math.max(
                  0,
                  durationMs ? (positionMs / durationMs) * 100 : 0
                )
              )}%)`,
            }}
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
          {sdkSupported && !sdkReadyState ? (
            <button
              type="button"
              className="detail-btn"
              aria-label="Start lokale webplayer"
              title="Start lokale webplayer"
              onClick={startLocalWebPlayerFromConnect}
            >
              ▶
            </button>
          ) : null}
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
          <div
            className="combo"
            style={{ width: "100%" }}
            ref={deviceMenu.rootRef}
            onPointerDownCapture={deviceMenu.markInteraction}
            onTouchStartCapture={deviceMenu.markInteraction}
          >
            <button
              type="button"
              className="combo-input"
              onClick={() => {
                setDeviceMenuOpen((prev) => {
                  const next = !prev;
                  if (next) {
                    refreshDevices(true);
                    if (sdkSupported && !sdkReadyState) {
                      startLocalWebPlayerFromConnect();
                    }
                  }
                  return next;
                });
              }}
              onBlur={deviceMenu.handleBlur}
              aria-label="Kies een Spotify‑apparaat"
              aria-haspopup="listbox"
              aria-expanded={deviceMenuOpen}
            >
              {devices.find((d) => d.id === (activeDeviceId || deviceId))?.name ||
                "Kies apparaat"}
            </button>
            {deviceMenuOpen ? (
              <div className="combo-list" role="listbox">
                {sdkSupported && !sdkReadyState ? (
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="combo-item"
                    onClick={() => {
                      startLocalWebPlayerFromConnect();
                      setDeviceMenuOpen(false);
                    }}
                  >
                    {localWebplayerName} <span className="text-subtle">(start lokaal)</span>
                  </button>
                ) : null}
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
                      disabled={!device.selectable}
                      onClick={() => {
                        handleDeviceChange(device.id);
                        setDeviceMenuOpen(false);
                      }}
                    >
                      {device.name}{" "}
                      <span className="text-subtle">
                        ({device.type}
                        {!device.selectable ? " • niet beschikbaar" : ""})
                      </span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>
        </div>
        {sdkSupported &&
        !sdkReadyState &&
        (!activeDeviceId || activeDeviceId === sdkDeviceIdRef.current) ? (
          <div className="text-subtle" style={{ marginTop: 6 }}>
            Lokale webplayer wordt automatisch verbonden ({sdkLifecycle}).
            {sdkLastError ? ` Laatste melding: ${sdkLastError}` : ""}
          </div>
        ) : null}
        {!sdkSupported ? (
          <div className="text-subtle" style={{ marginTop: 6 }}>
            {sdkSupport.reason}
          </div>
        ) : null}
        {selectableDevicesCount === 0 ? (
          <div className="text-subtle" style={{ marginTop: 6 }}>
            Geen selecteerbare apparaten gevonden. Open Spotify op je iPhone/iPad en start een track, daarna klik je op ↻.
            <button
              type="button"
              className="btn btn-ghost"
              style={{ marginLeft: 8 }}
              onClick={() => {
                try {
                  window.location.href = "spotify://";
                } catch {
                  // ignore deep-link failures
                }
                window.setTimeout(() => {
                  refreshDevices(true);
                }, 1200);
                window.setTimeout(() => {
                  refreshDevices(true);
                }, 2600);
                window.setTimeout(() => {
                  refreshDevices(true);
                }, 4200);
              }}
            >
              Open Spotify app
            </button>
          </div>
        ) : null}
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
            style={{
              background: `linear-gradient(90deg, #1db954 ${Math.round(
                Math.min(1, Math.max(0, volume)) * 100
              )}%, rgba(2, 154, 228, 0.2) ${Math.round(
                Math.min(1, Math.max(0, volume)) * 100
              )}%)`,
            }}
            aria-label="Volume"
            disabled={!activeDeviceSupportsVolume}
          />
        </div>
      </div>
      {queueOpen ? (
        <div className="player-queue">
          <div className="player-queue-title">Up Next</div>
          {queueLoading ? (
            <div className="text-subtle">Queue laden...</div>
          ) : queueError ? (
            <div className="text-subtle">{queueError}</div>
          ) : queueItems.length === 0 ? (
            <div className="text-subtle">Geen volgende nummers.</div>
          ) : (
            <div className="player-queue-list">
              {queueItems.slice(0, 10).map((track) => (
                <div key={track.id} className="player-queue-item">
                  {track.coverUrl ? (
                    <Image
                      src={track.coverUrl}
                      alt={track.name}
                      width={40}
                      height={40}
                      unoptimized
                    />
                  ) : (
                    <div className="player-queue-cover" />
                  )}
                  <div>
                    <div className="player-queue-name">{track.name}</div>
                    <div className="text-subtle">{track.artists}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
