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
      ? "ja"
      : meta.explicit === false || meta.explicit === 0
      ? "nee"
      : "Onbekend";
  const popularityValue =
    meta.popularity === null || meta.popularity === undefined
      ? "Onbekend"
      : String(meta.popularity);
  return [
    `Primaire verificatie-ID: ${meta.id ?? "Onbekend"}`,
    `Tracknaam validatie: ${meta.name ?? "Onbekend"}`,
    `Unieke artiest-ID validatie: ${
      meta.artistIds?.length ? meta.artistIds.join(", ") : "Onbekend"
    }`,
    `Cross-check met verwachte artiest: ${
      meta.artistNames?.length ? meta.artistNames.join(", ") : "Onbekend"
    }`,
    `Albumvalidatie: ${meta.albumId ?? "Onbekend"}`,
    `Chronologische verificatie: ${meta.albumReleaseDate ?? "Onbekend"}`,
    `Exacte technische verificatie: ${
      meta.durationMs === null || meta.durationMs === undefined
        ? "Onbekend"
        : `${meta.durationMs}`
    }`,
    `Sterke unieke identificator (indien aanwezig): ${meta.isrc ?? "Onbekend"}`,
    `Consistentiecontrole: ${explicitValue}`,
    `Plausibiliteitscontrole: ${popularityValue}`,
  ].join("\n");
}
