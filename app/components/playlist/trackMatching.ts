import type { TrackItem, TrackRow } from "./types";
import {
  normalizeSpotifyTrackId,
  normalizeTrackIdCollection,
} from "../../../lib/spotify/trackIdentity";

export { normalizeSpotifyTrackId, normalizeTrackIdCollection };

export function resolveTrackId(track: TrackRow | TrackItem | null | undefined) {
  if (!track) return null;
  if ("trackId" in track && typeof track.trackId === "string" && track.trackId) {
    return track.trackId;
  }
  if ("id" in track && typeof track.id === "string" && track.id) return track.id;
  return null;
}

export function collectTrackMatchCandidates(
  track: TrackRow | TrackItem | null | undefined,
  options?: { includeLinkedFrom?: boolean }
) {
  if (!track) return [] as string[];
  const candidates = new Set<string>();
  const candidateValues: Array<string | null | undefined> = [track.id, track.trackId];
  if (options?.includeLinkedFrom === true) {
    candidateValues.push(track.linkedFromTrackId);
  }
  for (const value of candidateValues) {
    const normalized = normalizeSpotifyTrackId(value);
    if (normalized) candidates.add(normalized);
  }
  return Array.from(candidates);
}

export function isCurrentTrackMatch(
  track: TrackRow | TrackItem | null | undefined,
  currentTrackId: string | Set<string> | null
) {
  if (!track || !currentTrackId) return false;
  const activeIds = new Set(
    normalizeTrackIdCollection(
      typeof currentTrackId === "string"
        ? [currentTrackId]
        : Array.from(currentTrackId.values())
    )
  );
  if (!activeIds.size) return false;
  return collectTrackMatchCandidates(track).some((candidate) => activeIds.has(candidate));
}

export function findBestTrackMatchIndex<T extends TrackRow | TrackItem>(
  items: T[],
  activeTrackIds: Set<string>
) {
  if (!items.length || !activeTrackIds.size) return -1;
  let fallbackIndex = -1;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (
      collectTrackMatchCandidates(item).some((candidate) => activeTrackIds.has(candidate))
    ) {
      return index;
    }
    if (
      fallbackIndex < 0 &&
      collectTrackMatchCandidates(item, { includeLinkedFrom: true }).some((candidate) =>
        activeTrackIds.has(candidate)
      )
    ) {
      fallbackIndex = index;
    }
  }
  if (fallbackIndex >= 0 && typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("gs-playback-metric", {
        detail: { name: "match_fallback_used", value: 1, at: Date.now() },
      })
    );
  }
  return fallbackIndex;
}
