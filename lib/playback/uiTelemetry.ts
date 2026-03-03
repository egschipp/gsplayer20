import { incCounter } from "@/lib/observability/metrics";
import { PLAYBACK_FEATURE_FLAGS } from "./featureFlags";

type UiEventName =
  | "status_transition"
  | "scroll_to_active_track"
  | "track_focus_changed";

export function emitPlaybackUiMetric(
  name: UiEventName,
  labels: Record<string, string | number | boolean | null | undefined> = {}
) {
  if (!PLAYBACK_FEATURE_FLAGS.playbackUiTelemetryV1) return;
  incCounter(`playback_ui_${name}`, labels, 1);
}

