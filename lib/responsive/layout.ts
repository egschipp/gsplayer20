import { BREAKPOINTS } from "./breakpoints";

export const TRACK_LIST_HEIGHT_MIN = 360;
export const TRACK_LIST_HEIGHT_MAX = 720;
export const TRACK_LIST_HEIGHT_RATIO = 0.6;

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeTrackListHeight(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 560;
  const scaled = Math.round(viewportHeight * TRACK_LIST_HEIGHT_RATIO);
  return clampNumber(scaled, TRACK_LIST_HEIGHT_MIN, TRACK_LIST_HEIGHT_MAX);
}

export function isCompactTrackLayout(viewportWidth: number): boolean {
  return viewportWidth < BREAKPOINTS.laptop;
}

export function resolveTrackHeaderClass(compact: boolean): string {
  return compact ? "track-header columns-3" : "track-header columns-6";
}
