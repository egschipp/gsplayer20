export const PLAYBACK_CROSS_TAB_CHANNEL = "gsplayer-playback-sync";

export type PlaybackCrossTabSnapshot = {
  device: {
    id?: string | null;
    name?: string | null;
    is_restricted?: boolean;
    is_private_session?: boolean;
    supports_volume?: boolean;
    volume_percent?: number;
  } | null;
  item: {
    id?: string | null;
    uri?: string | null;
    name?: string | null;
    duration_ms?: number;
    artists?: Array<{ name?: string | null }>;
    album?: {
      name?: string | null;
      images?: Array<{ url?: string | null }>;
    };
  } | null;
  progress_ms: number;
  is_playing: boolean;
  shuffle_state: boolean;
  repeat_state: "off" | "track" | "context";
  timestamp: number;
  currently_playing_type?: "track" | "episode" | "ad" | "unknown";
  actions?: {
    disallows?: Record<string, boolean>;
  };
  streamedAt?: number;
  sync?: {
    serverSeq: number;
    serverTime: number;
    source: string;
  };
};

export type PlaybackCrossTabMessage =
  | {
      type: "sync";
      at: number;
      source?: string;
      seq?: number;
    }
  | {
      type: "intent";
      seq: number;
    }
  | {
      type: "snapshot";
      at: number;
      source: string;
      snapshot: PlaybackCrossTabSnapshot;
    };
