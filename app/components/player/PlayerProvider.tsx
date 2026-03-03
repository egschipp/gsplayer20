"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import SpotifyPlayer, { type PlayerApi } from "../SpotifyPlayer";
import { QueueProvider } from "@/lib/queue/QueueProvider";
import { QueuePlaybackProvider } from "@/lib/playback/QueuePlaybackProvider";
import { useViewport } from "@/lib/responsive/useViewport";
import { PlaybackCommandQueue } from "@/lib/playback/commandQueue";
import {
  DEFAULT_PLAYBACK_FOCUS,
  type PlaybackFocus,
} from "./playbackFocus";
import type {
  PlayTrackRequest,
  PlayerCommandHandlers,
  PlayerCommandType,
  PlayerPlaybackStatus,
  PlayerRuntimeState,
} from "@/lib/playback/playerControllerTypes";
import {
  derivePlaybackSnapshot,
  type PlaybackSnapshot,
} from "@/lib/playback/playbackState";
import {
  derivePlaybackViewModel,
  type PlaybackViewModel,
} from "@/lib/playback/viewModel";

type PlayerController = {
  playbackStatus: PlayerPlaybackStatus;
  pendingCommand: PlayerCommandType | null;
  lastCommandId: string | null;
  runtime: PlayerRuntimeState;
  error: string | null;
  ready: boolean;
  playTrack: (request: PlayTrackRequest) => Promise<void>;
  playQueue: (
    uris: string[],
    offsetUri?: string,
    offsetIndex?: number | null
  ) => Promise<void>;
  playContext: (
    contextUri: string,
    offsetPosition?: number | null,
    offsetUri?: string
  ) => Promise<void>;
  toggle: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  seek: (ms: number) => Promise<void>;
  transfer: (deviceId: string, play?: boolean) => Promise<void>;
  clearError: () => void;
};

type PlayerContextValue = {
  api: PlayerApi | null;
  currentTrackId: string | null;
  playbackFocus: PlaybackFocus;
  playbackState: PlaybackSnapshot;
  playbackView: PlaybackViewModel;
  controller: PlayerController;
};

const INITIAL_RUNTIME: PlayerRuntimeState = {
  deviceId: null,
  isActiveDevice: false,
  sdkReady: false,
  lastError: null,
};

const NOOP_CONTROLLER: PlayerController = {
  playbackStatus: "empty",
  pendingCommand: null,
  lastCommandId: null,
  runtime: INITIAL_RUNTIME,
  error: null,
  ready: false,
  playTrack: async () => undefined,
  playQueue: async () => undefined,
  playContext: async () => undefined,
  toggle: async () => undefined,
  pause: async () => undefined,
  resume: async () => undefined,
  seek: async () => undefined,
  transfer: async () => undefined,
  clearError: () => undefined,
};

const PlayerContext = createContext<PlayerContextValue>({
  api: null,
  currentTrackId: null,
  playbackFocus: DEFAULT_PLAYBACK_FOCUS,
  playbackState: {
    currentTrackId: null,
    matchTrackIds: [],
    status: "idle",
    uiStatus: "empty",
    verifiedPlayable: false,
    reason: "no_track",
    stale: false,
    source: "system",
    updatedAt: 0,
    positionMs: 0,
    durationMs: 0,
    errorMessage: null,
  },
  playbackView: {
    activeTrackId: null,
    activeTrackIds: [],
    status: "idle",
    uiStatus: "empty",
    isPlaying: null,
    stale: false,
    transientGap: false,
    source: "system",
    reason: "no_track",
    updatedAt: 0,
    error: null,
    controllerStatus: "empty",
    pendingCommand: null,
    runtime: INITIAL_RUNTIME,
  },
  controller: NOOP_CONTROLLER,
});

function normalizeOffsetIndex(index: number | null | undefined, total: number) {
  if (typeof index !== "number" || !Number.isFinite(index) || total <= 0) return null;
  const parsed = Math.floor(index);
  if (parsed < 0 || parsed >= total) return null;
  return parsed;
}

function createCommandId() {
  return `pcmd_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [api, setApi] = useState<PlayerApi | null>(null);
  const [playbackFocus, setPlaybackFocus] = useState<PlaybackFocus>(
    DEFAULT_PLAYBACK_FOCUS
  );
  const [controllerRuntime, setControllerRuntime] =
    useState<PlayerRuntimeState>(INITIAL_RUNTIME);
  const [controllerError, setControllerError] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<PlayerCommandType | null>(null);
  const [lastCommandId, setLastCommandId] = useState<string | null>(null);
  const [commandDepth, setCommandDepth] = useState(0);
  const [handlersReady, setHandlersReady] = useState(false);
  const playbackFocusLatchRef = useRef<PlaybackFocus>(DEFAULT_PLAYBACK_FOCUS);
  const handlersRef = useRef<PlayerCommandHandlers | null>(null);
  const commandQueueRef = useRef(new PlaybackCommandQueue());
  const playerShellRef = useRef<HTMLDivElement | null>(null);
  const viewport = useViewport();
  const pathname = usePathname();
  const path = pathname ?? "/";
  const showPlayer = path === "/" || path.startsWith("/gsplayer") || path.startsWith("/queue");
  const showLibraryDock = path === "/" || path.startsWith("/gsplayer");

  const setControllerHandlers = useCallback((handlers: PlayerCommandHandlers | null) => {
    handlersRef.current = handlers;
    setHandlersReady(Boolean(handlers));
  }, []);

  const setControllerRuntimeFromPlayer = useCallback((runtime: PlayerRuntimeState) => {
    setControllerRuntime((prev) => {
      if (
        prev.deviceId === runtime.deviceId &&
        prev.isActiveDevice === runtime.isActiveDevice &&
        prev.sdkReady === runtime.sdkReady &&
        prev.lastError === runtime.lastError
      ) {
        return prev;
      }
      return runtime;
    });
  }, []);

  const executeCommand = useCallback(
    async (command: PlayerCommandType, run: (handlers: PlayerCommandHandlers) => Promise<void>) => {
      const commandId = createCommandId();
      setLastCommandId(commandId);
      setPendingCommand(command);
      setCommandDepth((prev) => prev + 1);
      setControllerError(null);

      try {
        await commandQueueRef.current.enqueue(async () => {
          const handlers = handlersRef.current;
          if (!handlers) {
            throw new Error("PLAYER_NOT_READY");
          }
          await run(handlers);
        });
      } catch (error) {
        const message = (error as Error)?.message ?? "Track afspelen lukt nu niet.";
        if (message === "PLAYER_NOT_READY") {
          setControllerError("Spotify player is nog niet klaar. Probeer het over een paar seconden opnieuw.");
        } else {
          setControllerError(message);
        }
        throw error;
      } finally {
        setCommandDepth((prev) => {
          const next = Math.max(0, prev - 1);
          if (next === 0) {
            setPendingCommand(null);
          }
          return next;
        });
      }
    },
    []
  );

  const playQueue = useCallback(
    async (uris: string[], offsetUri?: string, offsetIndex?: number | null) => {
      await executeCommand("play", async (handlers) => {
        handlers.primePlaybackGesture?.();
        await handlers.playQueue(uris, offsetUri, offsetIndex ?? null);
      });
    },
    [executeCommand]
  );

  const playContext = useCallback(
    async (contextUri: string, offsetPosition?: number | null, offsetUri?: string) => {
      await executeCommand("play", async (handlers) => {
        handlers.primePlaybackGesture?.();
        await handlers.playContext(contextUri, offsetPosition ?? null, offsetUri);
      });
    },
    [executeCommand]
  );

  const toggle = useCallback(async () => {
    await executeCommand("toggle", async (handlers) => {
      handlers.primePlaybackGesture?.();
      await handlers.togglePlay();
    });
  }, [executeCommand]);

  const pause = useCallback(async () => {
    if (playbackFocus.isPlaying === false) return;
    await executeCommand("pause", async (handlers) => {
      if (handlers.pause) {
        await handlers.pause();
        return;
      }
      await handlers.togglePlay();
    });
  }, [executeCommand, playbackFocus.isPlaying]);

  const resume = useCallback(async () => {
    if (playbackFocus.isPlaying === true) return;
    await executeCommand("play", async (handlers) => {
      handlers.primePlaybackGesture?.();
      if (handlers.resume) {
        await handlers.resume();
        return;
      }
      await handlers.togglePlay();
    });
  }, [executeCommand, playbackFocus.isPlaying]);

  const seek = useCallback(
    async (ms: number) => {
      await executeCommand("seek", async (handlers) => {
        if (!handlers.seek) {
          throw new Error("SEEK_NOT_AVAILABLE");
        }
        await handlers.seek(ms);
      });
    },
    [executeCommand]
  );

  const transfer = useCallback(
    async (deviceId: string, play = false) => {
      await executeCommand("transfer", async (handlers) => {
        if (!handlers.transfer) {
          throw new Error("TRANSFER_NOT_AVAILABLE");
        }
        await handlers.transfer(deviceId, play);
      });
    },
    [executeCommand]
  );

  const playTrack = useCallback(
    async (request: PlayTrackRequest) => {
      const trackId = String(request.trackId ?? "").trim();
      if (!trackId) return;
      const targetUri = `spotify:track:${trackId}`;
      const queueUris = Array.isArray(request.queueUris) ? request.queueUris : [];
      const hasQueueTrack = request.queueContainsTrack && queueUris.length > 0;
      const rowOffset = normalizeOffsetIndex(request.rowIndex, queueUris.length);
      const explicitTrackOffset = normalizeOffsetIndex(request.trackPosition, queueUris.length);

      if (request.mode === "playlists" && request.selectedPlaylistId) {
        if (
          request.selectedPlaylistType === "liked" ||
          request.selectedPlaylistType === "all_music"
        ) {
          if (hasQueueTrack) {
            await playQueue(queueUris, targetUri, rowOffset ?? 0);
          } else {
            await playQueue([targetUri], targetUri, 0);
          }
          return;
        }

        const contextUri = `spotify:playlist:${request.selectedPlaylistId}`;
        if (explicitTrackOffset !== null) {
          await playContext(contextUri, explicitTrackOffset, targetUri);
          return;
        }
        if (hasQueueTrack) {
          await playQueue(queueUris, targetUri, rowOffset);
          return;
        }
        await playContext(contextUri, null, targetUri);
        return;
      }

      if (!queueUris.length) {
        await playQueue([targetUri], targetUri, 0);
        return;
      }
      const fallbackOffset = rowOffset ?? explicitTrackOffset;
      await playQueue(queueUris, targetUri, fallbackOffset);
    },
    [playContext, playQueue]
  );

  const controllerPlaybackStatus = useMemo<PlayerPlaybackStatus>(() => {
    if (controllerError || controllerRuntime.lastError) return "error";
    if (commandDepth > 0 || pendingCommand) return "loading";
    if (playbackFocus.status === "error") return "error";
    if (playbackFocus.status === "loading") return "loading";
    if (playbackFocus.trackId && !playbackFocus.stale) return "ready";
    if (!handlersReady && !api && !controllerRuntime.sdkReady) return "empty";
    if (controllerRuntime.sdkReady || Boolean(controllerRuntime.deviceId) || Boolean(api)) {
      return "loading";
    }
    return "empty";
  }, [
    api,
    commandDepth,
    controllerError,
    controllerRuntime.deviceId,
    controllerRuntime.lastError,
    controllerRuntime.sdkReady,
    handlersReady,
    pendingCommand,
    playbackFocus.status,
    playbackFocus.stale,
    playbackFocus.trackId,
  ]);

  const controller = useMemo<PlayerController>(
    () => ({
      playbackStatus: controllerPlaybackStatus,
      pendingCommand,
      lastCommandId,
      runtime: controllerRuntime,
      error: controllerError ?? controllerRuntime.lastError,
      ready:
        controllerPlaybackStatus === "ready",
      playTrack,
      playQueue,
      playContext,
      toggle,
      pause,
      resume,
      seek,
      transfer,
      clearError: () => setControllerError(null),
    }),
    [
      controllerPlaybackStatus,
      pendingCommand,
      lastCommandId,
      controllerRuntime,
      controllerError,
      playTrack,
      playQueue,
      playContext,
      toggle,
      pause,
      resume,
      seek,
      transfer,
    ]
  );

  const playbackState = useMemo(() => {
    const { snapshot, nextStableFocus } = derivePlaybackSnapshot({
      focus: playbackFocus,
      lastStableFocus: playbackFocusLatchRef.current,
      controllerStatus: controllerPlaybackStatus,
      pendingCommand,
      controllerError,
      runtimeError: controllerRuntime.lastError,
    });
    playbackFocusLatchRef.current = nextStableFocus;
    return snapshot;
  }, [
    controllerError,
    controllerPlaybackStatus,
    controllerRuntime.lastError,
    pendingCommand,
    playbackFocus,
  ]);
  const currentTrackId = playbackState.currentTrackId;
  const playbackView = useMemo(
    () =>
      derivePlaybackViewModel({
        focus: playbackFocus,
        snapshot: playbackState,
        controllerStatus: controllerPlaybackStatus,
        pendingCommand,
        runtime: controllerRuntime,
        controllerError,
      }),
    [
      controllerError,
      controllerPlaybackStatus,
      controllerRuntime,
      pendingCommand,
      playbackFocus,
      playbackState,
    ]
  );

  const value = useMemo(
    () => ({ api, currentTrackId, playbackFocus, playbackState, playbackView, controller }),
    [api, currentTrackId, playbackFocus, playbackState, playbackView, controller]
  );

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
              <SpotifyPlayer
                onReady={setApi}
                onPlaybackFocusChange={setPlaybackFocus}
                controller={controller}
                onControllerHandlersChange={setControllerHandlers}
                onControllerRuntimeChange={setControllerRuntimeFromPlayer}
              />
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
