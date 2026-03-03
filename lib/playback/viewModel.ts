import type { PlaybackFocus } from "@/app/components/player/playbackFocus";
import type { PlaybackSnapshot } from "./playbackState";
import type {
  PlayerCommandType,
  PlayerPlaybackStatus,
  PlayerRuntimeState,
} from "./playerControllerTypes";

export type PlaybackViewModel = {
  activeTrackId: string | null;
  activeTrackIds: string[];
  status: PlaybackSnapshot["status"];
  uiStatus: PlaybackSnapshot["uiStatus"];
  isPlaying: boolean | null;
  stale: boolean;
  transientGap: boolean;
  source: PlaybackSnapshot["source"];
  reason: PlaybackSnapshot["reason"];
  updatedAt: number;
  error: string | null;
  controllerStatus: PlayerPlaybackStatus;
  pendingCommand: PlayerCommandType | null;
  runtime: PlayerRuntimeState;
};

function dedupeTrackIds(values: Array<string | null | undefined>) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function derivePlaybackViewModel(input: {
  focus: PlaybackFocus;
  snapshot: PlaybackSnapshot;
  controllerStatus: PlayerPlaybackStatus;
  pendingCommand: PlayerCommandType | null;
  runtime: PlayerRuntimeState;
  controllerError: string | null;
}) {
  const activeTrackIds = dedupeTrackIds([
    ...(Array.isArray(input.focus.matchTrackIds) ? input.focus.matchTrackIds : []),
    ...(Array.isArray(input.snapshot.matchTrackIds) ? input.snapshot.matchTrackIds : []),
    input.focus.trackId,
    input.snapshot.currentTrackId,
  ]);
  const activeTrackId = activeTrackIds[0] ?? null;
  const transientGap =
    activeTrackIds.length > 0 &&
    (input.snapshot.uiStatus === "loading" ||
      input.snapshot.reason === "controller_initializing" ||
      input.snapshot.reason === "missing_match" ||
      input.snapshot.stale ||
      input.focus.stale);

  const model: PlaybackViewModel = {
    activeTrackId,
    activeTrackIds,
    status: input.snapshot.status,
    uiStatus: input.snapshot.uiStatus,
    isPlaying: input.focus.isPlaying,
    stale: Boolean(input.snapshot.stale || input.focus.stale),
    transientGap,
    source: input.snapshot.source,
    reason: input.snapshot.reason,
    updatedAt: Math.max(0, Number(input.snapshot.updatedAt) || 0),
    error: input.controllerError || input.runtime.lastError || input.snapshot.errorMessage,
    controllerStatus: input.controllerStatus,
    pendingCommand: input.pendingCommand,
    runtime: input.runtime,
  };
  return model;
}

