import type { PlayerApi } from "./playerControllerTypes";

export type PlayerDeferredPlayIntent =
  | {
      kind: "queue";
      uris: string[];
      offsetUri?: string;
      offsetIndex?: number | null;
      createdAt: number;
    }
  | {
      kind: "context";
      contextUri: string;
      offsetPosition?: number | null;
      offsetUri?: string;
      createdAt: number;
    };

type RefLike<T> = { current: T };

type PlayerInstanceLike = {
  activateElement?: () => Promise<unknown>;
  connect?: () => Promise<unknown>;
};

type PlaybackMetricTags = Record<
  string,
  string | number | boolean | null | undefined
>;

type CommandIngestEvent = {
  source: "command";
  seq: number;
  atMs: number;
  deviceId: string;
  trackId: string | null;
  isPlaying: boolean;
  force: boolean;
};

type CommandIngestMeta = {
  receivedMonoMs: number;
  snapshotDeviceId: string | null;
};

type PlaybackStartRetryOptions = {
  deviceId: string;
  expectedTrackId: string | null;
  replay: () => Promise<Response | null>;
};

export type PlayerApiFactoryDeps = {
  accessTokenRef: RefLike<string | undefined>;
  activeDeviceIdRef: RefLike<string | null>;
  deviceIdRef: RefLike<string | null>;
  sdkDeviceIdRef: RefLike<string | null>;
  playerRef: RefLike<PlayerInstanceLike | null>;
  playIntentReplayRef: RefLike<boolean>;
  pendingTrackIdRef: RefLike<string | null>;
  trackChangeLockUntilRef: RefLike<number>;
  lastConfirmedActiveDeviceRef: RefLike<{ id: string; at: number } | null>;
  playbackRestrictionUntilRef: RefLike<number>;
  shuffleOnRef: RefLike<boolean>;
  queueModeRef: RefLike<"queue" | "context" | null>;
  queueUrisRef: RefLike<string[] | null>;
  queueIndexRef: RefLike<number>;
  queueOrderRef: RefLike<number[] | null>;
  queuePosRef: RefLike<number>;
  shouldOwnPlaybackSync: boolean;
  playbackAllowed: boolean;
  localWebplayerName: string;
  retryAfterMaxMs: number;
  playbackRestrictionCooldownMs: number;
  setError: (message: string | null) => void;
  setPlaybackTouched: (value: boolean) => void;
  setActiveDevice: (deviceId: string, name?: string | null) => void;
  setDeviceReady: (ready: boolean) => void;
  setActiveDeviceRestricted: (value: boolean) => void;
  enqueuePlaybackCommand: (command: () => Promise<void>) => Promise<void>;
  beginOperationEpoch: () => number;
  waitForKnownDeviceId: () => Promise<string | null>;
  waitForPlayableDevice: (timeoutMs?: number) => Promise<string | null>;
  queueDeferredPlayIntent: (intent: PlayerDeferredPlayIntent) => void;
  getIndexFromTrackId: (
    uris: string[],
    trackId: string | null | undefined
  ) => number;
  applyProgressPosition: (positionMs: number) => void;
  ensureActiveDevice: (
    deviceId: string,
    token: string,
    allowTransfer: boolean
  ) => Promise<boolean>;
  setRemoteShuffleState: (
    enabled: boolean,
    deviceId: string,
    token: string,
    verify: boolean
  ) => Promise<boolean>;
  spotifyApiFetch: (input: string, init?: RequestInit) => Promise<Response | null>;
  withDeviceId: (input: string, deviceId: string) => string;
  refreshDevices: (force?: boolean) => Promise<void>;
  readJsonSafely: <T = unknown>(
    res: Response | null | undefined
  ) => Promise<T | null>;
  resolveTrackIdFromUri: (uri: string | null | undefined) => string | null;
  shouldApplyIngest: (
    event: CommandIngestEvent,
    meta: CommandIngestMeta
  ) => boolean;
  readSyncServerSeq: (payload: unknown) => number;
  readSyncServerTime: (payload: unknown) => number;
  getMonotonicNow: () => number;
  ensurePlaybackStartedWithRetry: (
    options: PlaybackStartRetryOptions
  ) => Promise<boolean>;
  emitPlaybackMetric: (
    name: string,
    value: number,
    tags?: PlaybackMetricTags
  ) => void;
  buildShuffleOrder: (length: number, startIndex: number) => number[];
  schedulePlaybackVerify: (
    delayMs: number,
    source: "api_verify",
    operationEpoch: number
  ) => void;
  handleTogglePlay: () => Promise<void>;
  handlePausePlayback: () => Promise<void>;
  handleResumePlayback: () => Promise<void>;
  handleSeek: (ms: number) => Promise<void>;
  handleDeviceChange: (deviceId: string) => Promise<void>;
  handleNext: () => Promise<void>;
  handlePrevious: () => Promise<void>;
};

export function createPlayerApiHandlers({
  accessTokenRef,
  activeDeviceIdRef,
  deviceIdRef,
  sdkDeviceIdRef,
  playerRef,
  playIntentReplayRef,
  pendingTrackIdRef,
  trackChangeLockUntilRef,
  lastConfirmedActiveDeviceRef,
  playbackRestrictionUntilRef,
  shuffleOnRef,
  queueModeRef,
  queueUrisRef,
  queueIndexRef,
  queueOrderRef,
  queuePosRef,
  shouldOwnPlaybackSync,
  playbackAllowed,
  localWebplayerName,
  retryAfterMaxMs,
  playbackRestrictionCooldownMs,
  setError,
  setPlaybackTouched,
  setActiveDevice,
  setDeviceReady,
  setActiveDeviceRestricted,
  enqueuePlaybackCommand,
  beginOperationEpoch,
  waitForKnownDeviceId,
  waitForPlayableDevice,
  queueDeferredPlayIntent,
  getIndexFromTrackId,
  applyProgressPosition,
  ensureActiveDevice,
  setRemoteShuffleState,
  spotifyApiFetch,
  withDeviceId,
  refreshDevices,
  readJsonSafely,
  resolveTrackIdFromUri,
  shouldApplyIngest,
  readSyncServerSeq,
  readSyncServerTime,
  getMonotonicNow,
  ensurePlaybackStartedWithRetry,
  emitPlaybackMetric,
  buildShuffleOrder,
  schedulePlaybackVerify,
  handleTogglePlay,
  handlePausePlayback,
  handleResumePlayback,
  handleSeek,
  handleDeviceChange,
  handleNext,
  handlePrevious,
}: PlayerApiFactoryDeps): PlayerApi {
  const raisePlaybackCommandError = (
    status: number | undefined,
    code: string,
    userMessage: string,
    retryAfterSec?: number
  ): never => {
    setError(userMessage);
    const error = new Error(
      typeof status === "number" ? `SPOTIFY_${status}_${code}` : `SPOTIFY_${code}`
    ) as Error & {
      status?: number;
      retryAfterSec?: number;
      userMessage?: string;
    };
    if (typeof status === "number") {
      error.status = status;
    }
    if (typeof retryAfterSec === "number" && Number.isFinite(retryAfterSec)) {
      error.retryAfterSec = retryAfterSec;
    }
    error.userMessage = userMessage;
    throw error;
  };

  const isRestrictionViolationResponse = async (res: Response) => {
    if (res.status !== 403) return false;
    const details = await readJsonSafely<{ error?: string; message?: string }>(
      res.clone()
    );
    const errorCode = String(details?.error ?? "").trim().toUpperCase();
    return (
      errorCode === "RESTRICTION_VIOLATED" ||
      String(details?.message ?? "")
        .toLowerCase()
        .includes("restriction violated")
    );
  };

  const recoverDeferredPlaybackStart = async (
    res: Response,
    intent: PlayerDeferredPlayIntent
  ) => {
    const noActiveDevice = res.status === 404;
    const restrictionViolation =
      res.status === 403 && (await isRestrictionViolationResponse(res));
    if (!noActiveDevice && !restrictionViolation) {
      return false;
    }

    lastConfirmedActiveDeviceRef.current = null;
    setDeviceReady(false);
    if (shouldOwnPlaybackSync) {
      void refreshDevices(true);
    }

    if (!playIntentReplayRef.current) {
      if (restrictionViolation) {
        playbackRestrictionUntilRef.current =
          Date.now() + playbackRestrictionCooldownMs;
        setActiveDeviceRestricted(true);
        setError(
          "Spotify is temporarily blocking playback on this device. Retrying automatically."
        );
      }
      queueDeferredPlayIntent({
        ...intent,
        createdAt: Date.now(),
      });
      return true;
    }

    if (restrictionViolation) {
      raisePlaybackCommandError(
        403,
        "RESTRICTION_VIOLATED",
        "Spotify is temporarily blocking playback on this device. Switch device or try again."
      );
    }
    raisePlaybackCommandError(
      404,
      "NO_ACTIVE_DEVICE",
      "No active Spotify player found."
    );
  };

  return {
    primePlaybackGesture: () => {
      setPlaybackTouched(true);
      playerRef.current?.activateElement?.().catch?.(() => undefined);
      playerRef.current?.connect?.().catch?.(() => undefined);
    },
    playQueue: async (uris, offsetUri, offsetIndex) =>
      enqueuePlaybackCommand(async () => {
        const operationEpoch = beginOperationEpoch();
        setPlaybackTouched(true);
        playerRef.current?.activateElement?.().catch?.(() => undefined);
        playerRef.current?.connect?.().catch?.(() => undefined);
        const tokenValue = accessTokenRef.current;
        if (!tokenValue) {
          raisePlaybackCommandError(
            401,
            "MISSING_TOKEN",
            "Spotify-sessie verlopen. Log opnieuw in."
          );
        }
        const token = tokenValue as string;
        let currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
        if (!playbackAllowed) {
          raisePlaybackCommandError(
            403,
            "MISSING_SCOPE",
            "Missing Spotify permissions. Reconnect."
          );
        }
        if (!currentDevice && sdkDeviceIdRef.current) {
          currentDevice = sdkDeviceIdRef.current;
          setActiveDevice(currentDevice, localWebplayerName);
        }
        if (!currentDevice) {
          const awaitedDevice = await waitForKnownDeviceId();
          if (awaitedDevice) {
            currentDevice = awaitedDevice;
            if (awaitedDevice === sdkDeviceIdRef.current) {
              setActiveDevice(awaitedDevice, localWebplayerName);
            }
          }
        }
        if (!currentDevice) {
          const preparedDevice = await waitForPlayableDevice();
          if (preparedDevice) {
            currentDevice = preparedDevice;
            if (preparedDevice === sdkDeviceIdRef.current) {
              setActiveDevice(preparedDevice, localWebplayerName);
            }
          }
        }
        if (!currentDevice) {
          if (!playIntentReplayRef.current) {
            queueDeferredPlayIntent({
              kind: "queue",
              uris: [...uris],
              offsetUri,
              offsetIndex,
              createdAt: Date.now(),
            });
            return;
          }
          raisePlaybackCommandError(
            404,
            "NO_ACTIVE_DEVICE",
            "No Spotify device selected. Choose a device to start playback."
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
          ? offsetIndex
          : offsetUri
            ? Math.max(0, uris.indexOf(offsetUri))
            : Math.max(0, getIndexFromTrackId(uris, pendingTrackIdRef.current));
        const resolvedUri = uris[resolvedIndex] ?? offsetUri ?? null;

        if (resolvedUri) {
          const id = resolvedUri.split(":").pop() || null;
          pendingTrackIdRef.current = id;
          trackChangeLockUntilRef.current = Date.now() + 2000;
          applyProgressPosition(0);
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

        const initialQueueDevice = currentDevice;
        if (!initialQueueDevice) {
          raisePlaybackCommandError(
            404,
            "NO_ACTIVE_DEVICE",
            "No Spotify device selected. Choose a device to start playback."
          );
        }
        const ready = await ensureActiveDevice(
          initialQueueDevice as string,
          token,
          false
        );
        if (!ready) {
          const preparedDevice = await waitForPlayableDevice(5_000);
          if (preparedDevice) {
            currentDevice = preparedDevice;
          } else if (!playIntentReplayRef.current) {
            queueDeferredPlayIntent({
              kind: "queue",
              uris: [...uris],
              offsetUri,
              offsetIndex,
              createdAt: Date.now(),
            });
            return;
          }
        }
        if (!currentDevice) {
          raisePlaybackCommandError(
            404,
            "DEVICE_NOT_READY",
            "Spotify-apparaat is nog niet klaar. Probeer opnieuw."
          );
        }
        const selectedQueueDevice = currentDevice as string;
        const shuffleReady = await setRemoteShuffleState(
          shuffleOnRef.current,
          selectedQueueDevice,
          token,
          false
        );
        if (!shuffleReady) {
          setError("Shuffle status kon niet worden toegepast op dit apparaat.");
        }

        const attemptPlay = async () =>
          spotifyApiFetch(
            withDeviceId(
              "https://api.spotify.com/v1/me/player/play",
              selectedQueueDevice
            ),
            { method: "PUT", body: JSON.stringify(payload) }
          );

        let res = await attemptPlay();
        if (res && !res.ok) {
          if (res.status === 409) {
            if (shouldOwnPlaybackSync) {
              void refreshDevices(true);
            }
            const preparedDevice = await waitForPlayableDevice(3_500);
            if (preparedDevice) {
              currentDevice = preparedDevice;
            }
            await new Promise((resolve) => setTimeout(resolve, 450));
            res = await attemptPlay();
          } else if (res.status === 404 || res.status >= 500) {
            if (shouldOwnPlaybackSync) {
              void refreshDevices(true);
            }
            await new Promise((resolve) => setTimeout(resolve, 600));
            res = await attemptPlay();
          }
        }
        if (!res) {
          raisePlaybackCommandError(
            undefined,
            "PLAY_REQUEST_FAILED",
            "Spotify-verbinding is instabiel. Probeer opnieuw."
          );
        }
        const playResponse = res as Response;
        if (!playResponse.ok && playResponse.status !== 204) {
          if (playResponse.status === 401) {
            raisePlaybackCommandError(
              401,
              "UNAUTHORIZED",
              "Spotify-sessie verlopen. Log opnieuw in."
            );
          }
          if (playResponse.status === 403) {
            if (
              await recoverDeferredPlaybackStart(playResponse, {
                kind: "queue",
                uris: [...uris],
                offsetUri,
                offsetIndex,
                createdAt: Date.now(),
              })
            ) {
              return;
            }
            raisePlaybackCommandError(
              403,
              "FORBIDDEN",
              "Missing Spotify permissions. Reconnect."
            );
          }
          if (playResponse.status === 404) {
            if (
              await recoverDeferredPlaybackStart(playResponse, {
                kind: "queue",
                uris: [...uris],
                offsetUri,
                offsetIndex,
                createdAt: Date.now(),
              })
            ) {
              return;
            }
            raisePlaybackCommandError(
              404,
              "NO_ACTIVE_DEVICE",
              "No active Spotify player found."
            );
          }
          if (playResponse.status === 429) {
            const retryAfterRaw = Number(
              playResponse.headers.get("Retry-After") ?? "1"
            );
            const retryAfter = Number.isFinite(retryAfterRaw)
              ? Math.min(retryAfterRaw, retryAfterMaxMs / 1000)
              : 1;
            raisePlaybackCommandError(
              429,
              "RATE_LIMITED",
              `Spotify is druk. Probeer opnieuw over ${Math.max(1, Math.round(retryAfter))}s.`,
              retryAfter
            );
          }
          raisePlaybackCommandError(
            playResponse.status,
            "PLAY_FAILED",
            "Playback is unavailable right now. Try again."
          );
        }
        if (playResponse.ok) {
          const expectedTrackId = resolveTrackIdFromUri(resolvedUri);
          const playAck = await readJsonSafely(playResponse.clone());
          shouldApplyIngest(
            {
              source: "command",
              seq: readSyncServerSeq(playAck),
              atMs: readSyncServerTime(playAck),
              deviceId: selectedQueueDevice,
              trackId: expectedTrackId,
              isPlaying: true,
              force: true,
            },
            {
              receivedMonoMs: getMonotonicNow(),
              snapshotDeviceId: selectedQueueDevice,
            }
          );
          const started = await ensurePlaybackStartedWithRetry({
            deviceId: selectedQueueDevice,
            expectedTrackId,
            replay: attemptPlay,
          });
          if (!started) {
            setError("Track startte niet direct. Probeer opnieuw.");
            emitPlaybackMetric("play_start_failed", 1, {
              mode: "queue",
              reason: "not_started_after_retry",
            });
          } else {
            setError(null);
            emitPlaybackMetric("play_start_success", 1, { mode: "queue" });
          }
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
          applyProgressPosition(0);
          if (resolvedUri) {
            const id = resolvedUri.split(":").pop() || null;
            pendingTrackIdRef.current = id;
            trackChangeLockUntilRef.current = Date.now() + 3000;
          }
          schedulePlaybackVerify(280, "api_verify", operationEpoch);
        }
      }),
    playContext: async (contextUri, offsetPosition, offsetUri) =>
      enqueuePlaybackCommand(async () => {
        const operationEpoch = beginOperationEpoch();
        setPlaybackTouched(true);
        playerRef.current?.activateElement?.().catch?.(() => undefined);
        playerRef.current?.connect?.().catch?.(() => undefined);
        const tokenValue = accessTokenRef.current;
        if (!tokenValue) {
          raisePlaybackCommandError(
            401,
            "MISSING_TOKEN",
            "Spotify-sessie verlopen. Log opnieuw in."
          );
        }
        const token = tokenValue as string;
        let currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
        if (!playbackAllowed) {
          raisePlaybackCommandError(
            403,
            "MISSING_SCOPE",
            "Missing Spotify permissions. Reconnect."
          );
        }
        if (!currentDevice && sdkDeviceIdRef.current) {
          currentDevice = sdkDeviceIdRef.current;
          setActiveDevice(currentDevice, localWebplayerName);
        }
        if (!currentDevice) {
          const awaitedDevice = await waitForKnownDeviceId();
          if (awaitedDevice) {
            currentDevice = awaitedDevice;
            if (awaitedDevice === sdkDeviceIdRef.current) {
              setActiveDevice(awaitedDevice, localWebplayerName);
            }
          }
        }
        if (!currentDevice) {
          const preparedDevice = await waitForPlayableDevice();
          if (preparedDevice) {
            currentDevice = preparedDevice;
            if (preparedDevice === sdkDeviceIdRef.current) {
              setActiveDevice(preparedDevice, localWebplayerName);
            }
          }
        }
        if (!currentDevice) {
          if (!playIntentReplayRef.current) {
            queueDeferredPlayIntent({
              kind: "context",
              contextUri,
              offsetPosition,
              offsetUri,
              createdAt: Date.now(),
            });
            return;
          }
          raisePlaybackCommandError(
            404,
            "NO_ACTIVE_DEVICE",
            "No Spotify device selected. Choose a device to start playback."
          );
        }
        if (offsetUri) {
          const id = offsetUri.split(":").pop() || null;
          pendingTrackIdRef.current = id;
          trackChangeLockUntilRef.current = Date.now() + 2000;
          applyProgressPosition(0);
        }
        if (currentDevice === sdkDeviceIdRef.current) {
          await playerRef.current?.activateElement?.();
        }

        const initialContextDevice = currentDevice;
        if (!initialContextDevice) {
          raisePlaybackCommandError(
            404,
            "NO_ACTIVE_DEVICE",
            "No Spotify device selected. Choose a device to start playback."
          );
        }
        const ready = await ensureActiveDevice(
          initialContextDevice as string,
          token,
          false
        );
        if (!ready) {
          const preparedDevice = await waitForPlayableDevice(5_000);
          if (preparedDevice) {
            currentDevice = preparedDevice;
          } else if (!playIntentReplayRef.current) {
            queueDeferredPlayIntent({
              kind: "context",
              contextUri,
              offsetPosition,
              offsetUri,
              createdAt: Date.now(),
            });
            return;
          }
        }

        if (!currentDevice) {
          raisePlaybackCommandError(
            404,
            "DEVICE_NOT_READY",
            "Spotify-apparaat is nog niet klaar. Probeer opnieuw."
          );
        }
        const selectedContextDevice = currentDevice as string;

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

        const attemptContextPlay = () =>
          spotifyApiFetch(
            withDeviceId(
              "https://api.spotify.com/v1/me/player/play",
              selectedContextDevice
            ),
            { method: "PUT", body: JSON.stringify(body) }
          );
        let res = await attemptContextPlay();
        if (res && !res.ok) {
          if (res.status === 409) {
            if (shouldOwnPlaybackSync) {
              void refreshDevices(true);
            }
            const preparedDevice = await waitForPlayableDevice(3_500);
            if (preparedDevice) {
              currentDevice = preparedDevice;
            }
            await new Promise((resolve) => setTimeout(resolve, 450));
            res = await attemptContextPlay();
          } else if (res.status === 404 || res.status >= 500) {
            if (shouldOwnPlaybackSync) {
              void refreshDevices(true);
            }
            await new Promise((resolve) => setTimeout(resolve, 600));
            res = await attemptContextPlay();
          }
        }
        if (!res) {
          raisePlaybackCommandError(
            undefined,
            "PLAY_REQUEST_FAILED",
            "Spotify-verbinding is instabiel. Probeer opnieuw."
          );
        }
        const contextResponse = res as Response;
        if (!contextResponse.ok && contextResponse.status !== 204) {
          if (contextResponse.status === 401) {
            raisePlaybackCommandError(
              401,
              "UNAUTHORIZED",
              "Spotify-sessie verlopen. Log opnieuw in."
            );
          }
          if (contextResponse.status === 403) {
            if (
              await recoverDeferredPlaybackStart(contextResponse, {
                kind: "context",
                contextUri,
                offsetPosition,
                offsetUri,
                createdAt: Date.now(),
              })
            ) {
              return;
            }
            raisePlaybackCommandError(
              403,
              "FORBIDDEN",
              "Missing Spotify permissions. Reconnect."
            );
          }
          if (contextResponse.status === 404) {
            if (
              await recoverDeferredPlaybackStart(contextResponse, {
                kind: "context",
                contextUri,
                offsetPosition,
                offsetUri,
                createdAt: Date.now(),
              })
            ) {
              return;
            }
            raisePlaybackCommandError(
              404,
              "NO_ACTIVE_DEVICE",
              "No active Spotify player found."
            );
          }
          if (contextResponse.status === 429) {
            const retryAfterRaw = Number(
              contextResponse.headers.get("Retry-After") ?? "1"
            );
            const retryAfter = Number.isFinite(retryAfterRaw)
              ? Math.min(retryAfterRaw, retryAfterMaxMs / 1000)
              : 1;
            raisePlaybackCommandError(
              429,
              "RATE_LIMITED",
              `Spotify is druk. Probeer opnieuw over ${Math.max(1, Math.round(retryAfter))}s.`,
              retryAfter
            );
          }
          raisePlaybackCommandError(
            contextResponse.status,
            "PLAY_FAILED",
            "Playback is unavailable right now. Try again."
          );
        }
        if (contextResponse.ok) {
          const expectedTrackId = resolveTrackIdFromUri(offsetUri ?? null);
          const contextAck = await readJsonSafely(contextResponse.clone());
          shouldApplyIngest(
            {
              source: "command",
              seq: readSyncServerSeq(contextAck),
              atMs: readSyncServerTime(contextAck),
              deviceId: selectedContextDevice,
              trackId: expectedTrackId,
              isPlaying: true,
              force: true,
            },
            {
              receivedMonoMs: getMonotonicNow(),
              snapshotDeviceId: selectedContextDevice,
            }
          );
          const started = await ensurePlaybackStartedWithRetry({
            deviceId: selectedContextDevice,
            expectedTrackId,
            replay: attemptContextPlay,
          });
          if (!started) {
            setError("Track startte niet direct. Probeer opnieuw.");
            emitPlaybackMetric("play_start_failed", 1, {
              mode: "context",
              reason: "not_started_after_retry",
            });
          } else {
            setError(null);
            emitPlaybackMetric("play_start_success", 1, { mode: "context" });
          }
          queueModeRef.current = "context";
          queueUrisRef.current = null;
          queueOrderRef.current = null;
          queuePosRef.current = 0;
          applyProgressPosition(0);
          if (offsetUri) {
            const id = offsetUri.split(":").pop() || null;
            pendingTrackIdRef.current = id;
            trackChangeLockUntilRef.current = Date.now() + 3000;
          }
          schedulePlaybackVerify(280, "api_verify", operationEpoch);
        }
        const shuffleReady = await setRemoteShuffleState(
          shuffleOnRef.current,
          selectedContextDevice,
          token,
          false
        );
        if (!shuffleReady) {
          setError("Shuffle status kon niet worden toegepast op dit apparaat.");
        }
      }),
    togglePlay: async () => handleTogglePlay(),
    pause: async () => handlePausePlayback(),
    resume: async () => handleResumePlayback(),
    seek: async (ms: number) => handleSeek(ms),
    transfer: async (nextDeviceId: string, play = false) => {
      if (!nextDeviceId) return;
      await handleDeviceChange(nextDeviceId);
      if (play) {
        await handleResumePlayback();
      }
    },
    next: async () => handleNext(),
    previous: async () => handlePrevious(),
  };
}
