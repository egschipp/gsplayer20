"use client";

import Image from "next/image";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getSession, useSession } from "next-auth/react";
import {
  SPOTIFY_PLAYBACK_SCOPES,
  hasPlaybackScopes,
  parseScopes,
} from "@/lib/spotify/scopes";
import {
  clampProgressValue,
  projectRemoteProgressValue,
  reconcileProgressValue,
} from "@/lib/playback/syncMath";
import {
  DEFAULT_PLAYBACK_FOCUS,
  type PlaybackFocus,
  type PlaybackFocusStatus,
  type PlaybackFocusSource,
  resolvePlaybackFocusStatus,
} from "./player/playbackFocus";
import { PLAYBACK_FEATURE_FLAGS } from "@/lib/playback/featureFlags";
import { deriveQueueActivePresentation } from "@/lib/playback/queuePresentation";
import { emitPlaybackUiMetric } from "@/lib/playback/uiTelemetry";
import { usePlaybackCommandQueue } from "./player/usePlaybackCommandQueue";
import { useQueueStore } from "@/lib/queue/QueueProvider";
import { useQueuePlayback } from "@/lib/playback/QueuePlaybackProvider";
import { useStableMenu } from "@/lib/hooks/useStableMenu";
import {
  INITIAL_PLAYBACK_SYNC_STATE,
  reducePlaybackSyncState,
  shouldApplyPlaybackEvent,
  type PlaybackIngestSource,
  type PlaybackSyncEvent,
  type PlaybackSyncState,
} from "@/lib/playback/syncCore";
import {
  INITIAL_PLAYBACK_VERSION,
  resolvePlaybackAuthorityMode,
  shouldApplyPlaybackVersion,
  shouldIngestSourceForAuthority,
  type PlaybackAuthorityMode,
  type PlaybackVersion,
} from "@/lib/playback/authority";
import { animateScrollTop } from "@/lib/ui/smoothScroll";
import type {
  PlayerApi,
  PlayerCommandHandlers,
  PlayerRuntimeState,
} from "@/lib/playback/playerControllerTypes";
import {
  PLAYBACK_CROSS_TAB_CHANNEL,
  type PlaybackCrossTabMessage,
  type PlaybackCrossTabSnapshot,
} from "@/lib/playback/crossTab";
import {
  getPlayerErrorMessage,
  normalizePlayerError,
} from "@/lib/playback/playerErrors";
import {
  resolvePlaybackExecutionMode,
  resolvePlaybackSyncOwnership,
} from "@/lib/playback/runtimeMode";
import {
  createPlayerApiHandlers,
  type PlayerDeferredPlayIntent,
} from "@/lib/playback/playerApiFactory";
import { usePlaybackLeader } from "@/lib/playback/usePlaybackLeader";

declare global {
  interface Window {
    Spotify: any;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

const PLAYER_FETCH_TIMEOUT_MS = 12000;
const PLAYER_FETCH_MAX_ATTEMPTS = 3;
const PLAYER_RETRY_AFTER_MAX_MS = 120_000;
const DEVICE_SWITCH_RESUME_VERIFY_DELAY_MS = 220;
const DEVICE_SWITCH_RESUME_TOLERANCE_MS = 2_500;
const LOCAL_WEBPLAYER_NAME = "Georgies Webplayer";
const DEVICE_SELECTION_HOLD_MS = 8_000;
const SEEK_CONFIRM_TOLERANCE_MS = 900;
const SEEK_ROLLBACK_TIMEOUT_MS = 1400;
const PROGRESS_DEADBAND_MS = 120;
const PROGRESS_MAX_STEP_MS = 250;
const REMOTE_TAKEOVER_CONFIRM_MS = 1200;
const REMOTE_TAKEOVER_MIN_SAMPLES = 2;
const PLAYBACK_RESTRICTION_COOLDOWN_MS = 4_000;
const PLAYER_TRACK_ID_REGEX = /^[A-Za-z0-9]{22}$/;
const LEADING_EMOJI_PATTERN =
  /^[\s\u200B-\u200D\u200E\u200F\u2060\uFEFF]*(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]{2}|[#*0-9]\uFE0F?\u20E3)/u;
const PLAYER_LIKED_PLAYLIST_ID = "liked";
const CONNECT_DOCK_PIN_KEY = "gs_connect_dock_pinned_v1";
const PLAYBACK_READY_TIMEOUT_MS = 9_000;
const PLAYBACK_READY_POLL_MS = 240;
const PLAYBACK_READY_REFRESH_EVERY_MS = 1_200;
const PLAYBACK_INTENT_MAX_AGE_MS = 15_000;
const LOCAL_PLAYER_BOOT_RETRY_MS = [0, 1_500] as const;
const DEVICE_SWITCH_SYNC_BOOST_MS = 8_000;
const REMOTE_STALE_TRACK_HOLD_MS = 12_000;
const LOCAL_STALE_TRACK_HOLD_MS = 7_000;
const PLAYER_LIVE_TRACK_UI_GRACE_MS = 6_000;
const NO_TRACK_HARD_CLEAR_MIN_COUNT = 3;
const NO_TRACK_HARD_CLEAR_GRACE_MS = 3_500;
const NO_TRACK_HANDOFF_HARD_CLEAR_MIN_COUNT = 6;
const NO_TRACK_HANDOFF_HARD_CLEAR_GRACE_MS = 12_000;
const QUEUE_ACTIVE_ERROR_VISIBILITY_DELAY_LOCAL_MS = 3_000;
const QUEUE_ACTIVE_ERROR_VISIBILITY_DELAY_REMOTE_MS = 8_000;
const QUEUE_ACTIVE_FALLBACK_MAX_AGE_MS = 4_500;

type PlayerPlaylistOption = {
  id: string;
  name: string;
  type: "liked" | "playlist";
};

type PlaybackSource =
  | "sdk"
  | "api_sync"
  | "api_poll"
  | "api_verify"
  | "api_bootstrap"
  | "api_stream";

function toIngestSource(source: PlaybackSource): PlaybackIngestSource {
  if (source === "sdk") return "sdk";
  if (source === "api_stream") return "sse";
  if (source === "api_verify") return "verify";
  if (source === "api_bootstrap") return "bootstrap";
  return "poll";
}

type PendingSeekState = {
  id: number;
  targetMs: number;
  previousMs: number;
  startedMonoMs: number;
  epoch: number;
};

type DeviceSwitchContext = {
  wasPlaying: boolean;
  trackId: string | null;
  progressMs: number | null;
  durationMs: number | null;
  sampledAt: number;
};

type HandoffPhase =
  | "idle"
  | "requested"
  | "device_ready"
  | "playback_confirmed"
  | "failed";

type HandoffState = {
  phase: HandoffPhase;
  targetDeviceId: string | null;
  updatedAt: number;
  reason: string;
};

type NoTrackCounterState = {
  count: number;
  firstAt: number;
  lastAt: number;
  lastSource: PlaybackSource | PlaybackFocusSource | null;
  lastDeviceId: string | null;
};

type QueueTrackItem = {
  id: string;
  uri: string | null;
  matchTrackIds: string[];
  name: string;
  artists: string;
  coverUrl: string | null;
  durationMs: number | null;
  explicit: boolean;
  isCurrent: boolean;
};

type DeferredPlayIntent = PlayerDeferredPlayIntent;

const INITIAL_HANDOFF_STATE: HandoffState = {
  phase: "idle",
  targetDeviceId: null,
  updatedAt: 0,
  reason: "init",
};

const INITIAL_NO_TRACK_COUNTER: NoTrackCounterState = {
  count: 0,
  firstAt: 0,
  lastAt: 0,
  lastSource: null,
  lastDeviceId: null,
};

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

type PlayerProps = {
  onReady: (api: PlayerApi | null) => void;
  onTrackChange?: (trackId: string | null) => void;
  onPlaybackFocusChange?: (focus: PlaybackFocus) => void;
  controller?: {
    toggle: () => Promise<void>;
    pause: () => Promise<void>;
    resume: () => Promise<void>;
    seek: (ms: number) => Promise<void>;
  } | null;
  onControllerHandlersChange?: (handlers: PlayerCommandHandlers | null) => void;
  onControllerRuntimeChange?: (runtime: PlayerRuntimeState) => void;
};

function getWebPlaybackSdkSupport() {
  if (typeof window === "undefined") {
    return { supported: false, reason: "Web player requires a browser context." };
  }
  if (!window.isSecureContext) {
    return {
      supported: false,
      reason: "Web player requires HTTPS (secure context).",
    };
  }
  const hasAudioContext =
    typeof window.AudioContext !== "undefined" ||
    typeof (window as any).webkitAudioContext !== "undefined";
  const hasMediaSource = typeof (window as any).MediaSource !== "undefined";
  if (!hasAudioContext || !hasMediaSource) {
    return {
      supported: false,
      reason: "This browser does not fully support Spotify Web Playback.",
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

function parseSpotifyPlayerApiUrl(input: string) {
  try {
    const parsed = new URL(input);
    if (parsed.origin !== "https://api.spotify.com") return null;
    if (!parsed.pathname.startsWith("/v1/me/player")) return null;
    return {
      endpoint: parsed.pathname.slice("/v1/me/player".length),
      search: parsed.search || "",
    };
  } catch {
    return null;
  }
}

function normalizePlaybackTrackId(value: unknown) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^[0-9A-Za-z]{22}$/.test(raw)) return raw;
  if (raw.startsWith("spotify:track:")) {
    const segment = raw.split(":").pop() ?? "";
    const id = segment.split("?")[0]?.trim() ?? "";
    return /^[0-9A-Za-z]{22}$/.test(id) ? id : null;
  }
  if (
    raw.includes("open.spotify.com/track/") ||
    raw.includes("api.spotify.com/v1/tracks/")
  ) {
    try {
      const url = new URL(raw);
      const segment = (url.pathname.split("/").filter(Boolean).pop() ?? "")
        .split("?")[0]
        .trim();
      return /^[0-9A-Za-z]{22}$/.test(segment) ? segment : null;
    } catch {
      return null;
    }
  }
  return null;
}

function resolvePlaybackTrackId(item: any) {
  return (
    normalizePlaybackTrackId(item?.id) ??
    normalizePlaybackTrackId(item?.uri) ??
    normalizePlaybackTrackId(item?.href) ??
    normalizePlaybackTrackId(item?.linked_from?.id) ??
    normalizePlaybackTrackId(item?.linked_from?.uri) ??
    normalizePlaybackTrackId(item?.linked_from?.href) ??
    normalizePlaybackTrackId(item?.external_urls?.spotify)
  );
}

function resolvePlaybackTrackIds(item: any) {
  const values = [
    item?.id,
    item?.uri,
    item?.href,
    item?.linked_from?.id,
    item?.linked_from?.uri,
    item?.linked_from?.href,
    item?.external_urls?.spotify,
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizePlaybackTrackId(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function mapQueueTrackItem(track: any, fallbackIndex = 0): QueueTrackItem {
  const normalizedId = resolvePlaybackTrackId(track);
  const matchTrackIds = resolvePlaybackTrackIds(track);
  const uri = typeof track?.uri === "string" ? track.uri : null;
  return {
    id: normalizedId ?? `${uri ?? "queue-track"}:${fallbackIndex}`,
    uri,
    matchTrackIds,
    name: track?.name ?? "Unknown track",
    artists: Array.isArray(track?.artists)
      ? track.artists.map((a: any) => a?.name).filter(Boolean).join(", ")
      : "",
    coverUrl: track?.album?.images?.[0]?.url ?? null,
    durationMs:
      typeof track?.duration_ms === "number"
        ? Math.max(0, Math.floor(track.duration_ms))
        : null,
    explicit: Boolean(track?.explicit),
    isCurrent: false,
  };
}

function extractProxyPayload(body: RequestInit["body"]) {
  if (!body) return undefined;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  if (body instanceof URLSearchParams) {
    return Object.fromEntries(body.entries());
  }
  return body;
}

function createCommandId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fallback below
  }
  return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function startsWithEmoji(value: string | null | undefined) {
  return LEADING_EMOJI_PATTERN.test(String(value ?? ""));
}

function normalizeTrackIdCollection(values: Array<string | null | undefined>) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizePlaybackTrackId(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function findBestQueueMatchIndex(items: QueueTrackItem[], activeTrackIds: Set<string>) {
  if (!items.length || !activeTrackIds.size) return -1;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const candidates = normalizeTrackIdCollection([item.id, item.uri, ...item.matchTrackIds]);
    if (candidates.some((candidate) => activeTrackIds.has(candidate))) {
      return index;
    }
  }
  return -1;
}

function emitPlaybackDebugEvent(
  event: string,
  payload: Record<string, unknown>
) {
  if (process.env.NODE_ENV === "production") return;
  try {
    console.debug(`[player:${event}]`, payload);
  } catch {
    // ignore logger issues
  }
}

function readSyncServerSeq(payload: any): number {
  const candidate =
    payload?.sync?.serverSeq ??
    payload?.serverSeq ??
    payload?.meta?.serverSeq ??
    0;
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? Math.max(0, Math.floor(candidate))
    : 0;
}

function readSyncServerTime(payload: any): number {
  const candidate =
    payload?.sync?.serverTime ??
    payload?.serverTime ??
    payload?.meta?.serverTime ??
    payload?.timestamp ??
    Date.now();
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? Math.max(0, Math.floor(candidate))
    : Date.now();
}

function ActiveTrackIndicator({
  status,
  isStale,
}: {
  status: PlaybackFocusStatus;
  isStale: boolean;
}) {
  const ariaLabel =
    status === "playing"
      ? "Now playing"
      : status === "paused"
      ? "Gepauzeerd"
      : status === "loading"
      ? "Buffering"
      : status === "ended"
      ? "Track beëindigd"
      : status === "error"
      ? "Playback fout"
      : "Actieve track";
  return (
    <span
      className={`playing-indicator ${status}${isStale ? " stale" : ""}`}
      aria-label={ariaLabel}
    >
      {status === "playing" ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className="playing-indicator-icon equalizer"
        >
          <rect x="1" y="7" width="2.2" height="8" rx="1" />
          <rect x="6.1" y="3" width="2.2" height="12" rx="1" />
          <rect x="11.2" y="5.5" width="2.2" height="9.5" rx="1" />
        </svg>
      ) : status === "loading" ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className="playing-indicator-icon spinner"
        >
          <circle cx="8" cy="8" r="5.5" fill="none" strokeWidth="2.2" opacity="0.35" />
          <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" fill="none" strokeWidth="2.2" />
        </svg>
      ) : status === "paused" ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className="playing-indicator-icon"
        >
          <path d="M4.2 3.2h2.6v9.6H4.2zM9.2 3.2h2.6v9.6H9.2z" />
        </svg>
      ) : status === "ended" ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className="playing-indicator-icon"
        >
          <path d="M8 2.2a5.8 5.8 0 1 0 5.65 7.1h-1.8A4.2 4.2 0 1 1 8 3.8c1.1 0 2.08.42 2.82 1.1L8.9 6.82h4.9v-4.9l-1.74 1.74A5.73 5.73 0 0 0 8 2.2Z" />
        </svg>
      ) : status === "error" ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className="playing-indicator-icon"
        >
          <path d="M8 1.8 1.6 13.6h12.8L8 1.8Zm-.8 4.1h1.6v4.3H7.2V5.9Zm0 5.3h1.6v1.6H7.2v-1.6Z" />
        </svg>
      ) : (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className="playing-indicator-icon"
        >
          <path d="M4.4 3.2v9.6l8-4.8-8-4.8Z" />
        </svg>
      )}
    </span>
  );
}

function resolveDeviceTypeIcon(type: string | null | undefined) {
  const raw = String(type ?? "").trim().toLowerCase();
  if (!raw) return "🎵";
  if (raw.includes("smartphone") || raw.includes("phone") || raw.includes("tablet")) {
    return "📱";
  }
  if (raw.includes("computer") || raw.includes("webplayer") || raw.includes("desktop")) {
    return "💻";
  }
  if (raw.includes("speaker") || raw.includes("castaudio")) {
    return "🔊";
  }
  if (raw.includes("headphone") || raw.includes("headset")) {
    return "🎧";
  }
  if (raw.includes("tv") || raw.includes("stb") || raw.includes("console")) {
    return "📺";
  }
  if (raw.includes("avr") || raw.includes("receiver")) {
    return "📻";
  }
  if (raw.includes("audiodongle") || raw.includes("dongle")) {
    return "🎛️";
  }
  return "🎵";
}

export default function SpotifyPlayer({
  onReady,
  onTrackChange,
  onPlaybackFocusChange,
  controller,
  onControllerHandlersChange,
  onControllerRuntimeChange,
}: PlayerProps) {
  const { data: session, status: sessionStatus } = useSession();
  const customQueue = useQueueStore();
  const customQueuePlayback = useQueuePlayback();
  const accessToken = session?.accessToken as string | undefined;
  const accessTokenExpiresAt = session?.expiresAt as number | undefined;
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
  const [playbackFocusState, setPlaybackFocusState] =
    useState<PlaybackFocus>(DEFAULT_PLAYBACK_FOCUS);
  const [currentTrackLiked, setCurrentTrackLiked] = useState<boolean | null>(null);
  const [likedStateLoading, setLikedStateLoading] = useState(false);
  const [likedStateSaving, setLikedStateSaving] = useState(false);
  const [trackPlaylistMenuOpen, setTrackPlaylistMenuOpen] = useState(false);
  const [trackPlaylistMembershipOpen, setTrackPlaylistMembershipOpen] = useState(false);
  const [trackPlaylistOptions, setTrackPlaylistOptions] = useState<PlayerPlaylistOption[]>([
    { id: PLAYER_LIKED_PLAYLIST_ID, name: "Liked Songs", type: "liked" },
  ]);
  const [trackPlaylistSelectedIds, setTrackPlaylistSelectedIds] = useState<Set<string>>(
    () => new Set()
  );
  const [trackPlaylistInitialIds, setTrackPlaylistInitialIds] = useState<Set<string>>(
    () => new Set()
  );
  const [trackPlaylistLoading, setTrackPlaylistLoading] = useState(false);
  const [trackPlaylistSaving, setTrackPlaylistSaving] = useState(false);
  const [trackPlaylistActionKey, setTrackPlaylistActionKey] = useState<string | null>(null);
  const [trackPlaylistPopoverStyle, setTrackPlaylistPopoverStyle] = useState<
    CSSProperties | undefined
  >(undefined);
  const [shuffleOn, setShuffleOn] = useState(false);
  const [shufflePending, setShufflePending] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [scrubPositionMs, setScrubPositionMs] = useState<number | null>(null);
  const [scrubActive, setScrubActive] = useState(false);
  const [volume, setVolume] = useState(0.5);
  const [muted, setMuted] = useState(false);
  const [repeatMode, setRepeatMode] = useState<"off" | "context" | "track">("off");
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueItems, setQueueItems] = useState<QueueTrackItem[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [queueActiveTrackErrorVisible, setQueueActiveTrackErrorVisible] = useState(false);
  const [devices, setDevices] = useState<
    {
      id: string;
      name: string;
      isActive: boolean;
      type: string;
      isRestricted?: boolean;
      isPrivateSession?: boolean;
      supportsVolume?: boolean;
      selectable?: boolean;
      unavailableReason?: string | null;
    }[]
  >([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [activeDeviceName, setActiveDeviceName] = useState<string | null>(null);
  const [activeDeviceRestricted, setActiveDeviceRestricted] = useState(false);
  const [activeDevicePrivateSession, setActiveDevicePrivateSession] = useState(false);
  const [activeDeviceSupportsVolume, setActiveDeviceSupportsVolume] = useState(true);
  const [connectConflict, setConnectConflict] = useState<string | null>(null);
  const [playbackDisallows, setPlaybackDisallows] = useState<Record<string, boolean>>({});
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
  const [connectSelectorOpen, setConnectSelectorOpen] = useState(false);
  const [playbackBootState, setPlaybackBootState] = useState<
    "idle" | "booting" | "sdk_ready" | "device_ready" | "playable" | "playing"
  >("idle");
  const [connectDockPinned, setConnectDockPinned] = useState(false);
  const [connectDockHovered, setConnectDockHovered] = useState(false);
  const [connectDockManualOpen, setConnectDockManualOpen] = useState(false);
  const lastDeviceSelectRef = useRef(0);
  const pendingDeviceIdRef = useRef<string | null>(null);
  const handoffStateRef = useRef<HandoffState>(INITIAL_HANDOFF_STATE);
  const noTrackCounterRef = useRef<NoTrackCounterState>(INITIAL_NO_TRACK_COUNTER);
  const preferSdkDeviceRef = useRef(true);
  const lastConfirmedActiveDeviceRef = useRef<{ id: string; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playbackTouched, setPlaybackTouched] = useState(false);
  const [, setOptimisticTrack] = useState<{
    name: string;
    artists: string;
    album: string;
    coverUrl: string | null;
  } | null>(null);
  const [playPauseOptimisticPaused, setPlayPauseOptimisticPaused] = useState<
    boolean | null
  >(null);
  const [liveTrackUiGraceVisible, setLiveTrackUiGraceVisible] = useState(false);
  const playerRef = useRef<any>(null);
  const playerCardRef = useRef<HTMLDivElement | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const accessTokenRef = useRef<string | undefined>(accessToken);
  const accessTokenExpiresAtRef = useRef<number | null>(
    typeof accessTokenExpiresAt === "number" ? accessTokenExpiresAt : null
  );
  const sdkDeviceIdRef = useRef<string | null>(null);
  const activeDeviceIdRef = useRef<string | null>(null);
  const activeDeviceNameRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  const rateLimitRef = useRef({ until: 0, backoffMs: 5000 });
  const lastRequestAtRef = useRef(0);
  const lastSyncStartedAtRef = useRef(0);
  const syncInFlightRef = useRef(false);
  const lastDevicesRefreshRef = useRef(0);
  const lastDevicesPlaybackFetchRef = useRef(0);
  const playbackRestrictionUntilRef = useRef(0);
  const lastSdkEventAtRef = useRef(0);
  const sdkReadyRef = useRef(false);
  const seekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isScrubbingRef = useRef(false);
  const scrubbingByPointerRef = useRef(false);
  const scrubPositionRef = useRef<number | null>(null);
  const seekRequestSeqRef = useRef(0);
  const lastUserSeekAtRef = useRef(0);
  const lastUserVolumeAtRef = useRef(0);
  const lastNonZeroVolumeRef = useRef(0.5);
  const likedCacheRef = useRef<Map<string, boolean>>(new Map());
  const likedRequestIdRef = useRef(0);
  const trackPlaylistOptionsLoadedRef = useRef(false);
  const trackPlaylistRequestIdRef = useRef(0);
  const trackPlaylistWasOpenRef = useRef(false);
  const lastSdkStateRef = useRef<any>(null);
  const playPauseOptimisticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveTrackUiGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const connectDockOpenDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectDockCloseDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueActiveTrackErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueListRef = useRef<HTMLDivElement | null>(null);
  const queueRowRefsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const lastQueueAutoScrollRef = useRef<{ key: string | null; index: number }>({
    key: null,
    index: -1,
  });
  const [deviceReady, setDeviceReady] = useState(false);
  const { enqueue: enqueueCommand, busy: commandBusy } = usePlaybackCommandQueue();
  const lastCommandAtRef = useRef(0);
  const playbackRecoveryRef = useRef(false);
  const playerApiRef = useRef<PlayerApi | null>(null);
  const publishedPlayerHandlersRef = useRef<PlayerApi | null>(null);
  const playIntentReplayRef = useRef(false);
  const pendingPlayIntentRef = useRef<DeferredPlayIntent | null>(null);
  const pendingPlayIntentProcessingRef = useRef(false);
  const [pendingPlayIntentVersion, setPendingPlayIntentVersion] = useState(0);
  const deviceMenu = useStableMenu<HTMLDivElement>({
    onClose: () => setDeviceMenuOpen(false),
  });
  const trackPlaylistMenu = useStableMenu<HTMLDivElement>({
    onClose: () => {
      setTrackPlaylistMenuOpen(false);
      setTrackPlaylistMembershipOpen(false);
    },
  });

  function formatPlayerError(message?: string | null) {
    if (!message) return null;
    const normalized = normalizePlayerError({ message });
    if (normalized.code !== "UNKNOWN") {
      return getPlayerErrorMessage(normalized.code, {
        retryAfterSec: normalized.retryAfterSec,
      });
    }
    const lower = String(message).toLowerCase();
    if (lower.includes("invalid token scopes") || lower.includes("insufficient_scope")) {
      return "Missing Spotify permissions. Reconnect.";
    }
    if (lower.includes("403")) {
      return "Missing Spotify permissions. Reconnect.";
    }
    if (lower.includes("401")) {
      return "Spotify session expired. Reconnect.";
    }
    if (lower.includes("authentication") || lower.includes("token")) {
      return "Connection to Spotify expired. Reconnect.";
    }
    if (lower.includes("premium")) {
      return "Spotify Premium is required for Web Playback.";
    }
    return message;
  }

  function formatPlaybackBootStateLabel(
    state: "idle" | "booting" | "sdk_ready" | "device_ready" | "playable" | "playing"
  ) {
    if (state === "booting") return "Player is starting";
    if (state === "sdk_ready") return "Player ready, waiting for device";
    if (state === "device_ready") return "Device is activating";
    if (state === "playable") return "Ready to play";
    if (state === "playing") return "Playback active";
    return "Waiting for session";
  }

  const playerErrorMessage = formatPlayerError(error);
  const lastTrackIdRef = useRef<string | null>(null);
  const pendingTrackIdRef = useRef<string | null>(null);
  const currentTrackIdRef = useRef<string | null>(null);
  const lastQueueActiveTrackIdRef = useRef<string | null>(null);
  const lastQueueActiveTrackSeenAtRef = useRef(0);
  const lastQueueUiStatusRef = useRef<PlaybackFocusStatus>("idle");
  const lastQueueFocusIdRef = useRef<string | null>(null);
  const hasConfirmedLivePlaybackRef = useRef(false);
  const playbackFocusRef = useRef<PlaybackFocus>(DEFAULT_PLAYBACK_FOCUS);
  const operationEpochRef = useRef(0);
  const playbackSyncStateRef = useRef<PlaybackSyncState>(INITIAL_PLAYBACK_SYNC_STATE);
  const authorityModeRef = useRef<PlaybackAuthorityMode>("degraded");
  const [authorityModeState, setAuthorityModeState] =
    useState<PlaybackAuthorityMode>("degraded");
  const deviceEpochRef = useRef(0);
  const playbackVersionRef = useRef<PlaybackVersion>(INITIAL_PLAYBACK_VERSION);
  const userIntentSeqRef = useRef(0);
  const trackChangeLockUntilRef = useRef(0);
  const lastProgressSyncRef = useRef(0);
  const lastKnownPositionRef = useRef(0);
  const progressAnchorRef = useRef<{ positionMs: number; atMono: number }>({
    positionMs: 0,
    atMono:
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now(),
  });
  const pendingSeekRef = useRef<PendingSeekState | null>(null);
  const rttEwmaMsRef = useRef(220);
  const seekRollbackTimeoutMsRef = useRef(SEEK_ROLLBACK_TIMEOUT_MS);
  const playbackMetricsRef = useRef({
    avgRttMs: 220,
    commandConflicts: 0,
    seekRollbacks: 0,
    lastDriftMs: 0,
  });
  const verifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncPlaybackStateRef = useRef<
    (source?: PlaybackSource, minEpoch?: number) => Promise<void>
  >(async () => undefined);
  const crossTabChannelRef = useRef<BroadcastChannel | null>(null);
  const lastRemoteSyncAtRef = useRef(0);
  const lastStreamSnapshotAtRef = useRef(0);
  const lastPlaybackSnapshotAtRef = useRef(0);
  const lastPlayableTrackSeenAtRef = useRef(0);
  const deviceSwitchSyncBoostUntilRef = useRef(0);
  const lastRemoteIntentSeqRef = useRef(0);
  const lastRafPaintMonoRef = useRef(0);
  const durationMsRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const playerCleanupRef = useRef<(() => void) | null>(null);
  const autoBootAttemptedRef = useRef(false);
  const remoteTakeoverCandidateRef = useRef<{
    deviceId: string;
    firstSeenAt: number;
    samples: number;
  } | null>(null);

  const updatePlaybackFocus = useCallback(
    (
      next: {
        trackId?: string | null;
        matchTrackIds?: string[] | null;
        isPlaying?: boolean | null;
        status?: PlaybackFocusStatus;
        stale?: boolean;
        source: PlaybackSource | PlaybackFocusSource;
        confidence?: number;
        positionMs?: number;
        durationMs?: number;
        errorMessage?: string | null;
        updatedAt?: number;
      }
    ) => {
      const nextTrackId = next.trackId ?? null;
      const nextMatchTrackIds = Array.isArray(next.matchTrackIds)
        ? next.matchTrackIds
        : [];
      const normalizedMatchTrackIds: string[] = [];
      const seen = new Set<string>();
      const pushMatchId = (value: unknown) => {
        const id = normalizePlaybackTrackId(value);
        if (!id || seen.has(id)) return;
        seen.add(id);
        normalizedMatchTrackIds.push(id);
      };
      for (const value of nextMatchTrackIds) {
        pushMatchId(value);
      }
      pushMatchId(nextTrackId);

      const normalized: PlaybackFocus = {
        trackId: nextTrackId,
        matchTrackIds: normalizedMatchTrackIds,
        isPlaying: typeof next.isPlaying === "boolean" ? next.isPlaying : null,
        status: resolvePlaybackFocusStatus(
          next.status,
          typeof next.isPlaying === "boolean" ? next.isPlaying : null,
          Boolean(nextTrackId)
        ),
        stale: Boolean(next.stale),
        source: next.source,
        confidence: Math.max(0, Math.min(1, Number(next.confidence ?? 0))),
        positionMs:
          typeof next.positionMs === "number" && Number.isFinite(next.positionMs)
            ? Math.max(0, Math.floor(next.positionMs))
            : 0,
        durationMs:
          typeof next.durationMs === "number" && Number.isFinite(next.durationMs)
            ? Math.max(0, Math.floor(next.durationMs))
            : 0,
        errorMessage:
          typeof next.errorMessage === "string" && next.errorMessage.trim()
            ? next.errorMessage.trim()
            : null,
        updatedAt:
          typeof next.updatedAt === "number" && Number.isFinite(next.updatedAt)
            ? next.updatedAt
            : Date.now(),
      };
      const previous = playbackFocusRef.current;
      const changed =
        previous.trackId !== normalized.trackId ||
        previous.matchTrackIds.length !== normalized.matchTrackIds.length ||
        previous.matchTrackIds.some((value, index) => value !== normalized.matchTrackIds[index]) ||
        previous.isPlaying !== normalized.isPlaying ||
        previous.status !== normalized.status ||
        previous.stale !== normalized.stale ||
        previous.source !== normalized.source ||
        previous.positionMs !== normalized.positionMs ||
        previous.durationMs !== normalized.durationMs ||
        previous.errorMessage !== normalized.errorMessage;
      if (!changed) return;
      emitPlaybackDebugEvent("state_transition", {
        fromStatus: previous.status,
        toStatus: normalized.status,
        fromTrackId: previous.trackId,
        toTrackId: normalized.trackId,
        stale: normalized.stale,
        source: normalized.source,
        updatedAt: normalized.updatedAt,
      });
      playbackFocusRef.current = normalized;
      setPlaybackFocusState(normalized);
      if (onPlaybackFocusChange) {
        onPlaybackFocusChange(normalized);
      }
    },
    [onPlaybackFocusChange]
  );

  const setPlaybackTrackState = useCallback(
    (
      trackId: string | null,
      options?: {
        isPlaying?: boolean | null;
        status?: PlaybackFocusStatus;
        stale?: boolean;
        source?: PlaybackSource | PlaybackFocusSource;
        confidence?: number;
        positionMs?: number;
        durationMs?: number;
        errorMessage?: string | null;
        updatedAt?: number;
        matchTrackIds?: string[] | null;
      }
    ) => {
      const nextTrackId = trackId ?? null;
      currentTrackIdRef.current = nextTrackId;
      setCurrentTrackIdState(nextTrackId);
      if (onTrackChange) onTrackChange(nextTrackId);
      updatePlaybackFocus({
        trackId: nextTrackId,
        matchTrackIds:
          Array.isArray(options?.matchTrackIds) && options?.matchTrackIds.length > 0
            ? options.matchTrackIds
            : nextTrackId
            ? [nextTrackId]
            : [],
        isPlaying:
          typeof options?.isPlaying === "boolean"
            ? options.isPlaying
            : playbackFocusRef.current.isPlaying,
        status: resolvePlaybackFocusStatus(
          options?.status,
          typeof options?.isPlaying === "boolean"
            ? options.isPlaying
            : playbackFocusRef.current.isPlaying,
          Boolean(nextTrackId)
        ),
        stale: Boolean(options?.stale),
        source: options?.source ?? "system",
        confidence:
          typeof options?.confidence === "number"
            ? options.confidence
            : nextTrackId
            ? 1
            : 0,
        positionMs:
          typeof options?.positionMs === "number"
            ? options.positionMs
            : playbackFocusRef.current.positionMs,
        durationMs:
          typeof options?.durationMs === "number"
            ? options.durationMs
            : playbackFocusRef.current.durationMs,
        errorMessage:
          options?.errorMessage === undefined
            ? playbackFocusRef.current.errorMessage
            : options.errorMessage,
        updatedAt: options?.updatedAt ?? Date.now(),
      });
    },
    [onTrackChange, updatePlaybackFocus]
  );

  useEffect(() => {
    currentTrackIdRef.current = currentTrackIdState;
  }, [currentTrackIdState]);

  useEffect(() => {
    const uiTrackIdCandidate =
      currentTrackIdState || playbackFocusState.trackId || lastTrackIdRef.current;
    const hasLiveTrackSignal =
      Boolean(uiTrackIdCandidate) &&
      playbackFocusState.status !== "idle" &&
      playbackFocusState.status !== "ended" &&
      playbackFocusState.status !== "error";
    if (hasLiveTrackSignal) {
      if (liveTrackUiGraceTimerRef.current) {
        clearTimeout(liveTrackUiGraceTimerRef.current);
        liveTrackUiGraceTimerRef.current = null;
      }
      if (!liveTrackUiGraceVisible) {
        setLiveTrackUiGraceVisible(true);
      }
      return;
    }
    if (!liveTrackUiGraceVisible) return;
    if (liveTrackUiGraceTimerRef.current) {
      clearTimeout(liveTrackUiGraceTimerRef.current);
    }
    liveTrackUiGraceTimerRef.current = setTimeout(() => {
      liveTrackUiGraceTimerRef.current = null;
      setLiveTrackUiGraceVisible(false);
    }, PLAYER_LIVE_TRACK_UI_GRACE_MS);
  }, [
    currentTrackIdState,
    liveTrackUiGraceVisible,
    playbackFocusState.status,
    playbackFocusState.trackId,
  ]);

  useEffect(() => {
    return () => {
      if (liveTrackUiGraceTimerRef.current) {
        clearTimeout(liveTrackUiGraceTimerRef.current);
        liveTrackUiGraceTimerRef.current = null;
      }
    };
  }, []);

  const getMonotonicNow = useCallback(() => {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
    return Date.now();
  }, []);

  const clearPlayPauseOptimisticState = useCallback(() => {
    if (playPauseOptimisticTimerRef.current) {
      clearTimeout(playPauseOptimisticTimerRef.current);
      playPauseOptimisticTimerRef.current = null;
    }
    setPlayPauseOptimisticPaused(null);
  }, []);

  const setPlayPauseOptimisticState = useCallback((paused: boolean) => {
    if (playPauseOptimisticTimerRef.current) {
      clearTimeout(playPauseOptimisticTimerRef.current);
    }
    setPlayPauseOptimisticPaused(paused);
    playPauseOptimisticTimerRef.current = setTimeout(() => {
      playPauseOptimisticTimerRef.current = null;
      setPlayPauseOptimisticPaused(null);
    }, 1800);
  }, []);

  const postCrossTabEvent = useCallback((payload: Record<string, unknown>) => {
    const channel = crossTabChannelRef.current;
    if (!channel) return;
    try {
      channel.postMessage(payload);
    } catch {
      // ignore channel failures
    }
  }, []);

  const emitPlaybackMetric = useCallback(
    (name: string, value: number, extra?: Record<string, unknown>) => {
      if (typeof window === "undefined") return;
      window.dispatchEvent(
        new CustomEvent("gs-playback-metric", {
          detail: {
            name,
            value,
            at: Date.now(),
            ...extra,
          },
        })
      );
    },
    []
  );

  const refreshAuthorityMode = useCallback(
    (reason: string, snapshotDeviceId?: string | null) => {
      const activeDevice = activeDeviceIdRef.current || deviceIdRef.current || null;
      const nextMode = resolvePlaybackAuthorityMode({
        activeDeviceId: activeDevice,
        sdkDeviceId: sdkDeviceIdRef.current,
        pendingDeviceId: pendingDeviceIdRef.current,
        snapshotDeviceId: snapshotDeviceId ?? null,
        sdkReady: sdkReadyRef.current,
      });
      const previousMode = authorityModeRef.current;
      if (previousMode === nextMode) {
        return nextMode;
      }
      authorityModeRef.current = nextMode;
      setAuthorityModeState(nextMode);
      emitPlaybackDebugEvent("authority_mode_changed", {
        reason,
        from: previousMode,
        to: nextMode,
        activeDevice,
        sdkDeviceId: sdkDeviceIdRef.current,
        pendingDeviceId: pendingDeviceIdRef.current,
        snapshotDeviceId: snapshotDeviceId ?? null,
      });
      emitPlaybackMetric("authority_mode_change", 1, {
        from: previousMode,
        to: nextMode,
        reason,
      });
      return nextMode;
    },
    [emitPlaybackMetric]
  );

  const setHandoffPhase = useCallback(
    (
      phase: HandoffPhase,
      reason: string,
      options?: { targetDeviceId?: string | null; updatedAt?: number }
    ) => {
      const next: HandoffState = {
        phase,
        targetDeviceId:
          options?.targetDeviceId === undefined
            ? handoffStateRef.current.targetDeviceId
            : options.targetDeviceId ?? null,
        updatedAt:
          typeof options?.updatedAt === "number" ? options.updatedAt : Date.now(),
        reason,
      };
      const previous = handoffStateRef.current;
      if (
        previous.phase === next.phase &&
        previous.targetDeviceId === next.targetDeviceId &&
        previous.reason === next.reason
      ) {
        return;
      }
      handoffStateRef.current = next;
      emitPlaybackDebugEvent("handoff_phase_change", {
        from: previous.phase,
        to: next.phase,
        reason,
        targetDeviceId: next.targetDeviceId,
      });
      emitPlaybackMetric("handoff_phase_change", 1, {
        from: previous.phase,
        to: next.phase,
        reason,
        targetDeviceId: next.targetDeviceId,
      });
    },
    [emitPlaybackMetric]
  );

  const clearPendingDevice = useCallback(
    (reason: string, snapshotDeviceId?: string | null) => {
      const pendingId = pendingDeviceIdRef.current;
      if (!pendingId) return;
      pendingDeviceIdRef.current = null;
      refreshAuthorityMode(reason, snapshotDeviceId ?? pendingId);
      emitPlaybackDebugEvent("pending_device_cleared", {
        reason,
        pendingDeviceId: pendingId,
      });
      emitPlaybackMetric("pending_device_cleared", 1, {
        reason,
        pendingDeviceId: pendingId,
      });
    },
    [emitPlaybackMetric, refreshAuthorityMode]
  );

  const resetNoTrackCounter = useCallback((reason: string) => {
    const current = noTrackCounterRef.current;
    if (current.count <= 0) return;
    noTrackCounterRef.current = { ...INITIAL_NO_TRACK_COUNTER };
    emitPlaybackDebugEvent("no_track_counter_reset", {
      reason,
      previousCount: current.count,
      lastSource: current.lastSource,
      lastDeviceId: current.lastDeviceId,
    });
  }, []);

  const recordNoTrackEvent = useCallback(
    (
      source: PlaybackSource | PlaybackFocusSource,
      snapshotDeviceId?: string | null,
      atMs = Date.now()
    ) => {
      const prev = noTrackCounterRef.current;
      const nextCount = prev.count + 1;
      const next: NoTrackCounterState = {
        count: nextCount,
        firstAt: prev.firstAt || atMs,
        lastAt: atMs,
        lastSource: source,
        lastDeviceId: snapshotDeviceId ?? null,
      };
      noTrackCounterRef.current = next;
      emitPlaybackDebugEvent("no_track_event", {
        count: next.count,
        source,
        snapshotDeviceId: snapshotDeviceId ?? null,
        firstAt: next.firstAt,
        lastAt: next.lastAt,
      });
      return next;
    },
    []
  );

  const bumpDeviceEpoch = useCallback(
    (reason: string, deviceId?: string | null) => {
      deviceEpochRef.current += 1;
      playbackVersionRef.current = {
        ...INITIAL_PLAYBACK_VERSION,
        deviceEpoch: deviceEpochRef.current,
        serverTime: Date.now(),
        receivedMonoMs: Math.floor(getMonotonicNow()),
      };
      playbackSyncStateRef.current = {
        ...INITIAL_PLAYBACK_SYNC_STATE,
        lastAppliedAtMs: Date.now(),
      };
      emitPlaybackDebugEvent("device_epoch_bump", {
        reason,
        deviceId: deviceId ?? null,
        deviceEpoch: deviceEpochRef.current,
      });
      emitPlaybackMetric("device_epoch_bump", 1, {
        reason,
        deviceId: deviceId ?? null,
        deviceEpoch: deviceEpochRef.current,
      });
      return deviceEpochRef.current;
    },
    [emitPlaybackMetric, getMonotonicNow]
  );

  const beginOperationEpoch = useCallback(() => {
    operationEpochRef.current += 1;
    userIntentSeqRef.current = operationEpochRef.current;
    postCrossTabEvent({
      type: "intent",
      seq: operationEpochRef.current,
      at: Date.now(),
    });
    return operationEpochRef.current;
  }, [postCrossTabEvent]);

  const clampProgressMs = useCallback((nextMs: number) => {
    return clampProgressValue(nextMs, durationMsRef.current);
  }, []);

  const applyProgressPosition = useCallback(
    (nextMs: number, atMono = getMonotonicNow()) => {
      const clamped = clampProgressMs(nextMs);
      setPositionMs(clamped);
      lastKnownPositionRef.current = clamped;
      progressAnchorRef.current = { positionMs: clamped, atMono };
      return clamped;
    },
    [clampProgressMs, getMonotonicNow]
  );

  const reconcileProgressPosition = useCallback(
    (localMs: number, remoteMs: number, hardSync = false) => {
      const nextRemote = clampProgressMs(remoteMs);
      const nextLocal = clampProgressMs(localMs);
      return clampProgressMs(
        reconcileProgressValue(
          nextLocal,
          nextRemote,
          PROGRESS_DEADBAND_MS,
          PROGRESS_MAX_STEP_MS,
          hardSync
        )
      );
    },
    [clampProgressMs]
  );

  const projectRemoteProgressMs = useCallback(
    (
      progressMs: number,
      isPlaying: boolean,
      timestampMs?: number | null,
      requestStartedAtWallMs?: number,
      responseReceivedAtWallMs?: number
    ) => {
      const base = clampProgressMs(progressMs);
      const responseWallMs = responseReceivedAtWallMs ?? Date.now();
      return clampProgressMs(
        projectRemoteProgressValue(
          base,
          isPlaying,
          timestampMs,
          requestStartedAtWallMs,
          responseWallMs
        )
      );
    },
    [clampProgressMs]
  );

  const applyPendingSeekGuard = useCallback(
    (incomingMs: number, incomingMonoMs: number) => {
      const pending = pendingSeekRef.current;
      if (!pending) {
        return { positionMs: clampProgressMs(incomingMs), hardSync: false };
      }
      if (pending.epoch < operationEpochRef.current) {
        pendingSeekRef.current = null;
        return { positionMs: clampProgressMs(incomingMs), hardSync: false };
      }
      const targetMs = clampProgressMs(pending.targetMs);
      const incoming = clampProgressMs(incomingMs);
      if (Math.abs(incoming - targetMs) <= SEEK_CONFIRM_TOLERANCE_MS) {
        pendingSeekRef.current = null;
        return { positionMs: targetMs, hardSync: true };
      }
      if (incomingMonoMs - pending.startedMonoMs > seekRollbackTimeoutMsRef.current) {
        playbackMetricsRef.current.seekRollbacks += 1;
        emitPlaybackMetric("seek_rollback", 1, {
          total: playbackMetricsRef.current.seekRollbacks,
          timeoutMs: seekRollbackTimeoutMsRef.current,
        });
        pendingSeekRef.current = null;
        return { positionMs: clampProgressMs(pending.previousMs), hardSync: true };
      }
      return { positionMs: targetMs, hardSync: true };
    },
    [clampProgressMs, emitPlaybackMetric]
  );

  const schedulePlaybackVerify = useCallback(
    (delayMs = 220, source: PlaybackSource = "api_verify", minEpoch?: number) => {
      if (verifyTimerRef.current) clearTimeout(verifyTimerRef.current);
      const epoch = typeof minEpoch === "number" ? minEpoch : operationEpochRef.current;
      verifyTimerRef.current = setTimeout(() => {
        syncPlaybackStateRef.current(source, epoch).catch(() => undefined);
      }, Math.max(0, delayMs));
    },
    []
  );

  const setScrubPreview = useCallback((nextMs: number | null) => {
    scrubPositionRef.current = nextMs;
    setScrubPositionMs(nextMs);
  }, []);

  const clearPlaybackViewState = useCallback(
    (
      receivedAtMonoMs = getMonotonicNow(),
      source: PlaybackSource | PlaybackFocusSource = "system",
      isPlaying: boolean | null = null
    ) => {
      const pendingId = pendingDeviceIdRef.current;
      const handoffPhase = handoffStateRef.current.phase;
      if (
        pendingId &&
        (handoffPhase === "requested" || handoffPhase === "device_ready")
      ) {
        clearPendingDevice("handoff_no_track_hard_clear", pendingId);
        setHandoffPhase("failed", "handoff_no_track_hard_clear", {
          targetDeviceId: pendingId,
        });
      }
      hasConfirmedLivePlaybackRef.current = false;
      lastTrackIdRef.current = null;
      pendingTrackIdRef.current = null;
      noTrackCounterRef.current = { ...INITIAL_NO_TRACK_COUNTER };
      setOptimisticTrack(null);
      setPlayerState(null);
      setPlaybackTrackState(null, {
        isPlaying,
        status:
          typeof isPlaying === "boolean" ? (isPlaying ? "playing" : "paused") : "ended",
        stale: false,
        source,
        confidence: 0,
        positionMs: 0,
        durationMs: 0,
        errorMessage: null,
        updatedAt: Date.now(),
      });
      setDurationMs(0);
      if (!isScrubbingRef.current) {
        applyProgressPosition(0, receivedAtMonoMs);
      }
    },
    [
      applyProgressPosition,
      clearPendingDevice,
      getMonotonicNow,
      setHandoffPhase,
      setPlaybackTrackState,
    ]
  );

  const beginScrub = useCallback(
    (pointerDriven = false) => {
      isScrubbingRef.current = true;
      scrubbingByPointerRef.current = pointerDriven;
      setScrubActive(true);
      const seed = scrubPositionRef.current ?? lastKnownPositionRef.current;
      setScrubPreview(clampProgressMs(seed));
    },
    [clampProgressMs, setScrubPreview]
  );

  const updateScrub = useCallback(
    (nextMs: number) => {
      setScrubPreview(clampProgressMs(nextMs));
    },
    [clampProgressMs, setScrubPreview]
  );

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
  const enablePlaybackStream = useMemo(
    () => process.env.NEXT_PUBLIC_SPOTIFY_CONNECT_STREAM === "1",
    []
  );
  const { isLeader: isPlaybackLeader } = usePlaybackLeader(Boolean(accessToken));
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
        setSdkLastError("Local web player could not connect.");
      }
    } catch {
      setSdkLastError("Local web player could not connect.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseSdk]);
  const isCustomQueueActive =
    customQueue.mode === "queue" && customQueue.items.length > 0;
  const isCurrentTrackFromCustomQueue = useMemo(() => {
    if (!currentTrackIdState) return false;
    return customQueue.items.some((item) => item.trackId === currentTrackIdState);
  }, [currentTrackIdState, customQueue.items]);
  const activeTrackIdsOrdered = useMemo(
    () =>
      normalizeTrackIdCollection([
        ...(Array.isArray(playbackFocusState.matchTrackIds)
          ? playbackFocusState.matchTrackIds
          : []),
        playbackFocusState.trackId,
        currentTrackIdState,
      ]),
    [currentTrackIdState, playbackFocusState.matchTrackIds, playbackFocusState.trackId]
  );
  const activeTrackIdSet = useMemo(
    () => new Set(activeTrackIdsOrdered),
    [activeTrackIdsOrdered]
  );
  const activeQueueTrackStatusRaw: PlaybackFocusStatus = playbackFocusState.status;
  const activeQueueTrackIsStaleRaw = Boolean(playbackFocusState.stale);
  const queueHandoffPending =
    Boolean(pendingDeviceIdRef.current) &&
    Date.now() - lastDeviceSelectRef.current < DEVICE_SELECTION_HOLD_MS;
  const activeQueueTrackTransientGap =
    activeTrackIdSet.size > 0 &&
    (activeQueueTrackIsStaleRaw ||
      queueHandoffPending ||
      commandBusy ||
      activeQueueTrackStatusRaw === "loading" ||
      activeQueueTrackStatusRaw === "idle");
  const activeQueueTrackStatusForProjection: PlaybackFocusStatus =
    activeTrackIdSet.size > 0 &&
    activeQueueTrackStatusRaw === "error" &&
    activeQueueTrackTransientGap
      ? playbackFocusState.isPlaying === false
        ? "paused"
        : "playing"
      : activeQueueTrackStatusRaw;
  useEffect(() => {
    if (!PLAYBACK_FEATURE_FLAGS.delayedActiveTrackErrorIndicator) {
      setQueueActiveTrackErrorVisible(true);
      return;
    }
    const shouldDelayError =
      activeTrackIdSet.size > 0 &&
      activeQueueTrackStatusRaw === "error" &&
      !activeQueueTrackTransientGap;
    if (!shouldDelayError) {
      if (queueActiveTrackErrorTimerRef.current) {
        clearTimeout(queueActiveTrackErrorTimerRef.current);
        queueActiveTrackErrorTimerRef.current = null;
      }
      if (queueActiveTrackErrorVisible) {
        setQueueActiveTrackErrorVisible(false);
      }
      return;
    }
    if (queueActiveTrackErrorVisible || queueActiveTrackErrorTimerRef.current) return;
    const delayMs =
      playbackFocusState.source === "sdk"
        ? QUEUE_ACTIVE_ERROR_VISIBILITY_DELAY_LOCAL_MS
        : QUEUE_ACTIVE_ERROR_VISIBILITY_DELAY_REMOTE_MS;
    queueActiveTrackErrorTimerRef.current = setTimeout(() => {
      queueActiveTrackErrorTimerRef.current = null;
      setQueueActiveTrackErrorVisible(true);
    }, delayMs);
    return () => {
      if (!queueActiveTrackErrorTimerRef.current) return;
      clearTimeout(queueActiveTrackErrorTimerRef.current);
      queueActiveTrackErrorTimerRef.current = null;
    };
  }, [
    activeQueueTrackTransientGap,
    activeQueueTrackStatusRaw,
    activeTrackIdSet.size,
    playbackFocusState.source,
    queueActiveTrackErrorVisible,
  ]);
  const queuePresentation = deriveQueueActivePresentation({
    hasActiveTrack: activeTrackIdSet.size > 0,
    status: activeQueueTrackStatusForProjection,
    isPlaying: playbackFocusState.isPlaying,
    source: playbackFocusState.source,
    stale: activeQueueTrackIsStaleRaw,
    errorVisible: queueActiveTrackErrorVisible,
    commandBusy,
    handoffPending: queueHandoffPending,
    hideLoadingForRemoteActiveTrack:
      PLAYBACK_FEATURE_FLAGS.remoteActiveTrackHideLoadingIndicator,
  });
  const activeQueueTrackStatus: PlaybackFocusStatus = PLAYBACK_FEATURE_FLAGS
    .playbackStatusMatrixV1
    ? queuePresentation.status
    : activeQueueTrackStatusRaw;
  const activeQueueTrackIsStale = queuePresentation.stale;
  const playbackExecutionMode = resolvePlaybackExecutionMode({
    activeDeviceId: activeDeviceId || deviceId || null,
    sdkDeviceId: sdkDeviceIdRef.current,
    pendingDeviceId: pendingDeviceIdRef.current,
    sdkReady: sdkReadyState,
  });
  const { shouldOwnPlaybackSync, shouldRunPlaybackStream } =
    resolvePlaybackSyncOwnership({
      executionMode: playbackExecutionMode,
      isLeader: isPlaybackLeader,
      activeDeviceId: activeDeviceId || deviceId || null,
      sdkDeviceId: sdkDeviceIdRef.current,
    });
  useEffect(() => {
    if (!PLAYBACK_FEATURE_FLAGS.playbackUiTelemetryV1) return;
    if (lastQueueUiStatusRef.current === activeQueueTrackStatus) return;
    emitPlaybackUiMetric("status_transition", {
      context: "queue",
      from: lastQueueUiStatusRef.current,
      to: activeQueueTrackStatus,
      source: playbackFocusState.source,
    });
    lastQueueUiStatusRef.current = activeQueueTrackStatus;
  }, [activeQueueTrackStatus, playbackFocusState.source]);
  const queueDisplayItems = useMemo(() => {
    if (!queueItems.length) return [];
    const fallbackActiveId = lastQueueActiveTrackIdRef.current;
    const fallbackFresh =
      Date.now() - lastQueueActiveTrackSeenAtRef.current <=
      QUEUE_ACTIVE_FALLBACK_MAX_AGE_MS;
    const hasKnownActiveTrack = activeTrackIdSet.size > 0;
    const allowHistoricalFallback =
      !hasKnownActiveTrack || activeQueueTrackTransientGap;
    const indexed = queueItems.map((item, index) => ({
      ...item,
      _index: index,
      _normalizedId:
        normalizePlaybackTrackId(item.id) ??
        normalizeTrackIdCollection([item.uri, ...item.matchTrackIds])[0] ??
        null,
    }));

    let activeIndex = findBestQueueMatchIndex(indexed, activeTrackIdSet);
    if (
      activeIndex < 0 &&
      fallbackActiveId &&
      fallbackFresh &&
      allowHistoricalFallback
    ) {
      activeIndex = indexed.findIndex(
        (item) => Boolean(item._normalizedId) && item._normalizedId === fallbackActiveId
      );
    }
    if (activeIndex < 0 && allowHistoricalFallback) {
      activeIndex = indexed.findIndex((item) => item.isCurrent);
    }

    if (activeIndex >= 0) {
      const activeNormalizedId = indexed[activeIndex]?._normalizedId;
      if (activeNormalizedId) {
        lastQueueActiveTrackIdRef.current = activeNormalizedId;
        lastQueueActiveTrackSeenAtRef.current = Date.now();
      }
    } else if (hasKnownActiveTrack && !activeQueueTrackTransientGap) {
      lastQueueActiveTrackIdRef.current = null;
      lastQueueActiveTrackSeenAtRef.current = 0;
    }

    const marked = indexed.map((item, index) => ({
      ...item,
      isCurrent: activeIndex >= 0 && index === activeIndex,
    }));
    return marked;
  }, [activeQueueTrackTransientGap, activeTrackIdSet, queueItems]);
  const activeQueueDisplayIndex = useMemo(
    () => queueDisplayItems.findIndex((item) => item.isCurrent),
    [queueDisplayItems]
  );
  const activeQueueDisplayKey =
    activeQueueDisplayIndex >= 0
      ? `${queueDisplayItems[activeQueueDisplayIndex]?.id ?? "queue"}:${
          queueDisplayItems[activeQueueDisplayIndex]?.uri ?? "nouri"
        }`
      : null;
  useEffect(() => {
    if (!queueOpen) return;
    if (activeQueueDisplayIndex < 0) return;
    const listEl = queueListRef.current;
    if (!listEl) return;
    if (
      lastQueueAutoScrollRef.current.key === activeQueueDisplayKey &&
      lastQueueAutoScrollRef.current.index === activeQueueDisplayIndex
    ) {
      return;
    }
    lastQueueAutoScrollRef.current = {
      key: activeQueueDisplayKey,
      index: activeQueueDisplayIndex,
    };
    window.requestAnimationFrame(() => {
      const rowEl = queueRowRefsRef.current.get(activeQueueDisplayIndex) ?? null;
      if (!rowEl) return;
      const targetTop = Math.max(0, rowEl.offsetTop - 8);
      animateScrollTop(listEl, targetTop, {
        minDurationMs: 360,
        maxDurationMs: 1100,
        pxPerMs: 1.5,
      });
      emitPlaybackUiMetric("scroll_to_active_track", {
        context: "queue",
        index: activeQueueDisplayIndex,
      });
    });
  }, [activeQueueDisplayIndex, activeQueueDisplayKey, queueOpen]);
  useEffect(() => {
    if (!PLAYBACK_FEATURE_FLAGS.playbackUiTelemetryV1) return;
    const nextId = activeQueueDisplayKey;
    if (!nextId || lastQueueFocusIdRef.current === nextId) return;
    emitPlaybackUiMetric("track_focus_changed", {
      context: "queue",
      key: nextId,
    });
    lastQueueFocusIdRef.current = nextId;
  }, [activeQueueDisplayKey]);
  const selectableDevicesCount = useMemo(
    () => devices.filter((device) => device.selectable).length,
    [devices]
  );
  const activeConnectDevice = useMemo(() => {
    const currentId = activeDeviceId || deviceId;
    const found = currentId ? devices.find((device) => device.id === currentId) : null;
    const name =
      (found?.name && found.name.trim()) ||
      (activeDeviceName && activeDeviceName.trim()) ||
      "No active device";
    const type = found?.type ?? null;
    return {
      name,
      icon: resolveDeviceTypeIcon(type),
    };
  }, [activeDeviceId, activeDeviceName, deviceId, devices]);
  const connectDockOpen =
    connectDockPinned ||
    connectDockManualOpen ||
    connectDockHovered ||
    connectSelectorOpen ||
    deviceMenuOpen;

  const clampTrackPlaylistPopoverToPlayer = useCallback(() => {
    if (typeof window === "undefined") return;
    const anchorEl = trackPlaylistMenu.rootRef.current;
    const cardEl = playerCardRef.current;
    if (!anchorEl || !cardEl) {
      setTrackPlaylistPopoverStyle(undefined);
      return;
    }

    const anchorRect = anchorEl.getBoundingClientRect();
    const cardRect = cardEl.getBoundingClientRect();
    const viewportWidth = Math.max(0, window.innerWidth || 0);
    if (viewportWidth <= 0 || cardRect.width <= 0 || anchorRect.width <= 0) {
      setTrackPlaylistPopoverStyle(undefined);
      return;
    }

    const viewportGutter = 8;
    const cardGutter = 10;
    const cardMaxWidth = Math.max(180, Math.floor(cardRect.width - cardGutter * 2));
    const viewportMaxWidth = Math.max(
      180,
      Math.floor(viewportWidth - viewportGutter * 2)
    );
    const resolvedWidth = Math.max(
      220,
      Math.min(560, cardMaxWidth, viewportMaxWidth)
    );

    const minLeft = Math.max(viewportGutter, cardRect.left + cardGutter);
    const maxLeft = Math.min(
      viewportWidth - viewportGutter - resolvedWidth,
      cardRect.right - cardGutter - resolvedWidth
    );
    const wantedLeft = anchorRect.left;
    const clampedLeft =
      maxLeft >= minLeft
        ? Math.min(Math.max(wantedLeft, minLeft), maxLeft)
        : minLeft;
    const relativeLeft = Math.round(clampedLeft - anchorRect.left);

    setTrackPlaylistPopoverStyle({
      left: `${relativeLeft}px`,
      right: "auto",
      width: `${Math.round(resolvedWidth)}px`,
      maxWidth: `${Math.round(resolvedWidth)}px`,
    });
  }, [trackPlaylistMenu.rootRef]);

  useEffect(() => {
    if (!trackPlaylistMenuOpen && !trackPlaylistMembershipOpen) {
      setTrackPlaylistPopoverStyle(undefined);
      return;
    }
    if (typeof window === "undefined") return;

    const recalc = () => {
      clampTrackPlaylistPopoverToPlayer();
    };

    const rafId = window.requestAnimationFrame(recalc);
    window.addEventListener("resize", recalc, { passive: true });
    window.addEventListener("orientationchange", recalc);
    window.addEventListener("scroll", recalc, { passive: true });
    window.visualViewport?.addEventListener("resize", recalc, { passive: true });
    window.visualViewport?.addEventListener("scroll", recalc, { passive: true });

    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(recalc) : null;
    if (observer && playerCardRef.current) observer.observe(playerCardRef.current);
    if (observer && trackPlaylistMenu.rootRef.current) {
      observer.observe(trackPlaylistMenu.rootRef.current);
    }

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", recalc);
      window.removeEventListener("orientationchange", recalc);
      window.removeEventListener("scroll", recalc);
      window.visualViewport?.removeEventListener("resize", recalc);
      window.visualViewport?.removeEventListener("scroll", recalc);
      observer?.disconnect();
    };
  }, [
    clampTrackPlaylistPopoverToPlayer,
    trackPlaylistMembershipOpen,
    trackPlaylistMenuOpen,
    trackPlaylistMenu.rootRef,
  ]);

  useEffect(() => {
    playerStateRef.current = playerState;
  }, [playerState]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(CONNECT_DOCK_PIN_KEY);
      if (stored === "1") {
        setConnectDockPinned(true);
      } else if (stored === "0") {
        setConnectDockPinned(false);
      }
    } catch {
      // ignore storage issues
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(CONNECT_DOCK_PIN_KEY, connectDockPinned ? "1" : "0");
    } catch {
      // ignore storage issues
    }
  }, [connectDockPinned]);

  useEffect(() => {
    if (!connectDockOpen) {
      setConnectSelectorOpen(false);
      setDeviceMenuOpen(false);
    }
  }, [connectDockOpen]);

  useEffect(() => {
    return () => {
      if (connectDockOpenDelayTimerRef.current) {
        clearTimeout(connectDockOpenDelayTimerRef.current);
      }
      if (connectDockCloseDelayTimerRef.current) {
        clearTimeout(connectDockCloseDelayTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    activeDeviceNameRef.current = activeDeviceName;
  }, [activeDeviceName]);

  useEffect(() => {
    refreshAuthorityMode("runtime_state_change");
  }, [activeDeviceId, deviceId, refreshAuthorityMode, sdkReadyState]);

  useEffect(() => {
    if (!onControllerRuntimeChange) return;
    onControllerRuntimeChange({
      deviceId: activeDeviceId || deviceId || null,
      isActiveDevice: Boolean(activeDeviceId || deviceId),
      sdkReady: sdkReadyState,
      mode: playbackExecutionMode,
      lastError: formatPlayerError(error) || sdkLastError || null,
    });
  }, [
    activeDeviceId,
    deviceId,
    error,
    onControllerRuntimeChange,
    playbackExecutionMode,
    sdkLastError,
    sdkReadyState,
  ]);


  useEffect(() => {
    shuffleOnRef.current = shuffleOn;
  }, [shuffleOn]);

  const ownPlaybackSyncRef = useRef(shouldOwnPlaybackSync);
  useEffect(() => {
    ownPlaybackSyncRef.current = shouldOwnPlaybackSync;
  }, [shouldOwnPlaybackSync]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(PLAYBACK_CROSS_TAB_CHANNEL);
    crossTabChannelRef.current = channel;
    channel.onmessage = (event: MessageEvent<PlaybackCrossTabMessage>) => {
      const payload = event.data as PlaybackCrossTabMessage | null;
      if (!payload || typeof payload !== "object") return;
      if (payload.type === "sync" && typeof payload.at === "number") {
        lastRemoteSyncAtRef.current = Math.max(lastRemoteSyncAtRef.current, payload.at);
        return;
      }
      if (payload.type === "intent" && typeof payload.seq === "number") {
        lastRemoteIntentSeqRef.current = Math.max(
          lastRemoteIntentSeqRef.current,
          Math.floor(payload.seq)
        );
        return;
      }
      if (
        payload.type === "snapshot" &&
        typeof payload.at === "number" &&
        payload.snapshot &&
        typeof payload.source === "string"
      ) {
        lastRemoteSyncAtRef.current = Math.max(lastRemoteSyncAtRef.current, payload.at);
        if (ownPlaybackSyncRef.current) return;
        const source =
          payload.source === "api_stream" ||
          payload.source === "api_poll" ||
          payload.source === "api_verify" ||
          payload.source === "api_sync" ||
          payload.source === "api_bootstrap"
            ? payload.source
            : "api_sync";
        const responseReceivedAtWallMs = Date.now();
        const responseReceivedAtMonoMs =
          typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : responseReceivedAtWallMs;
        const requestStartedAtWallMs =
          typeof payload.snapshot.timestamp === "number"
            ? Math.max(0, payload.snapshot.timestamp)
            : responseReceivedAtWallMs;
        ingestCrossTabSnapshotRef.current(payload.snapshot, source, {
          requestStartedAtWallMs,
          responseReceivedAtWallMs,
          responseReceivedAtMonoMs,
        });
      }
    };
    return () => {
      channel.close();
      if (crossTabChannelRef.current === channel) {
        crossTabChannelRef.current = null;
      }
    };
  }, []);

  const applyRateLimit = useCallback((res: Response) => {
    if (res.status !== 429) return false;
    const retry = res.headers.get("Retry-After");
    const parsedRetryMs = retry ? Number(retry) * 1000 : NaN;
    const retryMs =
      Number.isFinite(parsedRetryMs) && parsedRetryMs > 0
        ? Math.min(parsedRetryMs, PLAYER_RETRY_AFTER_MAX_MS)
        : rateLimitRef.current.backoffMs;
    rateLimitRef.current.until = Date.now() + retryMs;
    rateLimitRef.current.backoffMs = Math.min(
      rateLimitRef.current.backoffMs * 2,
      60000
    );
    setError(
      getPlayerErrorMessage("RATE_LIMITED", {
        retryAfterSec: Math.ceil(retryMs / 1000),
      })
    );
    return true;
  }, []);

  const refreshClientAccessToken = useCallback(async (force = false) => {
    try {
      const tokenRes = await fetch(
        force ? "/api/spotify/user-token?force=1" : "/api/spotify/user-token",
        {
          method: "GET",
          cache: "no-store",
          credentials: "include",
        }
      );
      if (tokenRes.ok) {
        const payload = (await tokenRes.json().catch(() => null)) as
          | { accessToken?: string | null; expiresAt?: number | null }
          | null;
        const token =
          typeof payload?.accessToken === "string" ? payload.accessToken.trim() : "";
        if (token) {
          accessTokenRef.current = token;
          accessTokenExpiresAtRef.current =
            typeof payload?.expiresAt === "number" ? payload.expiresAt : null;
          return token;
        }
      }
    } catch {
      // fall through to session fallback
    }

    try {
      const next = await getSession();
      const nextToken = next?.accessToken as string | undefined;
      if (!nextToken) return null;
      accessTokenRef.current = nextToken;
      accessTokenExpiresAtRef.current =
        typeof next?.expiresAt === "number" ? next.expiresAt : null;
      return nextToken;
    } catch {
      return null;
    }
  }, []);

  const spotifyApiFetch = useCallback(
    async (url: string, options?: RequestInit) => {
      let token = accessTokenRef.current;
      if (Date.now() < rateLimitRef.current.until) return null;
      const method = String(options?.method ?? "GET").toUpperCase();
      const playerApiUrl = parseSpotifyPlayerApiUrl(url);
      const isPlayerStateGet =
        method === "GET" && playerApiUrl?.endpoint === "";
      const isPlayerDevicesGet =
        method === "GET" && playerApiUrl?.endpoint === "/devices";
      const playerProxyUrl = isPlayerStateGet
        ? "/api/spotify/me/player?raw=1"
        : isPlayerDevicesGet
        ? "/api/spotify/me/player/devices"
        : null;
      const expectedDeviceId = (() => {
        if (!playerApiUrl || method === "GET") return null;
        if (playerApiUrl.endpoint === "") {
          return (
            activeDeviceIdRef.current || deviceIdRef.current || sdkDeviceIdRef.current || null
          );
        }
        const query = new URLSearchParams(playerApiUrl.search || "");
        const deviceFromQuery = query.get("device_id");
        if (deviceFromQuery) return deviceFromQuery;
        const bodyPayload = extractProxyPayload(options?.body) as
          | { device_ids?: string[] | null }
          | null
          | undefined;
        const bodyDevice =
          Array.isArray(bodyPayload?.device_ids) && bodyPayload.device_ids.length
            ? bodyPayload.device_ids.find((value) => typeof value === "string" && value.trim()) ??
              null
            : null;
        if (bodyDevice) return bodyDevice;
        return (
          activeDeviceIdRef.current || deviceIdRef.current || sdkDeviceIdRef.current || null
        );
      })();
      const commandId =
        method !== "GET" && Boolean(playerApiUrl) ? createCommandId() : null;
      const playerCommandProxyPayload =
        playerApiUrl && !playerProxyUrl
          ? {
              method,
              endpoint: playerApiUrl.endpoint,
              search: playerApiUrl.search,
              payload: extractProxyPayload(options?.body),
              commandId,
              intentSeq: userIntentSeqRef.current,
              expectedDeviceId,
            }
          : null;
      const isPlaybackCommand =
        method !== "GET" && Boolean(playerApiUrl);
      const chaosLevel = Number(process.env.NEXT_PUBLIC_PLAYBACK_CHAOS ?? "0");
      if (!token && !playerCommandProxyPayload && !playerProxyUrl) return null;
      if (isPlaybackCommand && Date.now() < playbackRestrictionUntilRef.current) {
        const retryInSec = Math.max(
          1,
          Math.ceil((playbackRestrictionUntilRef.current - Date.now()) / 1000)
        );
        setError(`Spotify blokkeert dit commando tijdelijk. Probeer opnieuw over ${retryInSec}s.`);
        return null;
      }

      for (let attempt = 1; attempt <= PLAYER_FETCH_MAX_ATTEMPTS; attempt += 1) {
        if (Date.now() < rateLimitRef.current.until) return null;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PLAYER_FETCH_TIMEOUT_MS);
        try {
          if (chaosLevel > 0) {
            const jitterMs = Math.min(800, Math.max(0, chaosLevel * 80));
            if (jitterMs > 0) {
              const delay = Math.floor(Math.random() * (jitterMs + 1));
              if (delay > 0) {
                await new Promise((resolve) => setTimeout(resolve, delay));
              }
            }
            const shouldDrop = Math.random() < Math.min(0.2, chaosLevel * 0.01);
            if (shouldDrop) {
              throw new Error("CHAOS_SIMULATED_NETWORK_DROP");
            }
          }
          const res = playerProxyUrl
            ? await fetch(playerProxyUrl, {
                method: "GET",
                cache: "no-store",
                credentials: "include",
                signal: controller.signal,
              })
            : playerCommandProxyPayload
            ? await fetch("/api/spotify/me/player/command", {
                method: "POST",
                cache: "no-store",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(playerCommandProxyPayload),
                signal: controller.signal,
              })
            : await fetch(url, {
                ...options,
                headers: { Authorization: `Bearer ${token}`, ...options?.headers },
                signal: controller.signal,
              });

          if (applyRateLimit(res)) return null;

          if (res.ok) {
            if (isPlaybackCommand) {
              setConnectConflict(null);
            }
            rateLimitRef.current.backoffMs = 5000;
            return res;
          }

          if (res.status === 401) {
            const refreshed = await refreshClientAccessToken(true);
            if (refreshed) {
              token = refreshed;
              if (attempt < PLAYER_FETCH_MAX_ATTEMPTS) {
                continue;
              }
            }
            setError(getPlayerErrorMessage("UNAUTHENTICATED"));
            return res;
          }

          if (res.status === 403 && isPlaybackCommand) {
            const details = await readJsonSafely<{ error?: string; message?: string }>(
              res.clone()
            );
            const errorCode = String(details?.error ?? "").trim().toUpperCase();
            const restrictionViolation =
              errorCode === "RESTRICTION_VIOLATED" ||
              String(details?.message ?? "").toLowerCase().includes("restriction violated");

            if (restrictionViolation) {
              playbackRestrictionUntilRef.current =
                Date.now() + PLAYBACK_RESTRICTION_COOLDOWN_MS;
              setActiveDeviceRestricted(true);
              setError(
                "Spotify blokkeert bediening op dit moment (restriction). Wissel device of wacht even."
              );
              return res;
            }

            setError(getPlayerErrorMessage("FORBIDDEN"));
            return res;
          }
          if (res.status === 409 && isPlaybackCommand) {
            playbackMetricsRef.current.commandConflicts += 1;
            emitPlaybackMetric("command_conflict", 1, {
              total: playbackMetricsRef.current.commandConflicts,
            });
            setConnectConflict("Spotify Connect is active on another device. Choose again.");
            setError("Spotify Connect is active on another device. Choose again.");
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
                ? Math.min(retryAfterMs, PLAYER_RETRY_AFTER_MAX_MS)
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
    [applyRateLimit, emitPlaybackMetric, refreshClientAccessToken]
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
    shouldPlay = false,
    expectedCurrentDeviceId?: string | null
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

    const transferred = await transferPlayback(
      targetId,
      shouldPlay,
      expectedCurrentDeviceId
    );
    if (!transferred) {
      if (pendingDeviceIdRef.current === targetId) {
        clearPendingDevice("ensure_active_device_transfer_failed", targetId);
        setHandoffPhase("failed", "ensure_active_device_transfer_failed", {
          targetDeviceId: targetId,
        });
      }
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
    if (pendingDeviceIdRef.current === targetId) {
      clearPendingDevice("ensure_active_device_verify_failed", targetId);
      setHandoffPhase("failed", "ensure_active_device_verify_failed", {
        targetDeviceId: targetId,
      });
    }
    lastConfirmedActiveDeviceRef.current = null;
    setDeviceReady(false);
    return false;
  }

  const ensureActiveDeviceRef = useRef(ensureActiveDevice);
  ensureActiveDeviceRef.current = ensureActiveDevice;

  async function waitForKnownDeviceId(timeoutMs = 1200) {
    const start = Date.now();
    let candidate =
      activeDeviceIdRef.current || deviceIdRef.current || sdkDeviceIdRef.current;
    while (!candidate && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      candidate =
        activeDeviceIdRef.current || deviceIdRef.current || sdkDeviceIdRef.current;
    }
    return candidate;
  }

  function resolveTrackIdFromUri(uri?: string | null) {
    if (!uri) return null;
    const id = uri.split(":").pop();
    return id ? id : null;
  }

  async function readCurrentPlayback() {
    const res = await spotifyApiFetch("https://api.spotify.com/v1/me/player");
    if (!res?.ok) return null;
    return await readJsonSafely<any>(res);
  }

  async function captureDeviceSwitchContext(): Promise<DeviceSwitchContext> {
    const now = Date.now();
    const fallbackProgress =
      Number.isFinite(lastKnownPositionRef.current) && lastKnownPositionRef.current >= 0
        ? Math.floor(lastKnownPositionRef.current)
        : typeof playerStateRef.current?.positionMs === "number"
        ? Math.max(0, Math.floor(playerStateRef.current.positionMs))
        : null;
    const fallbackDuration =
      typeof playerStateRef.current?.durationMs === "number"
        ? Math.max(0, Math.floor(playerStateRef.current.durationMs))
        : null;
    const fallbackTrackId = lastTrackIdRef.current || pendingTrackIdRef.current || null;
    const fallback: DeviceSwitchContext = {
      wasPlaying: Boolean(lastIsPlayingRef.current),
      trackId: fallbackTrackId,
      progressMs: fallbackProgress,
      durationMs: fallbackDuration,
      sampledAt: now,
    };

    try {
      const live = await readCurrentPlayback();
      if (!live) return fallback;
      const liveProgress =
        typeof live.progress_ms === "number" ? Math.max(0, Math.floor(live.progress_ms)) : null;
      const liveDuration =
        typeof live?.item?.duration_ms === "number"
          ? Math.max(0, Math.floor(live.item.duration_ms))
          : fallback.durationMs;
      const liveTrackId =
        typeof live?.item?.id === "string" && live.item.id.trim()
          ? live.item.id
          : fallback.trackId;
      return {
        wasPlaying: Boolean(live?.is_playing),
        trackId: liveTrackId,
        progressMs: liveProgress ?? fallback.progressMs,
        durationMs: liveDuration ?? fallback.durationMs,
        sampledAt: Date.now(),
      };
    } catch {
      return fallback;
    }
  }

  function estimateResumePositionMs(context: DeviceSwitchContext): number | null {
    if (typeof context.progressMs !== "number" || !Number.isFinite(context.progressMs)) {
      return null;
    }
    const elapsedMs = context.wasPlaying ? Math.max(0, Date.now() - context.sampledAt) : 0;
    let target = Math.max(0, Math.floor(context.progressMs + elapsedMs));
    if (typeof context.durationMs === "number" && Number.isFinite(context.durationMs)) {
      target = Math.min(target, Math.max(0, Math.floor(context.durationMs - 700)));
    }
    return target;
  }

  async function resumeAfterDeviceSwitch(
    deviceId: string,
    context: DeviceSwitchContext
  ): Promise<boolean> {
    if (!context.wasPlaying) return true;

    const estimatedPosMs = estimateResumePositionMs(context);
    if (estimatedPosMs != null) {
      await spotifyApiFetch(
        withDeviceId(
          `https://api.spotify.com/v1/me/player/seek?position_ms=${estimatedPosMs}`,
          deviceId
        ),
        { method: "PUT" }
      ).catch(() => undefined);
    }

    const resumeRes = await spotifyApiFetch(
      withDeviceId("https://api.spotify.com/v1/me/player/play", deviceId),
      { method: "PUT" }
    );
    if (!resumeRes?.ok) return false;

    if (estimatedPosMs == null) return true;

    await new Promise((resolve) =>
      setTimeout(resolve, DEVICE_SWITCH_RESUME_VERIFY_DELAY_MS)
    );
    const verify = await readCurrentPlayback();
    if (!verify) return true;

    const verifyTrackId =
      typeof verify?.item?.id === "string" ? verify.item.id : null;
    if (context.trackId && verifyTrackId && verifyTrackId !== context.trackId) {
      return true;
    }

    const verifyProgress =
      typeof verify?.progress_ms === "number" ? Math.max(0, verify.progress_ms) : null;
    if (
      verifyProgress == null ||
      Math.abs(verifyProgress - estimatedPosMs) > DEVICE_SWITCH_RESUME_TOLERANCE_MS
    ) {
      await spotifyApiFetch(
        withDeviceId(
          `https://api.spotify.com/v1/me/player/seek?position_ms=${estimatedPosMs}`,
          deviceId
        ),
        { method: "PUT" }
      ).catch(() => undefined);
    }

    return true;
  }

  function playbackMatchesExpectedTrack(
    playback: any,
    expectedTrackId?: string | null
  ) {
    if (!expectedTrackId) return true;
    const currentTrackId =
      typeof playback?.item?.id === "string" ? playback.item.id : null;
    if (!currentTrackId) return true;
    return currentTrackId === expectedTrackId;
  }

  async function forceResumePlayback(deviceId: string) {
    if (deviceId === sdkDeviceIdRef.current) {
      try {
        await playerRef.current?.activateElement?.();
      } catch {
        // ignore; fallback to Web API play call below
      }
      try {
        await playerRef.current?.resume?.();
      } catch {
        // ignore; fallback to Web API play call below
      }
    }
    await spotifyApiFetch(
      withDeviceId("https://api.spotify.com/v1/me/player/play", deviceId),
      { method: "PUT" }
    );
  }

  async function ensurePlaybackStarted(
    deviceId: string,
    expectedTrackId?: string | null
  ) {
    const wait = async (ms: number) => {
      if (ms <= 0) return;
      await new Promise((resolve) => setTimeout(resolve, ms));
    };

    const verifyPlaying = async (delayMs: number) => {
      await wait(delayMs);
      const playback = await readCurrentPlayback();
      const playing = Boolean(playback?.is_playing);
      if (!playing) return false;
      return playbackMatchesExpectedTrack(playback, expectedTrackId);
    };

    if (await verifyPlaying(180)) {
      return true;
    }

    await forceResumePlayback(deviceId);
    if (await verifyPlaying(240)) {
      return true;
    }

    await wait(420);
    await forceResumePlayback(deviceId);
    return await verifyPlaying(260);
  }

  async function ensurePlaybackStartedWithRetry(args: {
    deviceId: string;
    expectedTrackId?: string | null;
    replay?: () => Promise<Response | null>;
  }) {
    const started = await ensurePlaybackStarted(args.deviceId, args.expectedTrackId);
    if (started) return true;
    if (!args.replay) return false;

    await new Promise((resolve) => setTimeout(resolve, 180));
    const retryRes = await args.replay();
    if (!retryRes?.ok) return false;
    return await ensurePlaybackStarted(args.deviceId, args.expectedTrackId);
  }

  const ensurePlaybackStartedRef = useRef(ensurePlaybackStarted);
  ensurePlaybackStartedRef.current = ensurePlaybackStarted;

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
    schedulePlaybackVerify(700, "api_verify");
    return true;
  }

  async function playUrisAtIndex(
    uris: string[],
    index: number,
    deviceId: string,
    token: string
  ) {
    const operationEpoch = beginOperationEpoch();
    const offsetUri = uris[index];
    if (!offsetUri) return;
    const id = offsetUri.split(":").pop() || null;
    pendingTrackIdRef.current = id;
    trackChangeLockUntilRef.current = Date.now() + 2000;
    applyProgressPosition(0);
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
    const attemptPlay = () =>
      spotifyApiFetch(withDeviceId("https://api.spotify.com/v1/me/player/play", deviceId), {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    const res = await attemptPlay();
    if (res && res.ok) {
      const started = await ensurePlaybackStartedWithRetry({
        deviceId,
        expectedTrackId: id,
        replay: attemptPlay,
      });
      if (!started) {
        setError("Track startte niet direct. Probeer opnieuw.");
      } else {
        setError(null);
      }
      applyProgressPosition(0);
      schedulePlaybackVerify(280, "api_verify", operationEpoch);
    }
  }

  const setActiveDevice = useCallback((id: string | null, name?: string | null) => {
    const previousId = activeDeviceIdRef.current;
    setActiveDeviceId(id);
    activeDeviceIdRef.current = id;
    if (previousId !== id) {
      bumpDeviceEpoch("active_device_changed", id);
    }
    if (name !== undefined) {
      setActiveDeviceName(name);
    }
    refreshAuthorityMode("set_active_device");
  }, [bumpDeviceEpoch, refreshAuthorityMode]);

  const shouldAdoptRemoteDevice = useCallback((remoteDeviceId?: string | null) => {
    if (!remoteDeviceId) return false;
    const pendingId = pendingDeviceIdRef.current;
    if (pendingId) {
      const pendingFresh =
        Date.now() - lastDeviceSelectRef.current < DEVICE_SELECTION_HOLD_MS;
      if (!pendingFresh) {
        clearPendingDevice("pending_device_expired_before_adopt", remoteDeviceId);
        setHandoffPhase("failed", "pending_device_expired_before_adopt", {
          targetDeviceId: remoteDeviceId ?? null,
        });
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
  }, [clearPendingDevice, setHandoffPhase]);

  const clearRemoteTakeoverCandidate = useCallback(() => {
    remoteTakeoverCandidateRef.current = null;
  }, []);

  const shouldForceAdoptRemoteDevice = useCallback((remoteDeviceId?: string | null) => {
    if (!remoteDeviceId) return false;
    const now = Date.now();
    const current = remoteTakeoverCandidateRef.current;
    if (!current || current.deviceId !== remoteDeviceId) {
      remoteTakeoverCandidateRef.current = {
        deviceId: remoteDeviceId,
        firstSeenAt: now,
        samples: 1,
      };
      return false;
    }
    current.samples += 1;
    const stableEnough =
      now - current.firstSeenAt >= REMOTE_TAKEOVER_CONFIRM_MS &&
      current.samples >= REMOTE_TAKEOVER_MIN_SAMPLES;
    if (!stableEnough) return false;
    remoteTakeoverCandidateRef.current = null;
    return true;
  }, []);
  
  const clearPendingDeviceIfStale = useCallback(() => {
    const pendingId = pendingDeviceIdRef.current;
    if (!pendingId) return;
    const pendingFresh =
      Date.now() - lastDeviceSelectRef.current < DEVICE_SELECTION_HOLD_MS;
    if (pendingFresh) return;
    clearPendingDevice("pending_device_cleared_stale", pendingId);
    setHandoffPhase("failed", "pending_device_cleared_stale", {
      targetDeviceId: pendingId,
    });
  }, [clearPendingDevice, setHandoffPhase]);

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
      const currentTrack = data?.currently_playing;
      const nextTracks = Array.isArray(data?.queue) ? data.queue : [];
      const nextMapped = nextTracks.map((track: any, index: number) =>
        mapQueueTrackItem(track, index)
      );
      const currentMapped = currentTrack ? mapQueueTrackItem(currentTrack, -1) : null;
      const deduped: QueueTrackItem[] = [];
      const seen = new Set<string>();
      if (currentMapped) {
        const currentId = normalizePlaybackTrackId(currentMapped.id) ?? currentMapped.id;
        deduped.push({
          ...currentMapped,
          id: currentId,
          matchTrackIds: normalizeTrackIdCollection([
            ...currentMapped.matchTrackIds,
            currentId,
            currentMapped.uri,
          ]),
          isCurrent: true,
        });
        seen.add(currentId);
      }
      for (const item of nextMapped) {
        const normalizedId = normalizePlaybackTrackId(item.id) ?? item.id;
        if (seen.has(normalizedId)) continue;
        seen.add(normalizedId);
        deduped.push({
          ...item,
          id: normalizedId,
          matchTrackIds: normalizeTrackIdCollection([
            ...item.matchTrackIds,
            normalizedId,
            item.uri,
          ]),
          isCurrent: false,
        });
      }
      setQueueItems(deduped);
    } catch {
      setQueueError("Queue ophalen lukt nu niet.");
    } finally {
      setQueueLoading(false);
    }
  }, [spotifyApiFetch]);

  const shouldApplyIngest = useCallback(
    (
      event: PlaybackSyncEvent,
      options?: {
        receivedMonoMs?: number;
        snapshotDeviceId?: string | null;
      }
    ) => {
      const activeDevice = activeDeviceIdRef.current || deviceIdRef.current;
      const sdkDevice = sdkDeviceIdRef.current;
      const mode = refreshAuthorityMode(
        "ingest",
        options?.snapshotDeviceId ?? event.deviceId
      );
      const authorityVerdict = shouldIngestSourceForAuthority({
        authorityMode: mode,
        source: event.source,
        eventDeviceId: event.deviceId ?? null,
        activeDeviceId: activeDevice ?? null,
        sdkDeviceId: sdkDevice ?? null,
      });
      if (!authorityVerdict.allow) {
        emitPlaybackDebugEvent("ingest_ignored", {
          reason: authorityVerdict.reason,
          authorityMode: mode,
          source: event.source,
          seq: event.seq,
          atMs: event.atMs,
          deviceId: event.deviceId,
          activeDevice,
          sdkDevice,
        });
        emitPlaybackMetric("ingest_reject_authority", 1, {
          source: event.source,
          authorityMode: mode,
          reason: authorityVerdict.reason,
        });
        return false;
      }

      const verdict = shouldApplyPlaybackEvent(playbackSyncStateRef.current, event);
      if (!verdict.apply) {
        emitPlaybackDebugEvent("ingest_ignored", {
          reason: verdict.reason,
          authorityMode: mode,
          source: event.source,
          seq: event.seq,
          atMs: event.atMs,
          deviceId: event.deviceId,
          trackId: event.trackId,
          state: playbackSyncStateRef.current,
        });
        emitPlaybackMetric("ingest_reject_sync", 1, {
          source: event.source,
          authorityMode: mode,
          reason: verdict.reason,
        });
        return false;
      }

      const monoMs = Math.floor(options?.receivedMonoMs ?? getMonotonicNow());
      const versionVerdict = shouldApplyPlaybackVersion(playbackVersionRef.current, {
        deviceEpoch: deviceEpochRef.current,
        seq: event.seq,
        atMs: event.atMs,
        receivedMonoMs: monoMs,
      });
      if (!versionVerdict.apply) {
        emitPlaybackDebugEvent("ingest_ignored", {
          reason: versionVerdict.reason,
          authorityMode: mode,
          source: event.source,
          seq: event.seq,
          atMs: event.atMs,
          deviceId: event.deviceId,
          trackId: event.trackId,
          currentVersion: playbackVersionRef.current,
        });
        emitPlaybackMetric("ingest_reject_version", 1, {
          source: event.source,
          authorityMode: mode,
          reason: versionVerdict.reason,
        });
        return false;
      }

      playbackSyncStateRef.current = reducePlaybackSyncState(
        playbackSyncStateRef.current,
        event
      );
      playbackVersionRef.current = versionVerdict.next;
      emitPlaybackDebugEvent("ingest_applied", {
        reason: verdict.reason,
        authorityMode: mode,
        source: event.source,
        seq: event.seq,
        atMs: event.atMs,
        deviceId: event.deviceId,
        trackId: event.trackId,
        version: versionVerdict.next,
      });
      return true;
    },
    [emitPlaybackMetric, getMonotonicNow, refreshAuthorityMode]
  );

  const preserveTransientNoTrackState = useCallback(
    (args: {
      source: PlaybackSource | PlaybackFocusSource;
      isPlaying?: boolean | null;
      snapshotDeviceId?: string | null;
      fallbackStatus?: PlaybackFocusStatus;
      nowMs?: number;
      confidence?: number;
    }) => {
      const nowMs = typeof args.nowMs === "number" ? args.nowMs : Date.now();
      const activeDevice = activeDeviceIdRef.current || deviceIdRef.current;
      const sdkDevice = sdkDeviceIdRef.current;
      const pendingDeviceSwitchActive = Boolean(
        pendingDeviceIdRef.current &&
          nowMs - lastDeviceSelectRef.current < DEVICE_SELECTION_HOLD_MS
      );
      const fallbackTrackId = currentTrackIdRef.current || lastTrackIdRef.current || null;
      if (!fallbackTrackId) return false;
      const remoteDeviceActive = Boolean(
        activeDevice &&
          sdkDevice &&
          activeDevice !== sdkDevice &&
          args.snapshotDeviceId &&
          args.snapshotDeviceId === activeDevice
      );
      const remoteDeviceFromSnapshot = Boolean(
        args.snapshotDeviceId &&
          sdkDevice &&
          args.snapshotDeviceId !== sdkDevice
      );
      const inRateLimitBackoff = nowMs < rateLimitRef.current.until;
      const remoteAuthorityActive =
        authorityModeRef.current === "remote_primary" ||
        authorityModeRef.current === "handoff_pending";
      const staleHoldMs =
        inRateLimitBackoff ||
        remoteDeviceActive ||
        remoteDeviceFromSnapshot ||
        remoteAuthorityActive ||
        pendingDeviceSwitchActive
          ? REMOTE_STALE_TRACK_HOLD_MS
          : LOCAL_STALE_TRACK_HOLD_MS;
      const hasRecentPlayableTrack =
        nowMs - lastPlayableTrackSeenAtRef.current < staleHoldMs;
      const shouldPreserveTrackState =
        args.isPlaying === true || hasRecentPlayableTrack || pendingDeviceSwitchActive;
      if (!shouldPreserveTrackState) return false;

      const inferredPlaying =
        typeof args.isPlaying === "boolean" ? args.isPlaying : false;
      const inferredStatus: PlaybackFocusStatus =
        typeof args.isPlaying === "boolean"
          ? args.isPlaying
            ? "playing"
            : "paused"
          : args.fallbackStatus ??
            (playbackFocusRef.current.isPlaying ? "playing" : "paused");
      setPlaybackTrackState(fallbackTrackId, {
        matchTrackIds:
          playbackFocusRef.current.matchTrackIds.length > 0
            ? playbackFocusRef.current.matchTrackIds
            : [fallbackTrackId],
        isPlaying: inferredPlaying,
        status: inferredStatus,
        stale: true,
        source: args.source,
        confidence:
          typeof args.confidence === "number" ? args.confidence : 0.75,
        positionMs: lastKnownPositionRef.current,
        durationMs: durationMsRef.current,
        errorMessage: null,
        updatedAt: nowMs,
      });
      return true;
    },
    [setPlaybackTrackState]
  );

  const confirmPendingHandoffOnPlayback = useCallback(
    (
      trackId: string | null,
      source: PlaybackSource | PlaybackFocusSource,
      snapshotDeviceId?: string | null
    ) => {
      if (!trackId) return;
      const pendingId = pendingDeviceIdRef.current;
      if (!pendingId) return;
      const activeDevice = activeDeviceIdRef.current || deviceIdRef.current || null;
      const effectiveSnapshotDevice = snapshotDeviceId ?? activeDevice;
      const confirmsPendingDevice = Boolean(
        effectiveSnapshotDevice && effectiveSnapshotDevice === pendingId
      );
      if (!confirmsPendingDevice) return;
      clearPendingDevice("handoff_playback_confirmed", effectiveSnapshotDevice);
      setHandoffPhase("playback_confirmed", "handoff_playback_confirmed", {
        targetDeviceId: effectiveSnapshotDevice,
      });
      emitPlaybackMetric("handoff_playback_confirmed", 1, {
        source,
        trackId,
        deviceId: effectiveSnapshotDevice,
      });
    },
    [clearPendingDevice, emitPlaybackMetric, setHandoffPhase]
  );

  const decideNoTrackTransition = useCallback(
    (args: {
      source: PlaybackSource | PlaybackFocusSource;
      isPlaying?: boolean | null;
      snapshotDeviceId?: string | null;
      fallbackStatus?: PlaybackFocusStatus;
      nowMs?: number;
      confidence?: number;
    }) => {
      const nowMs = typeof args.nowMs === "number" ? args.nowMs : Date.now();
      const preserved = preserveTransientNoTrackState(args);
      if (preserved) {
        emitPlaybackMetric("no_track_preserved", 1, {
          source: args.source,
          snapshotDeviceId: args.snapshotDeviceId ?? null,
          reason: "preserve_transient",
        });
        return { preserved: true, hardClear: false };
      }

      const counter = recordNoTrackEvent(args.source, args.snapshotDeviceId, nowMs);
      const handoffPhase = handoffStateRef.current.phase;
      const handoffActive = handoffPhase === "requested" || handoffPhase === "device_ready";
      const minCount = handoffActive
        ? NO_TRACK_HANDOFF_HARD_CLEAR_MIN_COUNT
        : NO_TRACK_HARD_CLEAR_MIN_COUNT;
      const graceMs = handoffActive
        ? NO_TRACK_HANDOFF_HARD_CLEAR_GRACE_MS
        : NO_TRACK_HARD_CLEAR_GRACE_MS;
      const ageMs = Math.max(0, nowMs - counter.firstAt);
      const hardClear = counter.count >= minCount && ageMs >= graceMs;
      if (hardClear) {
        emitPlaybackMetric("no_track_hard_clear", 1, {
          source: args.source,
          snapshotDeviceId: args.snapshotDeviceId ?? null,
          count: counter.count,
          ageMs,
          handoffPhase,
        });
      } else {
        emitPlaybackMetric("no_track_waiting", 1, {
          source: args.source,
          snapshotDeviceId: args.snapshotDeviceId ?? null,
          count: counter.count,
          ageMs,
          handoffPhase,
        });
      }
      return { preserved: false, hardClear };
    },
    [emitPlaybackMetric, preserveTransientNoTrackState, recordNoTrackEvent]
  );

  const ingestCrossTabSnapshotRef = useRef(
    (
      _payload: PlaybackCrossTabSnapshot,
      _source: PlaybackSource,
      _timing: {
        requestStartedAtWallMs: number;
        responseReceivedAtWallMs: number;
        responseReceivedAtMonoMs: number;
      }
    ) => undefined
  );

  const ingestApiSnapshot = useCallback(
    (
      data: any,
      {
        source,
        requestStartedAtWallMs,
        responseReceivedAtWallMs,
        responseReceivedAtMonoMs,
        pauseLocalSdkOnRemote = false,
      }: {
        source: PlaybackSource;
        requestStartedAtWallMs: number;
        responseReceivedAtWallMs: number;
        responseReceivedAtMonoMs: number;
        pauseLocalSdkOnRemote?: boolean;
      }
    ) => {
      const eventAtMs =
        typeof data?.timestamp === "number"
          ? Math.max(0, Math.floor(data.timestamp))
          : responseReceivedAtWallMs;
      const eventSeq = readSyncServerSeq(data);
      const eventTrackId = data?.item ? resolvePlaybackTrackId(data.item) : null;
      const eventDeviceId =
        typeof data?.device?.id === "string" ? data.device.id : null;
      if (
        !shouldApplyIngest({
          source: toIngestSource(source),
          seq: eventSeq,
          atMs: eventAtMs,
          deviceId: eventDeviceId,
          trackId: eventTrackId,
          isPlaying:
            typeof data?.is_playing === "boolean" ? data.is_playing : null,
        }, {
          receivedMonoMs: responseReceivedAtMonoMs,
          snapshotDeviceId: eventDeviceId,
        })
      ) {
        return Boolean(data?.is_playing);
      }
      lastPlaybackSnapshotAtRef.current = Date.now();
      if (ownPlaybackSyncRef.current) {
        postCrossTabEvent({
          type: "snapshot",
          at: Date.now(),
          source,
          snapshot: data as PlaybackCrossTabSnapshot,
        } satisfies PlaybackCrossTabMessage);
      }
      const device = data?.device;
      const remoteDeviceId = device?.id ?? null;
      const canAdoptRemoteDevice = shouldAdoptRemoteDevice(remoteDeviceId);
      if (
        remoteDeviceId &&
        activeDeviceIdRef.current &&
        remoteDeviceId !== activeDeviceIdRef.current &&
        !canAdoptRemoteDevice
      ) {
        setConnectConflict(
          device?.name
            ? `Connect change detected on ${device.name}.`
            : "Connect change detected on another device."
        );
        if (shouldForceAdoptRemoteDevice(remoteDeviceId)) {
          setConnectConflict(null);
          preferSdkDeviceRef.current = remoteDeviceId === sdkDeviceIdRef.current;
          if (pendingDeviceIdRef.current === remoteDeviceId) {
            setHandoffPhase("device_ready", "force_adopt_remote_device", {
              targetDeviceId: remoteDeviceId,
            });
          }
          refreshAuthorityMode("force_adopt_remote_device", remoteDeviceId);
          setActiveDevice(remoteDeviceId, device?.name ?? null);
          setActiveDeviceRestricted(Boolean(device?.is_restricted));
          setActiveDevicePrivateSession(Boolean(device?.is_private_session));
          setActiveDeviceSupportsVolume(device?.supports_volume !== false);
          lastConfirmedActiveDeviceRef.current = { id: remoteDeviceId, at: Date.now() };
        }
      }
      if (canAdoptRemoteDevice) {
        clearRemoteTakeoverCandidate();
        setConnectConflict(null);
        preferSdkDeviceRef.current = device.id === sdkDeviceIdRef.current;
        setActiveDevice(device.id, device.name ?? null);
        setActiveDeviceRestricted(Boolean(device.is_restricted));
        setActiveDevicePrivateSession(Boolean(device.is_private_session));
        setActiveDeviceSupportsVolume(device.supports_volume !== false);
        lastConfirmedActiveDeviceRef.current = { id: device.id, at: Date.now() };
        if (device.id === pendingDeviceIdRef.current) {
          setHandoffPhase("device_ready", "adopt_remote_device_resolved_pending", {
            targetDeviceId: device.id,
          });
          refreshAuthorityMode("adopt_remote_device_resolved_pending", device.id);
        }
      }

      if (
        pauseLocalSdkOnRemote &&
        sdkDeviceIdRef.current &&
        device?.id &&
        device.id !== sdkDeviceIdRef.current &&
        playerRef.current
      ) {
        playerRef.current.pause().catch(() => undefined);
      }

      const disallowsRaw = data?.actions?.disallows;
      const disallows =
        disallowsRaw && typeof disallowsRaw === "object"
          ? Object.fromEntries(
              Object.entries(disallowsRaw).map(([key, value]) => [key, Boolean(value)])
            )
          : {};
      setPlaybackDisallows(disallows);
      const hasBlockingRestriction = Boolean(
        disallows.resuming ||
          disallows.pausing ||
          disallows.skipping_prev ||
          disallows.skipping_next ||
          disallows.seeking ||
          disallows.toggling_shuffle
      );
      if (!hasBlockingRestriction) {
        playbackRestrictionUntilRef.current = 0;
      }

      const isPlaying = Boolean(data?.is_playing);
      if (!data?.item) {
        const nowMs = Date.now();
        const noTrackTransition = decideNoTrackTransition({
          source,
          isPlaying:
            typeof data?.is_playing === "boolean" ? data.is_playing : null,
          snapshotDeviceId: eventDeviceId,
          nowMs,
          confidence: 0.75,
        });
        if (noTrackTransition.preserved || !noTrackTransition.hardClear) {
          postCrossTabEvent({
            type: "sync",
            at: nowMs,
            source,
            seq: operationEpochRef.current,
          });
          return Boolean(data?.is_playing);
        }
        hasConfirmedLivePlaybackRef.current = false;
        clearPlaybackViewState(
          responseReceivedAtMonoMs,
          source,
          typeof data?.is_playing === "boolean" ? data.is_playing : null
        );
        if (typeof data?.is_playing === "boolean") {
          lastIsPlayingRef.current = data.is_playing;
        }
        postCrossTabEvent({
          type: "sync",
          at: Date.now(),
          source,
          seq: operationEpochRef.current,
        });
        return isPlaying;
      }

      const item = data.item;
      hasConfirmedLivePlaybackRef.current = true;
      const trackId = resolvePlaybackTrackId(item);
      const matchTrackIds = resolvePlaybackTrackIds(item);
      if (!trackId || matchTrackIds.length === 0) {
        const nowMs = Date.now();
        const noTrackTransition = decideNoTrackTransition({
          source,
          isPlaying:
            typeof data?.is_playing === "boolean" ? data.is_playing : null,
          snapshotDeviceId: eventDeviceId,
          fallbackStatus: "loading",
          nowMs,
          confidence: 0.7,
        });
        if (noTrackTransition.preserved || !noTrackTransition.hardClear) {
          postCrossTabEvent({
            type: "sync",
            at: nowMs,
            source,
            seq: operationEpochRef.current,
          });
          return isPlaying;
        }
        hasConfirmedLivePlaybackRef.current = false;
        clearPlaybackViewState(
          responseReceivedAtMonoMs,
          source,
          typeof data?.is_playing === "boolean" ? data.is_playing : null
        );
        return isPlaying;
      }
      lastPlayableTrackSeenAtRef.current = Date.now();
      const isNewTrack = trackId && trackId !== lastTrackIdRef.current;
      if (isNewTrack) {
        lastTrackIdRef.current = trackId;
        if (pendingTrackIdRef.current === trackId) {
          pendingTrackIdRef.current = null;
        }
        trackChangeLockUntilRef.current = Date.now() + 1200;
        setOptimisticTrack(null);
      }
      const rawPosition = isNewTrack ? 0 : data.progress_ms ?? 0;
      const projectedPosition = projectRemoteProgressMs(
        rawPosition,
        isPlaying,
        typeof data?.timestamp === "number" ? data.timestamp : null,
        requestStartedAtWallMs,
        responseReceivedAtWallMs
      );
      setPlayerState((prev) => {
        const next = {
          name: item.name ?? prev?.name ?? "Unknown track",
          artists: (item.artists ?? []).map((a: any) => a.name).join(", "),
          album: item.album?.name ?? prev?.album ?? "",
          coverUrl: item.album?.images?.[0]?.url ?? prev?.coverUrl ?? null,
          paused: Boolean(!isPlaying),
          positionMs: projectedPosition,
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
      const syncedPosition = isNewTrack || !allowProgressUpdate ? 0 : projectedPosition;
      const guarded = applyPendingSeekGuard(syncedPosition, responseReceivedAtMonoMs);
      const driftMs = guarded.positionMs - lastKnownPositionRef.current;
      playbackMetricsRef.current.lastDriftMs = driftMs;
      emitPlaybackMetric("drift_ms", driftMs, { source });
      const reconciledPosition = reconcileProgressPosition(
        lastKnownPositionRef.current,
        guarded.positionMs,
        Boolean(isNewTrack || guarded.hardSync)
      );
      if (!isScrubbingRef.current) {
        applyProgressPosition(reconciledPosition, responseReceivedAtMonoMs);
      }
      setDurationMs(item.duration_ms ?? 0);
      setPlaybackTrackState(trackId, {
        matchTrackIds,
        isPlaying,
        status: isPlaying ? "playing" : "paused",
        stale: false,
        source,
        confidence: 1,
        positionMs: reconciledPosition,
        durationMs: item.duration_ms ?? 0,
        errorMessage: null,
        updatedAt: Date.now(),
      });
      resetNoTrackCounter("api_valid_track");
      confirmPendingHandoffOnPlayback(trackId, source, eventDeviceId);
      syncQueuePositionFromTrack(trackId);
      if (trackId && Date.now() - lastProgressSyncRef.current > 5000) {
        lastProgressSyncRef.current = Date.now();
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
        if (Date.now() - lastUserVolumeAtRef.current > 1500 || source !== "api_poll") {
          setVolume(nextVol);
          if (nextVol > 0) lastNonZeroVolumeRef.current = nextVol;
        }
      }
      postCrossTabEvent({
        type: "sync",
        at: Date.now(),
        source,
        seq: operationEpochRef.current,
      });
      return isPlaying;
    },
    [
      applyPendingSeekGuard,
      applyProgressPosition,
      clearPlaybackViewState,
      confirmPendingHandoffOnPlayback,
      decideNoTrackTransition,
      emitPlaybackMetric,
      postCrossTabEvent,
      projectRemoteProgressMs,
      refreshAuthorityMode,
      rebuildQueueOrder,
      reconcileProgressPosition,
      resetNoTrackCounter,
      setHandoffPhase,
      setPlaybackTrackState,
      setActiveDevice,
      shouldAdoptRemoteDevice,
      shouldApplyIngest,
      clearRemoteTakeoverCandidate,
      syncQueuePositionFromTrack,
      shouldForceAdoptRemoteDevice,
    ]
  );

  ingestCrossTabSnapshotRef.current = (
    payload,
    source,
    {
      requestStartedAtWallMs,
      responseReceivedAtWallMs,
      responseReceivedAtMonoMs,
    }
  ) => {
    ingestApiSnapshot(payload, {
      source,
      requestStartedAtWallMs,
      responseReceivedAtWallMs,
      responseReceivedAtMonoMs,
      pauseLocalSdkOnRemote: source === "api_poll" || source === "api_stream",
    });
  };

  const syncPlaybackState = useCallback(
    async (source: PlaybackSource = "api_sync", minEpoch?: number) => {
      const nowMs = Date.now();
      const minSyncIntervalMs =
        source === "api_bootstrap"
          ? 0
          : source === "api_verify"
          ? 900
          : source === "api_sync"
          ? 1_400
          : source === "api_poll"
          ? 2_200
          : 1_200;
      if (
        source !== "api_bootstrap" &&
        nowMs - lastSyncStartedAtRef.current < minSyncIntervalMs
      ) {
        return;
      }
      if (syncInFlightRef.current) {
        return;
      }
      syncInFlightRef.current = true;
      lastSyncStartedAtRef.current = nowMs;
      const requestEpoch =
        typeof minEpoch === "number" ? minEpoch : operationEpochRef.current;
      if (requestEpoch < operationEpochRef.current) {
        syncInFlightRef.current = false;
        return;
      }
      try {
        const requestStartedAtWallMs = Date.now();
        const res = await spotifyApiFetch("https://api.spotify.com/v1/me/player");
        if (!res?.ok) return;
        const responseReceivedAtWallMs = Date.now();
        const responseReceivedAtMonoMs = getMonotonicNow();
        const observedRttMs = Math.max(0, responseReceivedAtWallMs - requestStartedAtWallMs);
        rttEwmaMsRef.current = rttEwmaMsRef.current * 0.8 + observedRttMs * 0.2;
        playbackMetricsRef.current.avgRttMs = rttEwmaMsRef.current;
        seekRollbackTimeoutMsRef.current = Math.min(
          3200,
          Math.max(1200, Math.round(rttEwmaMsRef.current * 3))
        );
        emitPlaybackMetric("rtt_ms", observedRttMs, {
          avgRttMs: Math.round(rttEwmaMsRef.current),
          source,
        });
        if (requestEpoch < operationEpochRef.current) {
          return;
        }
        const data = await readJsonSafely(res);
        ingestApiSnapshot(data, {
          source,
          requestStartedAtWallMs,
          responseReceivedAtWallMs,
          responseReceivedAtMonoMs,
          pauseLocalSdkOnRemote: source === "api_poll",
        });
      } finally {
        syncInFlightRef.current = false;
      }
    },
    [
      emitPlaybackMetric,
      getMonotonicNow,
      ingestApiSnapshot,
      spotifyApiFetch,
    ]
  );

  useEffect(() => {
    syncPlaybackStateRef.current = syncPlaybackState;
  }, [syncPlaybackState]);

  useEffect(() => {
    if (!enablePlaybackStream) return;
    if (!accessToken) return;
    if (typeof window === "undefined") return;
    if (!shouldRunPlaybackStream) return;

    let cancelled = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const connect = () => {
      if (cancelled) return;
      source = new EventSource("/api/spotify/me/player/stream");

      const onSnapshot = (event: Event) => {
        const message = event as MessageEvent<string>;
        let payload: any = null;
        try {
          payload = JSON.parse(message.data);
        } catch {
          return;
        }
        const responseReceivedAtWallMs = Date.now();
        const responseReceivedAtMonoMs = getMonotonicNow();
        const requestStartedAtWallMs =
          typeof payload?.timestamp === "number"
            ? Math.max(0, payload.timestamp)
            : responseReceivedAtWallMs;
        ingestApiSnapshot(payload, {
          source: "api_stream",
          requestStartedAtWallMs,
          responseReceivedAtWallMs,
          responseReceivedAtMonoMs,
          pauseLocalSdkOnRemote: true,
        });
        lastStreamSnapshotAtRef.current = Date.now();
        attempts = 0;
      };

      const onStreamErrorEvent = (event: Event) => {
        const message = event as MessageEvent<string>;
        let payload: any = null;
        try {
          payload = JSON.parse(message.data);
        } catch {
          payload = null;
        }
        const code = typeof payload?.code === "string" ? payload.code : "";
        if (code === "RATE_LIMIT" || code === "SPOTIFY_UPSTREAM" || code === "STREAM_FAILED") {
          // Force watchdog poll to take over quickly.
          lastStreamSnapshotAtRef.current = 0;
        }
      };

      const onStreamTransportError = () => {
        if (source) {
          source.close();
          source = null;
        }
        if (cancelled) return;
        lastStreamSnapshotAtRef.current = 0;
        void syncPlaybackStateRef.current("api_poll").catch(() => undefined);
        attempts += 1;
        const delay = Math.min(15000, 1000 + attempts * 800);
        retryTimer = setTimeout(connect, delay);
      };

      source.addEventListener("snapshot", onSnapshot as EventListener);
      source.addEventListener("error", onStreamErrorEvent as EventListener);
      source.onerror = onStreamTransportError;
    };

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (source) source.close();
    };
  }, [
    accessToken,
    enablePlaybackStream,
    getMonotonicNow,
    ingestApiSnapshot,
    shouldRunPlaybackStream,
  ]);

  useEffect(() => {
    if (!accessToken || !currentTrackIdState) {
      setCurrentTrackLiked(null);
      setLikedStateLoading(false);
      setTrackPlaylistMenuOpen(false);
      setTrackPlaylistMembershipOpen(false);
      setTrackPlaylistSelectedIds(new Set());
      setTrackPlaylistInitialIds(new Set());
      setTrackPlaylistLoading(false);
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

  const emitPlaylistItemsUpdated = useCallback(
    (playlistId: string, trackId: string, action: "added" | "removed") => {
      if (!playlistId || !trackId || typeof window === "undefined") return;
      const at = Date.now();
      window.dispatchEvent(
        new CustomEvent("gs-playlist-items-updated", {
          detail: { playlistId, trackId, action, at },
        })
      );
      try {
        window.localStorage.setItem("gs_playlist_items_updated_at", String(at));
      } catch {
        // ignore storage issues
      }
    },
    []
  );

  const requestPlaylistItemsSync = useCallback(async (playlistId: string) => {
    if (!playlistId) return;
    try {
      await fetch("/api/spotify/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "playlist_items",
          payload: {
            playlistId,
            offset: 0,
            limit: 50,
            maxPagesPerRun: 20,
            runId: `player-menu-${Date.now()}`,
          },
        }),
      });
    } catch {
      // ignore sync trigger failures; event still updates UI state
    }
  }, []);

  const ensureTrackPlaylistOptionsLoaded = useCallback(async () => {
    if (trackPlaylistOptionsLoadedRef.current) return;
    let cursor: string | null = null;
    const allRows: Array<{ playlistId?: string; name?: string }> = [];
    do {
      const query = new URLSearchParams({ limit: "100", live: "1" });
      if (cursor) query.set("cursor", cursor);
      const res = await fetch(`/api/spotify/me/playlists?${query.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`PLAYLIST_OPTIONS_${res.status}`);
      }
      const payload = (await res.json().catch(() => null)) as
        | { items?: Array<{ playlistId?: string; name?: string }>; nextCursor?: string | null }
        | null;
      const rows = Array.isArray(payload?.items) ? payload.items : [];
      allRows.push(...rows);
      cursor = payload?.nextCursor ? String(payload.nextCursor) : null;
    } while (cursor);

    const deduped = new Map<string, { id: string; name: string; type: "playlist" }>();
    for (const item of allRows) {
      const id = String(item?.playlistId ?? "").trim();
      const name = String(item?.name ?? "").trim();
      if (!id || !name) continue;
      deduped.set(id, { id, name, type: "playlist" });
    }
    const mapped = Array.from(deduped.values()).sort((a, b) =>
      a.name.localeCompare(b.name, "nl", {
        sensitivity: "base",
        ignorePunctuation: true,
        numeric: true,
      })
    );
    setTrackPlaylistOptions([
      { id: PLAYER_LIKED_PLAYLIST_ID, name: "Liked Songs", type: "liked" },
      ...mapped,
    ]);
    trackPlaylistOptionsLoadedRef.current = true;
  }, []);

  const syncCurrentTrackPlaylistSelection = useCallback(
    async (trackId: string) => {
      const requestId = ++trackPlaylistRequestIdRef.current;
      setTrackPlaylistLoading(true);
      try {
        const res = await fetch(
          `/api/spotify/me/tracks/playlists?trackId=${encodeURIComponent(trackId)}`,
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error(`TRACK_PLAYLISTS_${res.status}`);
        const payload = (await res.json().catch(() => null)) as
          | { playlistIds?: string[]; liked?: boolean }
          | null;
        if (trackPlaylistRequestIdRef.current !== requestId) return;
        const ids = new Set<string>();
        for (const playlistId of Array.isArray(payload?.playlistIds)
          ? payload?.playlistIds
          : []) {
          const id = String(playlistId ?? "").trim();
          if (id) ids.add(id);
        }
        const liked = Boolean(payload?.liked);
        if (liked) {
          ids.add(PLAYER_LIKED_PLAYLIST_ID);
          likedCacheRef.current.set(trackId, true);
          setCurrentTrackLiked(true);
        } else {
          likedCacheRef.current.set(trackId, false);
          setCurrentTrackLiked(false);
          ids.delete(PLAYER_LIKED_PLAYLIST_ID);
        }
        setTrackPlaylistSelectedIds(ids);
        setTrackPlaylistInitialIds(new Set(ids));
      } finally {
        if (trackPlaylistRequestIdRef.current === requestId) {
          setTrackPlaylistLoading(false);
        }
      }
    },
    []
  );

  const applyTrackPlaylistDraft = useCallback(async () => {
    if (!currentTrackIdState) return;
    if (trackPlaylistSaving) return;
    const changed = trackPlaylistOptions.filter((option) => {
      const selected = trackPlaylistSelectedIds.has(option.id);
      const initial = trackPlaylistInitialIds.has(option.id);
      return selected !== initial;
    });
    if (!changed.length) return;

    setTrackPlaylistSaving(true);
    let hadFailures = false;
    const changedPlaylistIds = new Set<string>();
    try {
      for (const option of changed) {
        const shouldInclude = trackPlaylistSelectedIds.has(option.id);
        const opKey = `${currentTrackIdState}:${option.id}`;
        setTrackPlaylistActionKey(opKey);
        try {
          let res: Response;
          if (option.type === "liked") {
            res = await fetch("/api/spotify/me/tracks/liked", {
              method: shouldInclude ? "POST" : "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ trackId: currentTrackIdState }),
            });
            if (res.ok) {
              likedCacheRef.current.set(currentTrackIdState, shouldInclude);
              setCurrentTrackLiked(shouldInclude);
              emitLikedTracksUpdated(
                currentTrackIdState,
                shouldInclude ? "added" : "removed"
              );
            }
          } else {
            res = await fetch(`/api/spotify/playlists/${option.id}/items`, {
              method: shouldInclude ? "POST" : "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ trackId: currentTrackIdState }),
            });
          }
          if (!res.ok) {
            hadFailures = true;
          } else if (option.type === "playlist") {
            changedPlaylistIds.add(option.id);
            emitPlaylistItemsUpdated(
              option.id,
              currentTrackIdState,
              shouldInclude ? "added" : "removed"
            );
            void requestPlaylistItemsSync(option.id);
          }
        } catch {
          hadFailures = true;
        } finally {
          setTrackPlaylistActionKey(null);
        }
      }
      if (hadFailures) {
        setError("Niet alle playlist-wijzigingen konden worden opgeslagen.");
      } else {
        setError(null);
      }
      setTrackPlaylistInitialIds(new Set(trackPlaylistSelectedIds));
    } finally {
      setTrackPlaylistSaving(false);
    }
  }, [
    currentTrackIdState,
    emitLikedTracksUpdated,
    emitPlaylistItemsUpdated,
    requestPlaylistItemsSync,
    trackPlaylistInitialIds,
    trackPlaylistOptions,
    trackPlaylistSaving,
    trackPlaylistSelectedIds,
  ]);

  const selectedPlaylistIdsForTrack = useMemo(
    () => Array.from(trackPlaylistSelectedIds).filter((id) => Boolean(id)),
    [trackPlaylistSelectedIds]
  );
  const selectedPlaylistsForTrack = useMemo(() => {
    if (!selectedPlaylistIdsForTrack.length) return [] as Array<{ id: string; name: string }>;
    const optionById = new Map(trackPlaylistOptions.map((option) => [option.id, option]));
    return selectedPlaylistIdsForTrack.map((id) => {
      if (id === PLAYER_LIKED_PLAYLIST_ID) {
        return { id, name: "Liked Songs" };
      }
      const option = optionById.get(id);
      return {
        id,
        name: option?.name ?? id,
      };
    });
  }, [selectedPlaylistIdsForTrack, trackPlaylistOptions]);
  const selectedPlaylistNamesForTrack = useMemo(() => {
    if (!selectedPlaylistIdsForTrack.length) return [] as string[];
    const optionById = new Map(trackPlaylistOptions.map((option) => [option.id, option.name]));
    return selectedPlaylistIdsForTrack.map((id) => {
      if (id === PLAYER_LIKED_PLAYLIST_ID) return "Liked Songs";
      return optionById.get(id) ?? id;
    });
  }, [selectedPlaylistIdsForTrack, trackPlaylistOptions]);
  const currentTrackInAnyPlaylist = selectedPlaylistIdsForTrack.length > 0;
  const trackPlaylistAddTargetOptions = useMemo(
    () =>
      trackPlaylistOptions.filter(
        (option) => option.type === "liked" || startsWithEmoji(option.name)
      ),
    [trackPlaylistOptions]
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

  useEffect(() => {
    if (!currentTrackIdState || !accessToken) return;
    void ensureTrackPlaylistOptionsLoaded().catch(() => {
      setError("Unable to load playlist targets right now.");
    });
    void syncCurrentTrackPlaylistSelection(currentTrackIdState).catch(() => {
      setError("Unable to load track playlists right now.");
    });
  }, [
    accessToken,
    currentTrackIdState,
    ensureTrackPlaylistOptionsLoaded,
    syncCurrentTrackPlaylistSelection,
  ]);

  useEffect(() => {
    const wasOpen = trackPlaylistWasOpenRef.current;
    if (wasOpen && !trackPlaylistMenuOpen) {
      void applyTrackPlaylistDraft();
    }
    trackPlaylistWasOpenRef.current = trackPlaylistMenuOpen;
  }, [applyTrackPlaylistDraft, trackPlaylistMenuOpen]);

  const applySdkState = useCallback(
    (state: any) => {
      if (!state) return;
      lastPlaybackSnapshotAtRef.current = Date.now();
      const eventSeq = 0;
      const eventTrackId = resolvePlaybackTrackId(state.track_window?.current_track);
      const eventDeviceId =
        typeof state?.device?.id === "string" ? state.device.id : sdkDeviceIdRef.current;
      const eventAtMs = Date.now();
      const eventMonoMs = getMonotonicNow();
      if (
        !shouldApplyIngest({
          source: "sdk",
          seq: eventSeq,
          atMs: eventAtMs,
          deviceId: eventDeviceId ?? null,
          trackId: eventTrackId,
          isPlaying: typeof state?.paused === "boolean" ? !state.paused : null,
        }, {
          receivedMonoMs: eventMonoMs,
          snapshotDeviceId: eventDeviceId ?? null,
        })
      ) {
        return;
      }
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
      if (
        stateDeviceId &&
        activeDeviceIdRef.current &&
        stateDeviceId !== activeDeviceIdRef.current &&
        Date.now() - lastDeviceSelectRef.current < DEVICE_SELECTION_HOLD_MS
      ) {
        setConnectConflict(
          state?.device?.name
            ? `Connect change detected on ${state.device.name}.`
            : "Connect change detected on another device."
        );
      } else if (
        !stateDeviceId ||
        !activeDeviceIdRef.current ||
        stateDeviceId === activeDeviceIdRef.current
      ) {
        setConnectConflict(null);
      }
      if (pendingDeviceIdRef.current && stateDeviceId === pendingDeviceIdRef.current) {
        setActiveDevice(stateDeviceId, state?.device?.name ?? null);
        setActiveDeviceRestricted(Boolean(state?.device?.is_restricted));
        setActiveDevicePrivateSession(Boolean(state?.device?.is_private_session));
        setActiveDeviceSupportsVolume(state?.device?.supports_volume !== false);
        setHandoffPhase("device_ready", "sdk_state_resolved_pending", {
          targetDeviceId: stateDeviceId ?? null,
        });
        refreshAuthorityMode("sdk_state_resolved_pending", stateDeviceId ?? null);
        setDeviceReady(true);
      }
      const current = state.track_window?.current_track;
      const trackId = resolvePlaybackTrackId(current);
      const matchTrackIds = resolvePlaybackTrackIds(current);
      const sdkSaysPlaying = !state.paused;
      const allowBootstrapFromSdk =
        hasConfirmedLivePlaybackRef.current || playbackTouched || sdkSaysPlaying;
      if (!allowBootstrapFromSdk) {
        return;
      }
      if (!trackId || matchTrackIds.length === 0) {
        const noTrackTransition = decideNoTrackTransition({
          source: "sdk",
          isPlaying: sdkSaysPlaying,
          snapshotDeviceId: stateDeviceId ?? eventDeviceId ?? null,
          fallbackStatus: sdkSaysPlaying ? "playing" : "paused",
          nowMs: Date.now(),
          confidence: 0.65,
        });
        if (noTrackTransition.preserved || !noTrackTransition.hardClear) {
          return;
        }
        clearPlaybackViewState(eventMonoMs, "sdk", sdkSaysPlaying);
        return;
      }
      lastPlayableTrackSeenAtRef.current = Date.now();
      const rawPosition = state.position ?? 0;
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
        if (!state.paused) {
          playbackRestrictionUntilRef.current = 0;
        }
      }
      const allowProgressUpdate = Date.now() >= trackChangeLockUntilRef.current;
      const projectedPosition = isNewTrack || !allowProgressUpdate ? 0 : rawPosition;
      const guarded = applyPendingSeekGuard(projectedPosition, eventMonoMs);
      const reconciledPosition = reconcileProgressPosition(
        lastKnownPositionRef.current,
        guarded.positionMs,
        Boolean(isNewTrack || guarded.hardSync)
      );
      setPlayerState((prev) => {
        const next = {
          name: current?.name ?? prev?.name ?? "Unknown track",
          artists: (current?.artists ?? [])
            .map((a: any) => a.name)
            .join(", "),
          album: current?.album?.name ?? prev?.album ?? "",
          coverUrl: current?.album?.images?.[0]?.url ?? prev?.coverUrl ?? null,
          paused: Boolean(state.paused),
          positionMs: reconciledPosition,
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
      if (!isScrubbingRef.current) {
        applyProgressPosition(reconciledPosition, eventMonoMs);
      }
      setDurationMs(nextDuration);
      setPlaybackTrackState(trackId, {
        matchTrackIds,
        isPlaying: sdkSaysPlaying,
        status: state.paused ? "paused" : "playing",
        stale: false,
        source: "sdk",
        confidence: 1,
        positionMs: reconciledPosition,
        durationMs: nextDuration,
        errorMessage: null,
        updatedAt: Date.now(),
      });
      resetNoTrackCounter("sdk_valid_track");
      confirmPendingHandoffOnPlayback(trackId, "sdk", stateDeviceId ?? eventDeviceId ?? null);
      setPlaybackDisallows((prev) => {
        if (!prev || (!prev.pausing && !prev.resuming)) return prev;
        return {
          ...prev,
          pausing: false,
          resuming: false,
        };
      });
      syncQueuePositionFromTrack(trackId);
      if (trackId && Date.now() - lastProgressSyncRef.current > 5000) {
        lastProgressSyncRef.current = Date.now();
      }
      if (trackId) {
        hasConfirmedLivePlaybackRef.current = true;
      }
    },
    [
      applyPendingSeekGuard,
      applyProgressPosition,
      clearPlaybackViewState,
      confirmPendingHandoffOnPlayback,
      decideNoTrackTransition,
      getMonotonicNow,
      playbackTouched,
      reconcileProgressPosition,
      refreshAuthorityMode,
      resetNoTrackCounter,
      setHandoffPhase,
      setPlaybackTrackState,
      setActiveDevice,
      shouldApplyIngest,
      syncQueuePositionFromTrack,
    ]
  );

  useEffect(() => {
    accessTokenRef.current = accessToken;
    accessTokenExpiresAtRef.current =
      typeof accessTokenExpiresAt === "number" ? accessTokenExpiresAt : null;
  }, [accessToken, accessTokenExpiresAt]);

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
          setSdkLastError("Spotify Premium is required for Web Playback.");
          setSdkLifecycle("error");
          setError("Spotify Premium is required for Web Playback.");
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
      if (verifyTimerRef.current) clearTimeout(verifyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    durationMsRef.current = durationMs;
    if (scrubPositionRef.current === null) return;
    const clamped = clampProgressMs(scrubPositionRef.current);
    if (clamped !== scrubPositionRef.current) {
      setScrubPreview(clamped);
    }
  }, [clampProgressMs, durationMs, setScrubPreview]);

  const refreshDevices = useCallback(async (force = false) => {
    if (force || !accessTokenRef.current) {
      await refreshClientAccessToken(force);
    }
    const now = Date.now();
    const hidden =
      typeof document !== "undefined" && document.visibilityState === "hidden";
    const minRefreshGapMs = force ? 2000 : hidden ? 6000 : 3500;
    if (now - lastDevicesRefreshRef.current < minRefreshGapMs) return;
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
    const shouldFetchPlaybackForDeviceMerge =
      force &&
      now - lastDevicesPlaybackFetchRef.current >= 20_000 &&
      !Array.isArray(data?.devices);
    if (shouldFetchPlaybackForDeviceMerge) {
      try {
        const playbackRes = await spotifyApiFetch("https://api.spotify.com/v1/me/player");
        if (playbackRes?.ok) {
          playbackState = await playbackRes.json().catch(() => null);
          lastDevicesPlaybackFetchRef.current = Date.now();
        }
      } catch {
        // ignore playback-state merge errors
      }
    }

    setDevicesLoaded(true);
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
          : `unavailable:${String(d?.name ?? "Unknown")}:${String(
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
        name: d?.name ?? "Unknown device",
        isActive: Boolean(d.is_active),
        type: isLocalSdkDevice ? localWebplayerType : d?.type ?? "Unknown",
        isRestricted: Boolean(d.is_restricted),
        isPrivateSession: Boolean(d.is_private_session),
        supportsVolume: d.supports_volume !== false,
        selectable: Boolean(d?.id),
        unavailableReason:
          typeof d?.id === "string" && d.id
            ? null
            : "Open Spotify on this device and start a track so it becomes available as a Connect device.",
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
    if (
      selectedDevice?.id &&
      (selectionHeld || !active?.id || active.id === selectedDevice.id)
    ) {
      setActiveDevice(selectedDevice.id, selectedDevice.name ?? null);
      setActiveDeviceRestricted(Boolean(selectedDevice.isRestricted));
      setActiveDevicePrivateSession(Boolean(selectedDevice.isPrivateSession));
      setActiveDeviceSupportsVolume(selectedDevice.supportsVolume !== false);
    } else if (active?.id) {
      lastConfirmedActiveDeviceRef.current = { id: active.id, at: Date.now() };
      setActiveDevice(active.id, active.name ?? null);
      setActiveDeviceRestricted(Boolean(active.isRestricted));
      setActiveDevicePrivateSession(Boolean(active.isPrivateSession));
      setActiveDeviceSupportsVolume(active.supportsVolume !== false);
    } else if (sdkDevice?.id && canUseSdk && !activeDeviceIdRef.current) {
      setActiveDevice(sdkDevice.id, sdkDevice.name ?? localWebplayerName);
      setActiveDeviceRestricted(Boolean(sdkDevice.isRestricted));
      setActiveDevicePrivateSession(Boolean(sdkDevice.isPrivateSession));
      setActiveDeviceSupportsVolume(sdkDevice.supportsVolume !== false);
    } else if (sdkDevice?.id && canUseSdk && preferSdkDeviceRef.current && !active?.id) {
      setActiveDevice(sdkDevice.id, sdkDevice.name ?? localWebplayerName);
      setActiveDeviceRestricted(Boolean(sdkDevice.isRestricted));
      setActiveDevicePrivateSession(Boolean(sdkDevice.isPrivateSession));
      setActiveDeviceSupportsVolume(sdkDevice.supportsVolume !== false);
    }
  }, [
    canUseSdk,
    localWebplayerName,
    localWebplayerType,
    refreshClientAccessToken,
    setActiveDevice,
    spotifyApiFetch,
  ]);

  useEffect(() => {
    if (!accessToken) return;
    if (!shouldOwnPlaybackSync) return;
    void refreshDevices(true);
  }, [accessToken, refreshDevices, shouldOwnPlaybackSync]);

  const startLocalWebPlayerFromConnect = useCallback(() => {
    preferSdkDeviceRef.current = true;
    setSdkLifecycle("connecting");
    void kickstartLocalPlayer();
    for (const delay of LOCAL_PLAYER_BOOT_RETRY_MS) {
      window.setTimeout(() => {
        void refreshDevices(true);
      }, delay);
    }
  }, [kickstartLocalPlayer, refreshDevices]);

  const queueDeferredPlayIntent = useCallback(
    (intent: DeferredPlayIntent) => {
      pendingPlayIntentRef.current = intent;
      pendingPlayIntentProcessingRef.current = false;
      setPendingPlayIntentVersion((prev) => prev + 1);
      setPlaybackTouched(true);
      setPlaybackBootState((prev) => (prev === "playing" ? prev : "booting"));
      setError("Player is starting. Playback will continue automatically.");
      emitPlaybackMetric("play_intent_deferred", 1, { kind: intent.kind });
      void kickstartLocalPlayer();
      void refreshDevices(true);
    },
    [emitPlaybackMetric, kickstartLocalPlayer, refreshDevices]
  );

  async function waitForPlayableDevice(timeoutMs = PLAYBACK_READY_TIMEOUT_MS) {
    const token = accessTokenRef.current ?? (await refreshClientAccessToken(false));
    if (!token) return null;

    const startedAt = Date.now();
    let lastRefreshAt = 0;
    let lastCandidate: string | null = null;

    while (Date.now() - startedAt < timeoutMs) {
      const candidate =
        activeDeviceIdRef.current || deviceIdRef.current || sdkDeviceIdRef.current || null;
      if (candidate) {
        lastCandidate = candidate;
        const ready = await ensureActiveDevice(candidate, token, true);
        if (ready) {
          emitPlaybackMetric("playback_ready_wait_ms", Date.now() - startedAt, {
            outcome: "ready",
          });
          return candidate;
        }
      }

      if (Date.now() - lastRefreshAt >= PLAYBACK_READY_REFRESH_EVERY_MS) {
        lastRefreshAt = Date.now();
        if (canUseSdk && !sdkReadyRef.current) {
          void kickstartLocalPlayer();
        }
        await refreshDevices(true);
      }

      await new Promise((resolve) => setTimeout(resolve, PLAYBACK_READY_POLL_MS));
    }

    emitPlaybackMetric("playback_ready_wait_ms", Date.now() - startedAt, {
      outcome: "timeout",
      hadCandidate: Boolean(lastCandidate),
    });
    return null;
  }

  useEffect(() => {
    if (!connectDockOpen) return;
    refreshDevices(true);
  }, [connectDockOpen, refreshDevices]);

  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    if (!shouldOwnPlaybackSync) return;
    const hidden =
      typeof document !== "undefined" && document.visibilityState === "hidden";
    const intervalMs = hidden ? 20_000 : connectDockOpen ? 10_000 : 16_000;
    const interval = window.setInterval(() => {
      void refreshDevices(false);
    }, intervalMs);
    return () => clearInterval(interval);
  }, [connectDockOpen, refreshDevices, sessionStatus, shouldOwnPlaybackSync]);

  useEffect(() => {
    if (!canUseSdk || !accessToken) return;
    if (!shouldOwnPlaybackSync) return;
    if (sdkReadyRef.current || playerRef.current) return;
    if (autoBootAttemptedRef.current) return;
    autoBootAttemptedRef.current = true;
    startLocalWebPlayerFromConnect();
  }, [accessToken, canUseSdk, shouldOwnPlaybackSync, startLocalWebPlayerFromConnect]);

  useEffect(() => {
    if (!canUseSdk) return;
    if (!shouldOwnPlaybackSync) return;
    if (sdkReadyState) return;
    if (sdkLifecycle !== "connecting") return;
    if (sdkLastError) return;
    const timer = window.setTimeout(() => {
      if (sdkReadyRef.current) return;
      const ua = navigator.userAgent.toLowerCase();
      const isIOS = /iphone|ipad|ipod/.test(ua);
      if (isIOS) {
        setSdkLastError(
          "Web player is waiting for an iOS user gesture. Tap Play and try again."
        );
      } else {
        setSdkLastError(
          "Web player could not become ready. Check Premium, scopes, and the active Spotify session."
        );
      }
      setSdkLifecycle("error");
    }, 12000);
    return () => window.clearTimeout(timer);
  }, [canUseSdk, sdkLifecycle, sdkLastError, sdkReadyState, shouldOwnPlaybackSync]);

  useEffect(() => {
    if (!canUseSdk) return;
    if (!shouldOwnPlaybackSync) return;
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
          setSdkLastError("Local web player stays offline. Use ↻ or open the Spotify app.");
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
  }, [canUseSdk, refreshDevices, shouldOwnPlaybackSync]);

  useEffect(() => {
    if (!canUseSdk) return;
    if (!shouldOwnPlaybackSync) return;
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
  }, [canUseSdk, kickstartLocalPlayer, shouldOwnPlaybackSync]);

  useEffect(() => {
    if (!accessToken || !playbackAllowed) {
      setPlaybackBootState("idle");
      return;
    }
    const hasDevice = Boolean(
      activeDeviceId || deviceId || activeDeviceIdRef.current || deviceIdRef.current
    );
    if (playerState?.paused === false) {
      setPlaybackBootState("playing");
      return;
    }
    if (!hasDevice && canUseSdk && !sdkReadyState) {
      setPlaybackBootState("booting");
      return;
    }
    if (!hasDevice && sdkReadyState) {
      setPlaybackBootState("sdk_ready");
      return;
    }
    if (hasDevice && !deviceReady) {
      setPlaybackBootState("device_ready");
      return;
    }
    setPlaybackBootState("playable");
  }, [
    accessToken,
    activeDeviceId,
    canUseSdk,
    deviceId,
    deviceReady,
    playbackAllowed,
    playerState?.paused,
    sdkReadyState,
  ]);

  useEffect(() => {
    const pending = pendingPlayIntentRef.current;
    if (!pending) return;
    if (pendingPlayIntentProcessingRef.current || commandBusy) return;
    if (Date.now() - pending.createdAt > PLAYBACK_INTENT_MAX_AGE_MS) {
      pendingPlayIntentRef.current = null;
      pendingPlayIntentProcessingRef.current = false;
      setPendingPlayIntentVersion((prev) => prev + 1);
      setError("Playback could not start automatically. Choose a track again.");
      emitPlaybackMetric("play_intent_deferred_expired", 1, { kind: pending.kind });
      return;
    }

    const token = accessTokenRef.current;
    if (!token) return;

    const hasDevice = Boolean(
      activeDeviceIdRef.current || deviceIdRef.current || sdkDeviceIdRef.current
    );
    if (!hasDevice) {
      if (shouldOwnPlaybackSync && canUseSdk && !sdkReadyRef.current) {
        void kickstartLocalPlayer();
      }
      if (shouldOwnPlaybackSync) {
        void refreshDevices(true);
      }
      return;
    }
    if (!deviceReady) {
      if (shouldOwnPlaybackSync) {
        void refreshDevices(false);
      }
      return;
    }

    const api = playerApiRef.current;
    if (!api) return;

    pendingPlayIntentProcessingRef.current = true;
    pendingPlayIntentRef.current = null;
    setPendingPlayIntentVersion((prev) => prev + 1);

    void (async () => {
      playIntentReplayRef.current = true;
      try {
        if (pending.kind === "queue") {
          await api.playQueue(pending.uris, pending.offsetUri, pending.offsetIndex);
        } else {
          await api.playContext(
            pending.contextUri,
            pending.offsetPosition,
            pending.offsetUri
          );
        }
        setError(null);
        emitPlaybackMetric("play_intent_deferred_flushed", 1, { kind: pending.kind });
      } catch {
        setError("Unable to play track right now.");
      } finally {
        playIntentReplayRef.current = false;
        pendingPlayIntentProcessingRef.current = false;
      }
    })();
  }, [
    canUseSdk,
    commandBusy,
    deviceReady,
    emitPlaybackMetric,
    kickstartLocalPlayer,
    pendingPlayIntentVersion,
    refreshDevices,
    shouldOwnPlaybackSync,
  ]);

  useEffect(() => {
    if (!canUseSdk) {
      if (playerCleanupRef.current) {
        playerCleanupRef.current();
        playerCleanupRef.current = null;
      }
      readyRef.current = false;
      sdkReadyRef.current = false;
      autoBootAttemptedRef.current = false;
      setSdkReadyState(false);
      setSdkLastError(null);
      setSdkLifecycle("idle");
      playerRef.current = null;
      setPlaybackTrackState(null, {
        isPlaying: false,
        status: "idle",
        stale: false,
        source: "system",
        confidence: 0,
        positionMs: 0,
        durationMs: 0,
        errorMessage: null,
        updatedAt: Date.now(),
      });
      setCurrentTrackLiked(null);
      setDeviceReady(false);
      if (accessToken && !playbackAllowed) {
        setError("Missing Spotify permissions. Reconnect.");
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
        const expiresSoon =
          typeof accessTokenExpiresAtRef.current === "number" &&
          accessTokenExpiresAtRef.current - Date.now() <= 120_000;
        if (token && !expiresSoon) {
          cb(token);
          return;
        }
        void refreshClientAccessToken(expiresSoon).then((fresh) => {
          if (fresh) {
            cb(fresh);
            return;
          }
          if (token) cb(token);
        });
      },
      volume: 0.5,
    });

    const onSdkReady = async ({ device_id }: { device_id: string }) => {
      const hasUserPlaybackIntent =
        playbackTouched ||
        userIntentSeqRef.current > 0 ||
        Boolean(pendingPlayIntentRef.current);
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
      refreshAuthorityMode("sdk_ready", device_id);
      reconnectAttemptsRef.current = 0;
      lastSdkEventAtRef.current = Date.now();
      if (shouldPreferSdk && hasUserPlaybackIntent) {
        preferSdkDeviceRef.current = true;
        // Prefer local webplayer only after explicit playback intent.
        setActiveDevice(device_id, localWebplayerName);
        setActiveDeviceRestricted(false);
        setActiveDevicePrivateSession(false);
        setActiveDeviceSupportsVolume(true);
      }
      if (accessTokenRef.current) {
        let ready = true;
        if (shouldPreferSdk && hasUserPlaybackIntent) {
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
            const disallowsRaw = data?.actions?.disallows;
            setPlaybackDisallows(
              disallowsRaw && typeof disallowsRaw === "object"
                ? Object.fromEntries(
                    Object.entries(disallowsRaw).map(([key, value]) => [
                      key,
                      Boolean(value),
                    ])
                  )
                : {}
            );
            const device = data?.device;
            if (device?.id) {
              const shouldAdoptRemote =
                !preferSdkDeviceRef.current ||
                !sdkDeviceIdRef.current ||
                device.id === sdkDeviceIdRef.current;
              if (shouldAdoptRemote) {
                setActiveDevice(device.id, device.name ?? null);
                setActiveDeviceRestricted(Boolean(device.is_restricted));
                setActiveDevicePrivateSession(Boolean(device.is_private_session));
                setActiveDeviceSupportsVolume(device.supports_volume !== false);
                lastConfirmedActiveDeviceRef.current = { id: device.id, at: Date.now() };
              }
            }
            const item = data?.item;
            if (item) {
              const bootstrapPosition = projectRemoteProgressMs(
                data.progress_ms ?? 0,
                Boolean(data?.is_playing),
                typeof data?.timestamp === "number" ? data.timestamp : null
              );
              const guarded = applyPendingSeekGuard(bootstrapPosition, getMonotonicNow());
              const reconciledBootstrapPosition = reconcileProgressPosition(
                lastKnownPositionRef.current,
                guarded.positionMs,
                guarded.hardSync
              );
              setPlayerState({
                name: item.name ?? "Unknown track",
                artists: (item.artists ?? []).map((a: any) => a.name).join(", "),
                album: item.album?.name ?? "",
                coverUrl: item.album?.images?.[0]?.url ?? null,
                paused: Boolean(!data.is_playing),
                positionMs: reconciledBootstrapPosition,
                durationMs: item.duration_ms ?? 0,
              });
              if (!isScrubbingRef.current) {
                applyProgressPosition(reconciledBootstrapPosition);
              }
              setDurationMs(item.duration_ms ?? 0);
              const bootstrapTrackId = resolvePlaybackTrackId(item);
              const bootstrapMatchTrackIds = resolvePlaybackTrackIds(item);
              setPlaybackTrackState(bootstrapTrackId, {
                matchTrackIds: bootstrapMatchTrackIds,
                isPlaying: Boolean(data?.is_playing),
                status: data?.is_playing ? "playing" : "paused",
                stale: false,
                source: "api_bootstrap",
                confidence: 0.9,
                positionMs: reconciledBootstrapPosition,
                durationMs: item.duration_ms ?? 0,
                errorMessage: null,
                updatedAt: Date.now(),
              });
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
      }
      if (!shuffleInitDoneRef.current && accessTokenRef.current) {
        shuffleInitDoneRef.current = true;
        setShuffleOn(false);
        shuffleOnRef.current = false;
        rebuildQueueOrder(false, true);
        if (hasUserPlaybackIntent) {
          await setRemoteShuffleState(false, device_id, accessTokenRef.current, false).catch(
            () => undefined
          );
        }
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
      refreshAuthorityMode("sdk_not_ready", knownSdkId ?? null);
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
      if (!state) {
        const nowMs = Date.now();
        const noTrackTransition = decideNoTrackTransition({
          source: "sdk",
          isPlaying: false,
          snapshotDeviceId: activeDeviceIdRef.current || deviceIdRef.current || null,
          fallbackStatus: "paused",
          nowMs,
          confidence: 0.65,
        });
        if (noTrackTransition.preserved || !noTrackTransition.hardClear) {
          return;
        }
        clearPlaybackViewState(getMonotonicNow(), "sdk", false);
        return;
      }
      applySdkState(state);
      setSdkReadyState(true);
      setDeviceReady(true);
      setSdkLastError(null);
      setSdkLifecycle("ready");
      if (state && !state.paused) {
        setError(null);
      }
    };

    const onInitError = ({ message }: { message: string }) => {
      setSdkReadyState(false);
      setSdkLastError(message);
      setSdkLifecycle("error");
      setError(message);
      setPlaybackTrackState(currentTrackIdRef.current || lastTrackIdRef.current, {
        isPlaying: playbackFocusRef.current.isPlaying,
        status: "error",
        stale: Boolean(playbackFocusRef.current.trackId),
        source: "system",
        confidence: 0.65,
        positionMs: lastKnownPositionRef.current,
        durationMs: durationMsRef.current,
        errorMessage: message,
        updatedAt: Date.now(),
      });
    };
    const onAuthError = async ({ message }: { message: string }) => {
      setSdkLastError(message);
      const refreshed = await refreshClientAccessToken(true);
      if (!refreshed) {
        setSdkReadyState(false);
        setSdkLifecycle("error");
        setError("Spotify-authenticatie verlopen. Koppel Spotify opnieuw.");
        setPlaybackTrackState(currentTrackIdRef.current || lastTrackIdRef.current, {
          isPlaying: playbackFocusRef.current.isPlaying,
          status: "error",
          stale: Boolean(playbackFocusRef.current.trackId),
          source: "system",
          confidence: 0.65,
          positionMs: lastKnownPositionRef.current,
          durationMs: durationMsRef.current,
          errorMessage: "Spotify-authenticatie verlopen. Koppel Spotify opnieuw.",
          updatedAt: Date.now(),
        });
        return;
      }
      try {
        const connected = await playerRef.current?.connect?.();
        if (connected === false) {
          setSdkReadyState(false);
          setSdkLifecycle("error");
          setError("Local web player could not reconnect.");
          setPlaybackTrackState(currentTrackIdRef.current || lastTrackIdRef.current, {
            isPlaying: playbackFocusRef.current.isPlaying,
            status: "error",
            stale: Boolean(playbackFocusRef.current.trackId),
            source: "system",
            confidence: 0.65,
            positionMs: lastKnownPositionRef.current,
            durationMs: durationMsRef.current,
            errorMessage: "Local web player could not reconnect.",
            updatedAt: Date.now(),
          });
          return;
        }
        setSdkReadyState(true);
        setSdkLifecycle("ready");
        setSdkLastError(null);
        setError(null);
      } catch {
        setSdkReadyState(false);
        setSdkLifecycle("error");
        setError("Local web player could not reconnect.");
        setPlaybackTrackState(currentTrackIdRef.current || lastTrackIdRef.current, {
          isPlaying: playbackFocusRef.current.isPlaying,
          status: "error",
          stale: Boolean(playbackFocusRef.current.trackId),
          source: "system",
          confidence: 0.65,
          positionMs: lastKnownPositionRef.current,
          durationMs: durationMsRef.current,
          errorMessage: "Local web player could not reconnect.",
          updatedAt: Date.now(),
        });
      }
    };
    const onAccountError = ({ message }: { message: string }) => {
      setSdkReadyState(false);
      setSdkLastError(message || "Spotify Premium is required for Web Playback.");
      setSdkLifecycle("error");
      setError(message || "Spotify Premium is required for Web Playback.");
      setPlaybackTrackState(currentTrackIdRef.current || lastTrackIdRef.current, {
        isPlaying: playbackFocusRef.current.isPlaying,
        status: "error",
        stale: Boolean(playbackFocusRef.current.trackId),
        source: "system",
        confidence: 0.65,
        positionMs: lastKnownPositionRef.current,
        durationMs: durationMsRef.current,
        errorMessage: message || "Spotify Premium is required for Web Playback.",
        updatedAt: Date.now(),
      });
    };
    const onPlaybackError = ({ message }: { message: string }) => {
      setSdkLastError(message);
      setError(message);
      setSdkLifecycle("error");
      setPlaybackTrackState(currentTrackIdRef.current || lastTrackIdRef.current, {
        isPlaying: playbackFocusRef.current.isPlaying,
        status: "error",
        stale: Boolean(playbackFocusRef.current.trackId),
        source: "system",
        confidence: 0.65,
        positionMs: lastKnownPositionRef.current,
        durationMs: durationMsRef.current,
        errorMessage: message,
        updatedAt: Date.now(),
      });
    };
    const onAutoplayFailed = () => {
      setError("Autoplay is geblokkeerd door de browser. Klik op Play.");
      setPlaybackTrackState(currentTrackIdRef.current || lastTrackIdRef.current, {
        isPlaying: false,
        status: "paused",
        stale: Boolean(playbackFocusRef.current.trackId),
        source: "system",
        confidence: 0.6,
        positionMs: lastKnownPositionRef.current,
        durationMs: durationMsRef.current,
        errorMessage: "Autoplay is geblokkeerd door de browser. Klik op Play.",
        updatedAt: Date.now(),
      });
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
          setSdkLastError("Local web player could not connect.");
          setSdkLifecycle("error");
        }
      })
      .catch(() => {
        setSdkReadyState(false);
        setSdkLastError("Local web player could not connect.");
        setSdkLifecycle("error");
      });
    playerRef.current = player;

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
    };
  }

  const publishedPlayerApi = useMemo<PlayerApi>(
    () => ({
      primePlaybackGesture: () => {
        publishedPlayerHandlersRef.current?.primePlaybackGesture?.();
      },
      playQueue: async (uris, offsetUri, offsetIndex) => {
        const handlers = publishedPlayerHandlersRef.current;
        if (!handlers) throw new Error("PLAYER_NOT_READY");
        return await handlers.playQueue(uris, offsetUri, offsetIndex);
      },
      playContext: async (contextUri, offsetPosition, offsetUri) => {
        const handlers = publishedPlayerHandlersRef.current;
        if (!handlers) throw new Error("PLAYER_NOT_READY");
        return await handlers.playContext(contextUri, offsetPosition, offsetUri);
      },
      togglePlay: async () => {
        const handlers = publishedPlayerHandlersRef.current;
        if (!handlers) throw new Error("PLAYER_NOT_READY");
        return await handlers.togglePlay();
      },
      pause: async () => {
        const handlers = publishedPlayerHandlersRef.current;
        if (!handlers) throw new Error("PLAYER_NOT_READY");
        return await handlers.pause();
      },
      resume: async () => {
        const handlers = publishedPlayerHandlersRef.current;
        if (!handlers) throw new Error("PLAYER_NOT_READY");
        return await handlers.resume();
      },
      seek: async (ms: number) => {
        const handlers = publishedPlayerHandlersRef.current;
        if (!handlers) throw new Error("PLAYER_NOT_READY");
        return await handlers.seek(ms);
      },
      transfer: async (deviceId: string, play?: boolean) => {
        const handlers = publishedPlayerHandlersRef.current;
        if (!handlers) throw new Error("PLAYER_NOT_READY");
        return await handlers.transfer(deviceId, play);
      },
      next: async () => {
        const handlers = publishedPlayerHandlersRef.current;
        if (!handlers) throw new Error("PLAYER_NOT_READY");
        return await handlers.next();
      },
      previous: async () => {
        const handlers = publishedPlayerHandlersRef.current;
        if (!handlers) throw new Error("PLAYER_NOT_READY");
        return await handlers.previous();
      },
    }),
    []
  );

  const playbackApiAvailable =
    playbackSessionReady && playbackAllowed && !premiumRequired;

  // The published controller handlers intentionally refresh with the latest refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    publishedPlayerHandlersRef.current = playbackApiAvailable
      ? createPlayerApiHandlers({
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
          retryAfterMaxMs: PLAYER_RETRY_AFTER_MAX_MS,
          playbackRestrictionCooldownMs: PLAYBACK_RESTRICTION_COOLDOWN_MS,
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
        })
      : null;
  });

  useEffect(() => {
    if (!playbackApiAvailable) {
      playerApiRef.current = null;
      onReady(null);
      onControllerHandlersChange?.(null);
      return;
    }

    playerApiRef.current = publishedPlayerApi;
    onReady(publishedPlayerApi);
    onControllerHandlersChange?.({
      primePlaybackGesture: publishedPlayerApi.primePlaybackGesture,
      playQueue: publishedPlayerApi.playQueue,
      playContext: publishedPlayerApi.playContext,
      togglePlay: publishedPlayerApi.togglePlay,
      pause: publishedPlayerApi.pause,
      resume: publishedPlayerApi.resume,
      seek: publishedPlayerApi.seek,
      transfer: publishedPlayerApi.transfer,
    });

    return () => {
      if (playerApiRef.current === publishedPlayerApi) {
        playerApiRef.current = null;
      }
    };
  }, [
    onControllerHandlersChange,
    onReady,
    playbackApiAvailable,
    publishedPlayerApi,
  ]);

  const playbackPausedUi =
    playPauseOptimisticPaused ?? (playerState?.paused ?? true);
  const isPlaybackPaused = playbackPausedUi;

  useEffect(() => {
    if (playPauseOptimisticPaused === null) return;
    if (typeof playerState?.paused !== "boolean") return;
    if (playerState.paused === playPauseOptimisticPaused) {
      clearPlayPauseOptimisticState();
    }
  }, [
    clearPlayPauseOptimisticState,
    playPauseOptimisticPaused,
    playerState?.paused,
  ]);

  useEffect(() => {
    return () => {
      if (playPauseOptimisticTimerRef.current) {
        clearTimeout(playPauseOptimisticTimerRef.current);
        playPauseOptimisticTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isPlaybackPaused) return;
    let rafId = 0;
    const step = () => {
      if (!isScrubbingRef.current) {
        const nowMono = getMonotonicNow();
        const anchor = progressAnchorRef.current;
        const elapsed = Math.max(0, nowMono - anchor.atMono);
        const next = clampProgressMs(anchor.positionMs + elapsed);
        if (
          nowMono - lastRafPaintMonoRef.current >= 33 ||
          Math.abs(next - lastKnownPositionRef.current) >= 400
        ) {
          setPositionMs(next);
          lastKnownPositionRef.current = next;
          lastRafPaintMonoRef.current = nowMono;
        }
      }
      rafId = window.requestAnimationFrame(step);
    };
    rafId = window.requestAnimationFrame(step);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [clampProgressMs, getMonotonicNow, isPlaybackPaused]);

  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    if (!shouldOwnPlaybackSync) return;
    refreshDevices();
  }, [refreshDevices, sessionStatus, shouldOwnPlaybackSync]);

  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    let cancelled = false;
    const bootstrap = async () => {
      await refreshClientAccessToken(shouldOwnPlaybackSync);
      if (cancelled) return;

      if (shouldOwnPlaybackSync) {
        await refreshDevices(true);
        if (cancelled) return;
        await syncPlaybackState("api_bootstrap").catch(() => undefined);
        return;
      }

      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 1400));
      if (cancelled) return;
      if (Date.now() - lastRemoteSyncAtRef.current < 2500) return;

      await refreshDevices(false);
      if (cancelled) return;
      if (Date.now() - lastRemoteSyncAtRef.current < 2500) return;
      await syncPlaybackState("api_bootstrap").catch(() => undefined);
    };
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [
    refreshClientAccessToken,
    refreshDevices,
    sessionStatus,
    shouldOwnPlaybackSync,
    syncPlaybackState,
  ]);

  useEffect(() => {
    async function restoreLocalSdkAudioIfNeeded() {
      const sdkDeviceId = sdkDeviceIdRef.current;
      const activeDevice = activeDeviceIdRef.current || deviceIdRef.current;
      if (!sdkDeviceId || activeDevice !== sdkDeviceId) return;
      const shouldBePlaying = Boolean(
        lastIsPlayingRef.current || (playerStateRef.current && !playerStateRef.current.paused)
      );
      if (!shouldBePlaying) return;

      try {
        await playerRef.current?.activateElement?.();
      } catch {
        // continue with resume/verify fallback
      }
      try {
        await playerRef.current?.resume?.();
      } catch {
        // continue with verify fallback
      }
      try {
        await ensurePlaybackStartedRef.current(
          sdkDeviceId,
          currentTrackIdRef.current ?? null
        );
      } catch {
        // ignore here; normal sync path will surface actionable errors
      }
    }

    async function handleFocusOrResume() {
      if (!ownPlaybackSyncRef.current) return;
      await refreshClientAccessToken();
      refreshDevices(true);
      await syncPlaybackState("api_sync").catch(() => undefined);
      await restoreLocalSdkAudioIfNeeded();
    }

    const handleWindowResume = () => {
      void handleFocusOrResume();
    };
    function handleVisibility() {
      if (document.visibilityState === "visible") {
        void handleFocusOrResume();
      }
    }
    if (typeof window === "undefined") return;
    window.addEventListener("focus", handleWindowResume);
    window.addEventListener("pageshow", handleWindowResume);
    window.addEventListener("online", handleWindowResume);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleWindowResume);
      window.removeEventListener("pageshow", handleWindowResume);
      window.removeEventListener("online", handleWindowResume);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [
    refreshClientAccessToken,
    refreshDevices,
    syncPlaybackState,
  ]);

  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    if (!accessToken) return;
    if (!shouldOwnPlaybackSync) return;

    let cancelled = false;

    async function restoreSelectedPlaybackDeviceIfNeeded() {
      if (cancelled) return;
      const token = accessTokenRef.current;
      if (!token) return;

      const now = Date.now();
      const hidden =
        typeof document !== "undefined" && document.visibilityState === "hidden";
      const sdkDeviceId = sdkDeviceIdRef.current;
      const selectedDeviceId = activeDeviceIdRef.current || deviceIdRef.current || null;
      const shouldBePlaying = Boolean(
        lastIsPlayingRef.current || (playerStateRef.current && !playerStateRef.current.paused)
      );
      const hasPendingPlaybackIntent = Boolean(
        pendingPlayIntentRef.current || pendingPlayIntentProcessingRef.current
      );
      const selectedSdkDevice =
        Boolean(sdkDeviceId) &&
        Boolean(selectedDeviceId) &&
        selectedDeviceId === sdkDeviceId;
      const keepaliveRelevant =
        shouldBePlaying ||
        hasPendingPlaybackIntent ||
        selectedSdkDevice ||
        (preferSdkDeviceRef.current && Boolean(sdkDeviceId));

      if (!keepaliveRelevant || commandBusy) return;

      if (sdkDeviceId && (preferSdkDeviceRef.current || selectedSdkDevice)) {
        setActiveDevice(sdkDeviceId, localWebplayerName);
        if (!sdkReadyRef.current || !playerRef.current) {
          void kickstartLocalPlayer();
        } else {
          try {
            await playerRef.current?.activateElement?.();
          } catch {
            // keepalive continues with device verification
          }
          try {
            await playerRef.current?.connect?.();
          } catch {
            // ignore; ensureActiveDevice path below will verify actual state
          }
        }
      }

      const targetDeviceId =
        selectedDeviceId ||
        (preferSdkDeviceRef.current ? sdkDeviceId ?? null : null);
      if (!targetDeviceId) return;

      const lastConfirmedAt = lastConfirmedActiveDeviceRef.current?.at ?? 0;
      const needsDeviceVerification =
        !deviceReady ||
        now - lastConfirmedAt > (hidden ? 10_000 : 7_000) ||
        hasPendingPlaybackIntent;
      if (needsDeviceVerification) {
        const ready = await ensureActiveDeviceRef.current(
          targetDeviceId,
          token,
          shouldBePlaying || hasPendingPlaybackIntent
        );
        if (cancelled) return;
        setDeviceReady(ready);
        if (!ready) {
          void refreshDevices(true);
          return;
        }
        setActiveDevice(
          targetDeviceId,
          targetDeviceId === sdkDeviceId ? localWebplayerName : activeDeviceNameRef.current
        );
      }

      if (shouldBePlaying || hasPendingPlaybackIntent) {
        try {
          await ensurePlaybackStartedRef.current(
            targetDeviceId,
            currentTrackIdRef.current ?? lastTrackIdRef.current ?? null
          );
        } catch {
          void syncPlaybackStateRef.current("api_verify").catch(() => undefined);
        }
      } else if (!hidden) {
        void syncPlaybackStateRef.current("api_sync").catch(() => undefined);
      }
    }

    const runKeepalive = () => {
      void restoreSelectedPlaybackDeviceIfNeeded();
    };

    const intervalMs =
      typeof document !== "undefined" && document.visibilityState === "hidden"
        ? 9_000
        : 6_000;
    const interval = window.setInterval(runKeepalive, intervalMs);
    runKeepalive();

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    accessToken,
    commandBusy,
    deviceReady,
    kickstartLocalPlayer,
    localWebplayerName,
    refreshDevices,
    sessionStatus,
    setActiveDevice,
    shouldOwnPlaybackSync,
  ]);

  useEffect(() => {
    if (queueOpen) {
      fetchQueue().catch(() => undefined);
    }
  }, [queueOpen, fetchQueue]);

  useEffect(() => {
    if (!queueOpen || !currentTrackIdState) return;
    const timeoutId = window.setTimeout(() => {
      fetchQueue().catch(() => undefined);
    }, 320);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [queueOpen, currentTrackIdState, fetchQueue]);

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
    if (!shouldOwnPlaybackSync) return;
    let cancelled = false;

    async function poll() {
      try {
        const token = accessTokenRef.current;
        if (!token || cancelled) return;
        const now = Date.now();
        const activeDevice = activeDeviceIdRef.current;
        const sdkDevice = sdkDeviceIdRef.current;
        const remoteDeviceActive = Boolean(
          activeDevice && sdkDevice && activeDevice !== sdkDevice
        );
        const streamFresh =
          enablePlaybackStream && Date.now() - lastStreamSnapshotAtRef.current < 5500;
        const playbackFresh = Date.now() - lastPlaybackSnapshotAtRef.current < 3500;
        const inDeviceSwitchBoostWindow =
          now < deviceSwitchSyncBoostUntilRef.current;
        const sdkStatePrimary =
          sdkReadyRef.current &&
          Boolean(sdkDevice) &&
          (!activeDevice || activeDevice === sdkDevice);
        if (
          sdkStatePrimary &&
          now - lastSdkEventAtRef.current < 20000 &&
          !remoteDeviceActive
        ) {
          const isPlaying = !playerStateRef.current?.paused;
          scheduleNext(isPlaying, isPlaying ? 12000 : 15000);
          return;
        }
        if (enablePlaybackStream && streamFresh && playbackFresh) {
          const isPlaying = !playerStateRef.current?.paused;
          if (remoteDeviceActive) {
            scheduleNext(isPlaying, isPlaying ? 2200 : 3200);
          } else {
            scheduleNext(isPlaying, isPlaying ? 8500 : 13000);
          }
          return;
        }
        const hidden =
          typeof document !== "undefined" && document.visibilityState === "hidden";
        const remoteTabRecentlySynced = now - lastRemoteSyncAtRef.current < 1200;
        if (
          remoteTabRecentlySynced &&
          !hidden &&
          !pendingSeekRef.current &&
          !remoteDeviceActive &&
          !inDeviceSwitchBoostWindow
        ) {
          const isPlaying = !playerStateRef.current?.paused;
          scheduleNext(isPlaying, isPlaying ? 5500 : 9500);
          return;
        }
        const minRequestGapMs = remoteDeviceActive
          ? streamFresh
            ? 1400
            : 1000
          : 1200;
        if (now - lastRequestAtRef.current < minRequestGapMs) {
          scheduleNext();
          return;
        }
        if (
          commandBusy ||
          pendingPlayIntentRef.current ||
          pendingPlayIntentProcessingRef.current
        ) {
          scheduleNext(undefined, 900);
          return;
        }
        if (now < rateLimitRef.current.until) {
          scheduleNext();
          return;
        }
        lastRequestAtRef.current = now;
        const requestEpoch = operationEpochRef.current;
        await syncPlaybackState("api_poll", requestEpoch);
        if (requestEpoch < operationEpochRef.current) {
          scheduleNext();
          return;
        }
        setError(null);
        postCrossTabEvent({
          type: "sync",
          at: Date.now(),
          source: "api_poll",
          seq: operationEpochRef.current,
        });
        scheduleNext(lastIsPlayingRef.current);
      } catch {
        if (!cancelled) {
          scheduleNext();
        }
      }
    }

    function scheduleNext(isPlaying?: boolean, overrideDelay?: number) {
      if (cancelled) return;
      const now = Date.now();
      const hidden =
        typeof document !== "undefined" && document.visibilityState === "hidden";
      const hasPendingSeek = Boolean(pendingSeekRef.current);
      const activeDevice = activeDeviceIdRef.current;
      const sdkDevice = sdkDeviceIdRef.current;
      const remoteDeviceActive = Boolean(
        activeDevice && sdkDevice && activeDevice !== sdkDevice
      );
      const streamFresh =
        enablePlaybackStream && now - lastStreamSnapshotAtRef.current < 5500;
      const inDeviceSwitchBoostWindow =
        now < deviceSwitchSyncBoostUntilRef.current;
      const connectionInfo =
        typeof navigator !== "undefined" &&
        "connection" in navigator &&
        (navigator as Navigator & {
          connection?: { effectiveType?: string; saveData?: boolean };
        }).connection
          ? (navigator as Navigator & {
              connection: { effectiveType?: string; saveData?: boolean };
            }).connection
          : null;
      const saveData = Boolean(connectionInfo?.saveData);
      const effectiveType = String(connectionInfo?.effectiveType ?? "").toLowerCase();
      const lowBandwidthMode =
        saveData ||
        effectiveType === "2g" ||
        effectiveType === "slow-2g" ||
        effectiveType === "3g";
      let baseDelay = isPlaying ? 3000 : 9000;
      if (remoteDeviceActive) {
        baseDelay = streamFresh ? (isPlaying ? 2200 : 3200) : isPlaying ? 1200 : 1800;
      } else if (enablePlaybackStream && streamFresh) {
        baseDelay = isPlaying ? 6500 : 11000;
      }
      if (inDeviceSwitchBoostWindow) {
        baseDelay = Math.min(baseDelay, isPlaying ? 900 : 1500);
      }
      if (hidden && !hasPendingSeek) {
        baseDelay = remoteDeviceActive ? 22000 : 30000;
      }
      if (hasPendingSeek) {
        baseDelay = 1500;
      }
      if (lowBandwidthMode && !hasPendingSeek) {
        baseDelay = Math.max(baseDelay, isPlaying ? 5500 : 12500);
      }
      const base = overrideDelay ?? baseDelay;
      const waitExtra = Math.max(rateLimitRef.current.until - Date.now(), 0);
      const delay = Math.min(base + waitExtra, 20000);
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
    commandBusy,
    enablePlaybackStream,
    postCrossTabEvent,
    shouldOwnPlaybackSync,
    syncPlaybackState,
  ]);

  async function handleDeviceChange(targetId: string) {
    const token = accessTokenRef.current;
    if (!token || !targetId) return;
    const targetDevice = devices.find((device) => device.id === targetId);
    if (!targetDevice?.selectable) {
      setError(
        targetDevice?.unavailableReason ||
          "This device is not available yet. Open Spotify on the device and try again."
      );
      return;
    }
    if (Date.now() < rateLimitRef.current.until) return;
    const previousActiveDeviceId =
      activeDeviceIdRef.current || deviceIdRef.current || null;
    const operationEpoch = beginOperationEpoch();
    deviceSwitchSyncBoostUntilRef.current = Date.now() + DEVICE_SWITCH_SYNC_BOOST_MS;
    setConnectConflict(null);
    preferSdkDeviceRef.current = targetId === sdkDeviceIdRef.current;
    if (targetId === sdkDeviceIdRef.current) {
      try {
        await playerRef.current?.activateElement?.();
      } catch {
        // ignore activation failure; selection can still proceed
      }
    }
    pendingDeviceIdRef.current = targetId;
    lastDeviceSelectRef.current = Date.now();
    refreshAuthorityMode("device_switch_requested", targetId);
    setHandoffPhase("requested", "device_switch_requested", {
      targetDeviceId: targetId,
    });
    const deviceName = targetDevice?.name ?? devices.find((d) => d.id === targetId)?.name;
    setActiveDevice(targetId, deviceName ?? null);
    setActiveDeviceRestricted(Boolean(targetDevice.isRestricted));
    setActiveDevicePrivateSession(Boolean(targetDevice.isPrivateSession));
    setActiveDeviceSupportsVolume(targetDevice.supportsVolume !== false);
    lastConfirmedActiveDeviceRef.current = null;
    setDeviceReady(false);
    setDeviceId(targetId);
    deviceIdRef.current = targetId;
    const switchContext = await captureDeviceSwitchContext();
    const shouldResume = switchContext.wasPlaying;
    await enqueuePlaybackCommand(async () => {
      const ready = await ensureActiveDevice(
        targetId,
        token,
        false,
        previousActiveDeviceId
      );
      if (ready) {
        lastConfirmedActiveDeviceRef.current = { id: targetId, at: Date.now() };
        setHandoffPhase("device_ready", "device_switch_ready", {
          targetDeviceId: targetId,
        });
        refreshAuthorityMode("device_switch_ready", targetId);
      } else if (pendingDeviceIdRef.current === targetId) {
        clearPendingDevice("device_switch_failed", targetId);
        setHandoffPhase("failed", "device_switch_failed", {
          targetDeviceId: targetId,
        });
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
      if (ready && shouldResume) {
        const resumed = await resumeAfterDeviceSwitch(targetId, switchContext);
        if (!resumed) {
          setError("Resuming playback on this device did not succeed immediately.");
        } else {
          setError(null);
        }
      }
      refreshDevices(true);
      setTimeout(() => refreshDevices(true), 800);
      schedulePlaybackVerify(280, "api_verify", operationEpoch);
      // Force early state convergence after Connect switch.
      void syncPlaybackState("api_sync", operationEpoch).catch(() => undefined);
      setTimeout(() => {
        void syncPlaybackStateRef.current("api_poll", operationEpoch).catch(() => undefined);
      }, 450);
    });
    clearPendingDeviceIfStale();
  }

  async function handleSetPlaybackPaused(
    targetPaused: boolean,
    allowQueueActivation: boolean
  ) {
    setPlaybackTouched(true);
    if (allowQueueActivation && !targetPaused && isCustomQueueActive && !isCurrentTrackFromCustomQueue) {
      const targetQueueId =
        customQueue.currentQueueId ?? customQueue.items[0]?.queueId ?? null;
      if (targetQueueId) {
        customQueue.setCurrentQueueId(targetQueueId);
        await customQueuePlayback.playFromQueue(targetQueueId);
        return;
      }
    }

    const currentPausedSnapshot =
      playPauseOptimisticPaused ?? (playerStateRef.current?.paused ?? true);
    if (currentPausedSnapshot === targetPaused) {
      return;
    }

    const endpoint = targetPaused ? "pause" : "play";
    const token = accessTokenRef.current;
    let currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
    if (token && currentDevice && Date.now() < rateLimitRef.current.until) return;
    setPlayPauseOptimisticState(targetPaused);
    if (!token || !currentDevice) {
      if (token && endpoint === "play") {
        const preparedDevice = await waitForPlayableDevice();
        if (preparedDevice) {
          currentDevice = preparedDevice;
        }
      }
    }
    if (!token || !currentDevice) {
      try {
        await playerRef.current?.togglePlay?.();
      } catch {
        setPlayPauseOptimisticState(currentPausedSnapshot);
      }
      return;
    }
    const operationEpoch = beginOperationEpoch();
    await enqueuePlaybackCommand(async () => {
      if (currentDevice === sdkDeviceIdRef.current) {
        try {
          await playerRef.current?.activateElement?.();
          await playerRef.current?.togglePlay?.();
        } catch {
          setPlayPauseOptimisticState(currentPausedSnapshot);
          setError("Local web player could not execute play/pause.");
          return;
        }
        schedulePlaybackVerify(220, "api_verify", operationEpoch);
        return;
      }
      let targetDevice = currentDevice;
      if (!targetDevice) {
        setError("Spotify‑apparaat is nog niet klaar. Probeer opnieuw.");
        setPlayPauseOptimisticState(currentPausedSnapshot);
        return;
      }
      const ready = await ensureActiveDevice(targetDevice, token, endpoint === "play");
      if (!ready && endpoint === "play") {
        const preparedDevice = await waitForPlayableDevice(5_000);
        if (preparedDevice) {
          currentDevice = preparedDevice;
          targetDevice = preparedDevice;
        }
      }
      if (!targetDevice) {
        setError("Spotify‑apparaat is nog niet klaar. Probeer opnieuw.");
        setPlayPauseOptimisticState(currentPausedSnapshot);
        return;
      }
      const readyAfterPrepare =
        ready || (await ensureActiveDevice(targetDevice, token, endpoint === "play"));
      if (!readyAfterPrepare) {
        setError("Spotify‑apparaat is nog niet klaar. Probeer opnieuw.");
        setPlayPauseOptimisticState(currentPausedSnapshot);
        return;
      }
      const res = await spotifyApiFetch(
        withDeviceId(
          `https://api.spotify.com/v1/me/player/${endpoint}`,
          targetDevice
        ),
        { method: "PUT" }
      );
      if (!res || (!res.ok && res.status !== 204)) {
        setPlayPauseOptimisticState(currentPausedSnapshot);
        return;
      }
      schedulePlaybackVerify(220, "api_verify", operationEpoch);
    });
  }

  async function handleTogglePlay() {
    const currentPausedSnapshot =
      playPauseOptimisticPaused ?? (playerStateRef.current?.paused ?? true);
    await handleSetPlaybackPaused(!currentPausedSnapshot, true);
  }

  async function handlePausePlayback() {
    await handleSetPlaybackPaused(true, false);
  }

  async function handleResumePlayback() {
    await handleSetPlaybackPaused(false, true);
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
    const operationEpoch = beginOperationEpoch();
    await enqueuePlaybackCommand(async () => {
      if (
        currentDevice === sdkDeviceIdRef.current &&
        queueModeRef.current !== "queue"
      ) {
        await playerRef.current?.nextTrack?.();
        schedulePlaybackVerify(220, "api_verify", operationEpoch);
        return;
      }
      if (queueModeRef.current === "queue" && queueUrisRef.current?.length) {
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
      schedulePlaybackVerify(220, "api_verify", operationEpoch);
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
    const operationEpoch = beginOperationEpoch();
    await enqueuePlaybackCommand(async () => {
      if (
        currentDevice === sdkDeviceIdRef.current &&
        queueModeRef.current !== "queue"
      ) {
        await playerRef.current?.previousTrack?.();
        schedulePlaybackVerify(220, "api_verify", operationEpoch);
        return;
      }
      if (queueModeRef.current === "queue" && queueUrisRef.current?.length) {
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
      schedulePlaybackVerify(220, "api_verify", operationEpoch);
    });
  }

  async function handleToggleShuffle() {
    setPlaybackTouched(true);
    const token = accessTokenRef.current;
    const currentDevice = activeDeviceIdRef.current || deviceIdRef.current;
    if (!token || !currentDevice || shufflePendingRef.current) return;
    if (Date.now() < rateLimitRef.current.until) return;
    const operationEpoch = beginOperationEpoch();
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
        schedulePlaybackVerify(260, "api_verify", operationEpoch);
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
    const operationEpoch = beginOperationEpoch();
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
        schedulePlaybackVerify(260, "api_verify", operationEpoch);
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

  const readSliderValue = useCallback((raw: string) => {
    const parsed = Number(raw);
    return clampProgressMs(Number.isFinite(parsed) ? parsed : 0);
  }, [clampProgressMs]);

  async function handleSeek(nextMs: number) {
    if (playbackDisallows.seeking) return;
    setPlaybackTouched(true);
    const token = accessTokenRef.current;
    const fallbackDevice =
      activeDeviceIdRef.current || deviceIdRef.current || sdkDeviceIdRef.current;
    const previousMs = lastKnownPositionRef.current;
    const targetMs = applyProgressPosition(nextMs);
    if (!token || !fallbackDevice) {
      pendingSeekRef.current = null;
      return;
    }
    if (Date.now() < rateLimitRef.current.until) {
      pendingSeekRef.current = null;
      return;
    }
    const operationEpoch = beginOperationEpoch();
    lastUserSeekAtRef.current = Date.now();
    const seekSeq = ++seekRequestSeqRef.current;
    pendingSeekRef.current = {
      id: seekSeq,
      targetMs,
      previousMs,
      startedMonoMs: getMonotonicNow(),
      epoch: operationEpoch,
    };
    if (seekTimerRef.current) clearTimeout(seekTimerRef.current);
    seekTimerRef.current = setTimeout(async () => {
      if (seekSeq !== seekRequestSeqRef.current) return;
      try {
        await enqueuePlaybackCommand(async () => {
          if (seekSeq !== seekRequestSeqRef.current) return;
          const currentDevice =
            activeDeviceIdRef.current || deviceIdRef.current || fallbackDevice;
          if (!currentDevice) return;
          if (currentDevice === sdkDeviceIdRef.current) {
            await playerRef.current?.seek?.(targetMs);
            schedulePlaybackVerify(180, "api_verify", operationEpoch);
            return;
          }
          const ready = await ensureActiveDevice(currentDevice, token, false);
          if (!ready) {
            setError("Spotify‑apparaat is nog niet klaar. Probeer opnieuw.");
            return;
          }
          const seekRes = await spotifyApiFetch(
            withDeviceId(
              `https://api.spotify.com/v1/me/player/seek?position_ms=${Math.floor(
                targetMs
              )}`,
              currentDevice
            ),
            { method: "PUT" }
          );
          if (seekRes && !seekRes.ok && seekRes.status !== 204) {
            throw new Error("SPOTIFY_SEEK_FAILED");
          }
          schedulePlaybackVerify(180, "api_verify", operationEpoch);
        });
      } catch {
        const pending = pendingSeekRef.current;
        if (pending && pending.id === seekSeq) {
          pendingSeekRef.current = null;
          applyProgressPosition(pending.previousMs);
        }
        setError("Seek kon niet bevestigd worden. Positie is hersteld.");
      }
    }, 120);
  }

  function commitScrubSeek(fallbackMs?: number) {
    const hasPendingScrub =
      isScrubbingRef.current || scrubPositionRef.current !== null;
    const candidate = scrubPositionRef.current ?? fallbackMs;
    setScrubPreview(null);
    setScrubActive(false);
    isScrubbingRef.current = false;
    scrubbingByPointerRef.current = false;
    if (!hasPendingScrub) return;
    if (typeof candidate !== "number" || Number.isNaN(candidate)) return;
    void handleSeek(candidate);
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

  async function transferPlayback(
    id: string,
    play = false,
    expectedCurrentDeviceId?: string | null
  ) {
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
          const expectedActiveDeviceId =
            expectedCurrentDeviceId && expectedCurrentDeviceId !== id
              ? expectedCurrentDeviceId
              : null;
          const proxyRes = await fetch("/api/spotify/me/player", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              device_ids: [id],
              play: playFlag,
              ...(expectedActiveDeviceId ? { expectedActiveDeviceId } : {}),
            }),
          });
          if (proxyRes.ok) return true;
          if (proxyRes.status === 409) {
            setConnectConflict("Spotify Connect is active on another device. Choose again.");
            return false;
          }
          if (proxyRes.status === 401 || proxyRes.status === 403) return false;
        } catch {
          // fall back to direct call
        }

        const directRes = await spotifyApiFetch("https://api.spotify.com/v1/me/player", {
          method: "PUT",
          body: JSON.stringify({ device_ids: [id], play: playFlag }),
        });
        if (directRes?.ok) return true;
        if (directRes && directRes.status === 409) {
          setConnectConflict("Spotify Connect is active on another device. Choose again.");
          return false;
        }
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
          <div className="text-body">Connecting Spotify session...</div>
        </div>
      </div>
    );
  }

  if (!playbackSessionReady || !playbackAllowed || premiumRequired) {
    return (
      <div className="player-card">
        <div className="player-meta">
          <div className="player-title">Spotify Player</div>
          <div className="text-body">
            Connect Spotify to control playback.
          </div>
          {!playbackSessionReady ? (
            <div className="text-subtle">Sign in with Spotify to continue.</div>
          ) : null}
          {!playbackAllowed && accessToken ? (
            <div className="text-subtle">
              You are missing playback permissions. Reconnect to continue.
              {missingPlaybackScopes.length ? (
                <span> Missing: {missingPlaybackScopes.join(", ")}.</span>
              ) : null}
            </div>
          ) : null}
          {premiumRequired ? (
            <div className="text-subtle">
              Spotify Premium is required for playback controls.
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const sliderMax = Math.max(1, durationMs || 0);
  const sliderPositionMs = Math.min(
    sliderMax,
    Math.max(0, scrubPositionMs ?? positionMs)
  );
  const sliderProgressPct = Math.min(
    100,
    Math.max(0, (sliderPositionMs / sliderMax) * 100)
  );
  const disallowSeeking = Boolean(playbackDisallows.seeking);
  const disallowPrevious = Boolean(playbackDisallows.skipping_prev);
  const disallowNext = Boolean(playbackDisallows.skipping_next);
  const disallowShuffle = Boolean(playbackDisallows.toggling_shuffle);
  const localSdkControlsPlayback =
    Boolean(deviceId) && (!activeDeviceId || activeDeviceId === deviceId);
  const disallowPlayPause =
    activeDeviceRestricted ||
    (!localSdkControlsPlayback &&
      (playbackPausedUi
        ? Boolean(playbackDisallows.resuming)
        : Boolean(playbackDisallows.pausing)));
  const playerUiTrackId =
    currentTrackIdState || playbackFocusState.trackId || lastTrackIdRef.current;
  const hasLiveTrackSignal =
    Boolean(playerUiTrackId) &&
    playbackFocusState.status !== "idle" &&
    playbackFocusState.status !== "ended";
  const showLiveTrackInPlayer = hasLiveTrackSignal || liveTrackUiGraceVisible;
  const playerTitleText = showLiveTrackInPlayer
    ? playerState?.name ?? "Unknown track"
    : "Select track";
  const playerArtistText = showLiveTrackInPlayer ? playerState?.artists ?? "" : "";
  const playerAlbumText = showLiveTrackInPlayer ? playerState?.album ?? "" : "";

  return (
    <div className="player-card" ref={playerCardRef}>
      <div className="player-main">
        <div className="player-cover">
          {showLiveTrackInPlayer && playerState?.coverUrl ? (
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
          <div className="player-title">{playerTitleText}</div>
        </div>
        {playerArtistText ? <div className="text-body">{playerArtistText}</div> : null}
        {playerAlbumText ? (
          <div className="text-subtle">
            {playerAlbumText}
          </div>
        ) : null}
        {accessToken && showLiveTrackInPlayer && currentTrackIdState ? (
          <div
            className="player-track-actions"
            ref={trackPlaylistMenu.rootRef}
            onPointerDownCapture={trackPlaylistMenu.markInteraction}
            onTouchStartCapture={trackPlaylistMenu.markInteraction}
          >
            <button
              type="button"
              className={`player-track-action-btn player-track-action-like${
                currentTrackLiked ? " active" : ""
              }`}
              aria-label={
                currentTrackLiked
                  ? "Remove from Liked Songs"
                  : "Add to Liked Songs"
              }
              title={
                currentTrackLiked
                  ? "Remove from Liked Songs"
                  : "Add to Liked Songs"
              }
              disabled={likedStateSaving || likedStateLoading || trackPlaylistSaving}
              onClick={handleLikeCurrentTrack}
            >
              {likedStateSaving ? "…" : currentTrackLiked ? "−" : "+"}
            </button>
            <button
              type="button"
              className={`player-track-action-btn player-track-action-membership${
                currentTrackInAnyPlaylist ? " active" : ""
              }${trackPlaylistLoading ? " loading" : ""}`}
              aria-label="Show track playlists"
              title={
                currentTrackInAnyPlaylist
                  ? `Track is in ${selectedPlaylistNamesForTrack.length} list${
                      selectedPlaylistNamesForTrack.length === 1 ? "" : "s"
                    }`
                  : "Track is not in your lists"
              }
              disabled={trackPlaylistSaving}
              onClick={() =>
                setTrackPlaylistMembershipOpen((prev) => {
                  const next = !prev;
                  if (next) {
                    setTrackPlaylistMenuOpen(false);
                    void ensureTrackPlaylistOptionsLoaded().catch(() => {
                      setError("Unable to load playlist targets right now.");
                    });
                    void syncCurrentTrackPlaylistSelection(currentTrackIdState).catch(() => {
                      setError("Unable to load track playlists right now.");
                    });
                  }
                  return next;
                })
              }
              onBlur={trackPlaylistMenu.handleBlur}
            >
              {trackPlaylistSaving || trackPlaylistLoading
                ? "…"
                : currentTrackInAnyPlaylist
                ? String(selectedPlaylistNamesForTrack.length)
                : "0"}
            </button>
            <button
              type="button"
              className="player-track-action-btn player-track-action-add"
              aria-label="Add track to playlists"
              title="Add track to playlists"
              disabled={trackPlaylistSaving}
              onClick={() =>
                setTrackPlaylistMenuOpen((prev) => {
                  const next = !prev;
                  if (next) {
                    setTrackPlaylistMembershipOpen(false);
                    void ensureTrackPlaylistOptionsLoaded().catch(() => {
                      setError("Unable to load playlist targets right now.");
                    });
                    void syncCurrentTrackPlaylistSelection(currentTrackIdState).catch(() => {
                      setError("Unable to load track playlists right now.");
                    });
                  }
                  return next;
                })
              }
              onBlur={trackPlaylistMenu.handleBlur}
            >
              {trackPlaylistSaving ? "…" : "＋"}
            </button>
            {trackPlaylistMembershipOpen ? (
              <div
                className="combo-list track-playlist-menu track-playlist-membership-menu"
                role="status"
                style={trackPlaylistPopoverStyle}
              >
                <div className="track-playlist-membership-summary">
                  {trackPlaylistLoading ? (
                    <div className="combo-empty">Loading track playlists...</div>
                  ) : currentTrackInAnyPlaylist ? (
                    <div className="text-subtle">This track is in:</div>
                  ) : (
                    <div className="text-subtle">This track is not in your lists.</div>
                  )}
                </div>
                {!trackPlaylistLoading && currentTrackInAnyPlaylist ? (
                  selectedPlaylistsForTrack.map((playlist) => (
                    <button
                      key={playlist.id}
                      type="button"
                      className="combo-item player-playlist-jump"
                      onClick={() => {
                        if (typeof window !== "undefined") {
                          window.dispatchEvent(
                            new CustomEvent("gs-player-open-playlist", {
                              detail: {
                                playlistId: playlist.id,
                                source: "player_track_membership",
                                at: Date.now(),
                              },
                            })
                          );
                        }
                        setTrackPlaylistMembershipOpen(false);
                        setTrackPlaylistMenuOpen(false);
                      }}
                    >
                      {playlist.name}
                    </button>
                  ))
                ) : null}
              </div>
            ) : null}
            {trackPlaylistMenuOpen ? (
              <div
                className="combo-list track-playlist-menu"
                role="menu"
                style={trackPlaylistPopoverStyle}
              >
                <div className="track-playlist-membership-summary">
                  {trackPlaylistLoading ? (
                    <div className="combo-empty">Loading track playlists...</div>
                  ) : currentTrackInAnyPlaylist ? (
                    <div className="text-subtle">
                      In playlists: {selectedPlaylistNamesForTrack.join(", ")}
                    </div>
                  ) : (
                    <div className="text-subtle">This track is not in your playlists.</div>
                  )}
                </div>
                {trackPlaylistLoading ? (
                  <div className="combo-empty">Loading playlists...</div>
                ) : trackPlaylistAddTargetOptions.length === 0 ? (
                  <div className="combo-empty">No playlist targets.</div>
                ) : (
                  trackPlaylistAddTargetOptions.map((option) => {
                    const opKey = `${currentTrackIdState}:${option.id}`;
                    const busy = trackPlaylistSaving || trackPlaylistActionKey === opKey;
                    const checked = trackPlaylistSelectedIds.has(option.id);
                    return (
                      <label
                        key={option.id}
                        role="menuitem"
                        className="combo-item"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          justifyContent: "flex-start",
                          minWidth: 0,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy}
                          onChange={() => {
                            if (busy) return;
                            setTrackPlaylistSelectedIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(option.id)) {
                                next.delete(option.id);
                              } else {
                                next.add(option.id);
                              }
                              return next;
                            });
                          }}
                          onClick={(event) => event.stopPropagation()}
                        />
                        <span
                          style={{
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            minWidth: 0,
                            display: "block",
                          }}
                        >
                          {option.name}
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
            ) : null}
          </div>
        ) : null}
        {playerErrorMessage &&
        playbackTouched &&
        !showLiveTrackInPlayer &&
        !activeDeviceName &&
        !deviceId &&
        !deviceMissing ? (
          <div className="text-subtle">
            Playback problem: {playerErrorMessage}
            {playerErrorMessage.includes("Reconnect") ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ marginLeft: 8 }}
                  onClick={() => {
                    window.location.href = "/api/auth/login";
                  }}
                >
                  Reconnect
                </button>
              ) : null}
            </div>
          ) : null}
        {activeDeviceRestricted ? (
          <div className="text-subtle">
            This device does not support remote control.
          </div>
        ) : null}
        {activeDevicePrivateSession ? (
          <div className="text-subtle">
            A private session is active on this device; history and queue may be limited.
          </div>
        ) : null}
        {deviceMissing ? (
          <div className="text-subtle">
            No Spotify device selected. Choose a device to start playback.
          </div>
        ) : null}
        {connectConflict ? (
          <div className="text-subtle">{connectConflict}</div>
        ) : null}
        </div>
        <div className="player-controls">
          <button
            type="button"
            className={`player-control player-control-ghost player-control-grad shuffle-btn${
              shuffleOn ? " active" : ""
            }${shufflePending ? " pending" : ""}`}
            aria-busy={shufflePending}
            aria-pressed={shuffleOn}
            aria-label={shuffleOn ? "Turn shuffle off" : "Turn shuffle on"}
            title={shuffleOn ? "Turn shuffle off" : "Turn shuffle on"}
            disabled={shufflePending || disallowShuffle}
            onClick={handleToggleShuffle}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M11.5 2a.5.5 0 0 0 0 1h1.086l-2.54 2.54-2.01-2.01a.5.5 0 0 0-.707 0L2 8.86a.5.5 0 1 0 .707.707l4.83-4.83 2.01 2.01a.5.5 0 0 0 .707 0L13.5 3.5V4.6a.5.5 0 0 0 1 0V2.5a.5.5 0 0 0-.5-.5h-2.5zm1 10H11.4a.5.5 0 0 0 0 1h2.1a.5.5 0 0 0 .5-.5V10a.5.5 0 0 0-1 0v1.1l-2.747-2.746a.5.5 0 0 0-.707 0l-2.01 2.01-1.83-1.83a.5.5 0 0 0-.707.707l2.183 2.183a.5.5 0 0 0 .707 0l2.01-2.01 2.6 2.6a.5.5 0 0 0 .707-.707L12.5 11.1V12z" />
            </svg>
          </button>
          <button
            type="button"
            className="player-control player-control-ghost player-control-grad"
            aria-label="Previous"
            title="Previous"
            disabled={disallowPrevious}
            onClick={handlePrevious}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M3.5 3.5a.5.5 0 0 0-1 0v9a.5.5 0 0 0 1 0v-9zm1.6 4.1 6.2 4.1a.5.5 0 0 0 .8-.4V4.7a.5.5 0 0 0-.8-.4L5.1 8.4a.5.5 0 0 0 0 .8z" />
            </svg>
          </button>
          <button
            type="button"
            className="player-control player-control-play player-control-grad"
            aria-label={playbackPausedUi ? "Play" : "Pause"}
            aria-busy={playPauseOptimisticPaused !== null}
            title={playbackPausedUi ? "Play" : "Pause"}
            disabled={disallowPlayPause}
            onClick={() => {
              void (controller?.toggle ? controller.toggle() : handleTogglePlay());
            }}
          >
            {playbackPausedUi ? (
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M4.5 3.5v9l8-4.5-8-4.5z" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="player-control player-control-ghost player-control-grad"
            aria-label="Next"
            title="Next"
            disabled={disallowNext}
            onClick={handleNext}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M12.5 3.5a.5.5 0 0 0-1 0v9a.5.5 0 0 0 1 0v-9zM10.9 8.4 4.7 4.3a.5.5 0 0 0-.8.4v6.6a.5.5 0 0 0 .8.4l6.2-4.1a.5.5 0 0 0 0-.8z" />
            </svg>
          </button>
          <button
            type="button"
            className={`player-control player-control-ghost player-control-grad${
              queueOpen || isCustomQueueActive ? " active" : ""
            }`}
            aria-pressed={queueOpen || isCustomQueueActive}
            aria-label="Queue"
            title="Queue"
            onClick={() => setQueueOpen((prev) => !prev)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M2.5 3h8a.5.5 0 0 1 0 1h-8a.5.5 0 0 1 0-1zm0 5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1 0-1zm0 5h6a.5.5 0 0 1 0 1h-6a.5.5 0 0 1 0-1z" />
            </svg>
          </button>
        </div>
        <div className="player-sliders-row">
          <div className="player-progress player-progress-main">
            <span className="text-subtle">{formatTime(sliderPositionMs)}</span>
            <input
              type="range"
              min={0}
              max={sliderMax}
              step={250}
              value={sliderPositionMs}
              onPointerDown={(event) => {
                beginScrub(true);
                try {
                  event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                  // Some browsers reject pointer capture on range controls.
                }
              }}
              onPointerUp={() => {
                commitScrubSeek();
              }}
              onPointerCancel={() => {
                commitScrubSeek();
              }}
              onMouseDown={() => {
                beginScrub(true);
              }}
              onMouseUp={() => {
                commitScrubSeek();
              }}
              onTouchStart={() => {
                beginScrub(true);
              }}
              onTouchEnd={() => {
                commitScrubSeek();
              }}
              onTouchCancel={() => {
                commitScrubSeek();
              }}
              onInput={(event) => {
                const next = readSliderValue(event.currentTarget.value);
                if (!isScrubbingRef.current) {
                  beginScrub(false);
                }
                updateScrub(next);
              }}
              onChange={(event) => {
                const next = readSliderValue(event.currentTarget.value);
                if (!isScrubbingRef.current) {
                  beginScrub(false);
                }
                if (scrubbingByPointerRef.current) return;
                commitScrubSeek(next);
              }}
              onBlur={(event) => {
                if (!isScrubbingRef.current && scrubPositionRef.current === null) return;
                const next = readSliderValue(event.currentTarget.value);
                commitScrubSeek(next);
              }}
              className={`player-slider player-slider-seek${
                scrubActive ? " is-scrubbing" : ""
              }`}
              style={{
                background: `linear-gradient(90deg, #1db954 ${Math.min(
                  100,
                  Math.max(0, sliderProgressPct)
                )}%, rgba(255, 255, 255, 0.12) ${Math.min(
                  100,
                  Math.max(0, sliderProgressPct)
                )}%)`,
              }}
              aria-label="Seek"
              aria-valuetext={`${formatTime(sliderPositionMs)} van ${formatTime(durationMs)}`}
              disabled={disallowSeeking}
            />
            <span className="text-subtle">{formatTime(durationMs)}</span>
          </div>
          <div className="player-progress player-volume-inline">
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
                )}%, rgba(255, 255, 255, 0.12) ${Math.round(
                  Math.min(1, Math.max(0, volume)) * 100
                )}%)`,
              }}
              aria-label="Volume"
              disabled={!activeDeviceSupportsVolume}
            />
            <span className="text-subtle">{Math.round(Math.min(1, Math.max(0, volume)) * 100)}%</span>
          </div>
        </div>
      </div>
      <div
        className="player-connect"
        data-open={connectDockOpen ? "true" : "false"}
        data-authority-mode={authorityModeState}
        onMouseEnter={() => {
          if (connectDockCloseDelayTimerRef.current) {
            clearTimeout(connectDockCloseDelayTimerRef.current);
            connectDockCloseDelayTimerRef.current = null;
          }
          if (connectDockOpenDelayTimerRef.current) {
            clearTimeout(connectDockOpenDelayTimerRef.current);
          }
          connectDockOpenDelayTimerRef.current = setTimeout(() => {
            setConnectDockHovered(true);
            connectDockOpenDelayTimerRef.current = null;
          }, 45);
        }}
        onMouseLeave={() => {
          if (connectDockOpenDelayTimerRef.current) {
            clearTimeout(connectDockOpenDelayTimerRef.current);
            connectDockOpenDelayTimerRef.current = null;
          }
          if (connectDockCloseDelayTimerRef.current) {
            clearTimeout(connectDockCloseDelayTimerRef.current);
          }
          connectDockCloseDelayTimerRef.current = setTimeout(() => {
            if (!connectSelectorOpen && !deviceMenuOpen) {
              setConnectDockHovered(false);
            }
            connectDockCloseDelayTimerRef.current = null;
          }, 190);
        }}
        onFocusCapture={() => {
          if (connectDockCloseDelayTimerRef.current) {
            clearTimeout(connectDockCloseDelayTimerRef.current);
            connectDockCloseDelayTimerRef.current = null;
          }
          setConnectDockHovered(true);
        }}
        onBlurCapture={(event) => {
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
            return;
          }
          if (connectSelectorOpen || deviceMenuOpen) return;
          if (connectDockCloseDelayTimerRef.current) {
            clearTimeout(connectDockCloseDelayTimerRef.current);
          }
          connectDockCloseDelayTimerRef.current = setTimeout(() => {
            if (!connectSelectorOpen && !deviceMenuOpen) {
              setConnectDockHovered(false);
            }
            connectDockCloseDelayTimerRef.current = null;
          }, 190);
        }}
      >
        <div className="player-device-row">
          <span>Spotify Connect</span>
          <span className="player-connect-row-actions">
            {sdkSupported && !sdkReadyState ? (
              <button
                type="button"
                className="detail-btn"
                aria-label="Start local web player"
                title="Start local web player"
                onClick={startLocalWebPlayerFromConnect}
              >
                ▶
              </button>
            ) : null}
            <button
              type="button"
              className="player-library-dock-chevron-btn"
              aria-label={connectDockOpen ? "Hide device selection" : "Show device selection"}
              title={connectDockOpen ? "Hide device selection" : "Show device selection"}
              aria-expanded={connectDockOpen}
              onClick={() => {
                setConnectDockManualOpen((prev) => {
                  const next = !prev;
                  setConnectSelectorOpen(next);
                  if (!next) {
                    setDeviceMenuOpen(false);
                  }
                  return next;
                });
              }}
            >
              <span
                className={`player-library-dock-chevron${connectDockOpen ? " open" : ""}`}
                aria-hidden="true"
              >
                ⌄
              </span>
            </button>
            <button
              type="button"
              className={`player-library-dock-pin${connectDockPinned ? " active" : ""}`}
              aria-pressed={connectDockPinned}
              aria-label={connectDockPinned ? "Unpin Connect bar" : "Pin Connect bar"}
              title={connectDockPinned ? "Unpin Connect bar" : "Pin Connect bar"}
              onClick={() => setConnectDockPinned((prev) => !prev)}
            >
              <svg
                className="player-library-dock-pin-icon"
                viewBox="0 0 24 24"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M14 3l7 7-2 2-2-2-3 3v4l-2 2-2-6-3-3-2 2-2-2 7-7 2 2 3-3z" />
              </svg>
            </button>
          </span>
        </div>
        <div className="player-connect-active-device" aria-live="polite">
          <span className="player-connect-active-icon" aria-hidden="true">
            {activeConnectDevice.icon}
          </span>
          <span className="player-connect-active-name">
            {activeConnectDevice.name}
          </span>
        </div>
        <div
          className={`player-library-dock-body${connectDockOpen ? " open" : ""}`}
          aria-hidden={!connectDockOpen}
        >
          <div className="player-device-select">
            <div className="player-device-select-row">
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
                  aria-label="Choose a Spotify device"
                  aria-haspopup="listbox"
                  aria-expanded={deviceMenuOpen}
                >
                  {devices.find((d) => d.id === (activeDeviceId || deviceId))?.name ||
                    "Choose device"}
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
                        {localWebplayerName} <span className="text-subtle">(start locally)</span>
                      </button>
                    ) : null}
                    {devices.length === 0 ? (
                      <div className="combo-empty">No devices found.</div>
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
                            {device.isPrivateSession ? " • private session" : ""}
                            {!device.selectable ? " • unavailable" : ""})
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="detail-btn"
                aria-label="Refresh devices"
                title="Refresh devices"
                onClick={() => refreshDevices(true)}
              >
                ↻
              </button>
            </div>
          </div>
        </div>
        {sdkSupported &&
        !sdkReadyState &&
        (!activeDeviceId || activeDeviceId === sdkDeviceIdRef.current) ? (
          <div className="text-subtle" style={{ marginTop: 6 }}>
            Local web player is connecting automatically ({sdkLifecycle}).
            {sdkLastError ? ` Laatste melding: ${sdkLastError}` : ""}
          </div>
        ) : null}
        {playbackTouched &&
        playbackBootState !== "idle" &&
        playbackBootState !== "playing" ? (
          <div className="text-subtle" style={{ marginTop: 6 }}>
            {formatPlaybackBootStateLabel(playbackBootState)}.
          </div>
        ) : null}
        {!sdkSupported && !activeDeviceId && !deviceId ? (
          <div className="text-subtle" style={{ marginTop: 6 }}>
            Local web player is not available in this browser. Use Spotify Connect
            through the Spotify app to control playback.
          </div>
        ) : null}
        {selectableDevicesCount === 0 ? (
          <div className="text-subtle" style={{ marginTop: 6 }}>
            No selectable devices found. Open Spotify on your iPhone/iPad and start a track, then click ↻.
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
      </div>
      {queueOpen ? (
        <div className="player-queue">
          <div className="player-queue-title">Up Next ({queueDisplayItems.length})</div>
          {queueLoading ? (
            <div className="text-subtle">Loading queue...</div>
          ) : queueError ? (
            <div className="text-subtle">{queueError}</div>
          ) : queueDisplayItems.length === 0 ? (
            <div className="text-subtle">No upcoming tracks.</div>
          ) : (
            <div className="player-queue-list" ref={queueListRef} role="list">
              {queueDisplayItems.map((track, index) => {
                const trackStatus: PlaybackFocusStatus = track.isCurrent
                  ? activeQueueTrackStatus
                  : "idle";
                const isPaused = trackStatus === "paused";
                const isLoading = trackStatus === "loading";
                const isEnded = trackStatus === "ended";
                const isError = trackStatus === "error";
                const isStale = track.isCurrent && activeQueueTrackIsStale;
                const stateClasses = `${track.isCurrent ? " active" : ""}${
                  isPaused ? " paused" : ""
                }${isStale ? " stale" : ""}${isLoading ? " loading" : ""}${
                  isEnded ? " ended" : ""
                }${isError ? " error" : ""}`;
                return (
                  <div
                    key={`${track.id}:${track.uri ?? "nouri"}`}
                    className={`player-queue-item${stateClasses}`}
                    data-queue-index={index}
                    role="listitem"
                    aria-current={track.isCurrent ? "true" : undefined}
                    ref={(node) => {
                      if (node) {
                        queueRowRefsRef.current.set(index, node);
                        return;
                      }
                      queueRowRefsRef.current.delete(index);
                    }}
                  >
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
                    <div className="player-queue-name">
                      {track.name}
                      {track.isCurrent ? (
                        <>
                          <ActiveTrackIndicator
                            status={trackStatus}
                            isStale={isStale}
                          />
                          <span className="player-queue-nowplaying">Now playing</span>
                        </>
                      ) : null}
                    </div>
                    <div className="text-subtle">{track.artists}</div>
                    <div className="text-subtle">
                      {track.explicit ? "Explicit" : "Clean"} •{" "}
                      {track.durationMs && track.durationMs > 0
                        ? formatTime(track.durationMs)
                        : "—"}
                      {track.uri ? ` • ${track.uri}` : ""}
                    </div>
                  </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
