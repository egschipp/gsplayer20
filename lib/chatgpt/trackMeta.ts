export type TrackMetaInput = {
  id?: string | null;
  name?: string | null;
  artistIds?: string[];
  artistNames?: string[];
  albumId?: string | null;
  albumReleaseDate?: string | null;
  durationMs?: number | null;
  isrc?: string | null;
  explicit?: boolean | number | null;
  popularity?: number | null;
};

export function formatTrackMeta(meta: TrackMetaInput) {
  const explicitValue =
    meta.explicit === true || meta.explicit === 1
      ? "yes"
      : meta.explicit === false || meta.explicit === 0
      ? "no"
      : "Unknown";
  const popularityValue =
    meta.popularity === null || meta.popularity === undefined
      ? "Unknown"
      : String(meta.popularity);
  return [
    `Primary verification ID: ${meta.id ?? "Unknown"}`,
    `Track name validation: ${meta.name ?? "Unknown"}`,
    `Unique artist ID validation: ${
      meta.artistIds?.length ? meta.artistIds.join(", ") : "Unknown"
    }`,
    `Cross-check with expected artist: ${
      meta.artistNames?.length ? meta.artistNames.join(", ") : "Unknown"
    }`,
    `Album validation: ${meta.albumId ?? "Unknown"}`,
    `Chronological validation: ${meta.albumReleaseDate ?? "Unknown"}`,
    `Exact technical validation: ${
      meta.durationMs === null || meta.durationMs === undefined
        ? "Unknown"
        : `${meta.durationMs}`
    }`,
    `Strong unique identifier (if available): ${meta.isrc ?? "Unknown"}`,
    `Consistency check: ${explicitValue}`,
    `Plausibility check: ${popularityValue}`,
  ].join("\n");
}
