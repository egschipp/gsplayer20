"use client";

import { useState } from "react";
import type { PlaylistLink } from "./types";

type PlaylistChipsProps = {
  playlists?: PlaylistLink[];
  maxVisible?: number;
  onSelectPlaylist: (playlistId: string) => void;
};

export default function PlaylistChips({
  playlists,
  maxVisible = 2,
  onSelectPlaylist,
}: PlaylistChipsProps) {
  const [expanded, setExpanded] = useState(false);
  const normalizedPlaylists = [...(playlists ?? [])].sort((a, b) =>
    String(a?.name ?? "").localeCompare(String(b?.name ?? ""), "nl", {
      sensitivity: "base",
      ignorePunctuation: true,
      numeric: true,
    })
  );

  if (normalizedPlaylists.length === 0) {
    return <span className="text-subtle">—</span>;
  }
  const visible = expanded ? normalizedPlaylists : normalizedPlaylists.slice(0, maxVisible);
  const remaining = normalizedPlaylists.length - visible.length;
  return (
    <>
      {visible.map((pl) => (
        <button
          key={pl.id}
          type="button"
          className="playlist-chip"
          onClick={(event) => {
            event.stopPropagation();
            onSelectPlaylist(pl.id);
          }}
        >
          {pl.name || "Untitled playlist"}
        </button>
      ))}
      {remaining > 0 ? (
        <button
          type="button"
          className="playlist-more"
          aria-expanded={expanded}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded(true);
          }}
        >
          +{remaining} more
        </button>
      ) : expanded && normalizedPlaylists.length > maxVisible ? (
        <button
          type="button"
          className="playlist-more playlist-more-less"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded(false);
          }}
        >
          Show less
        </button>
      ) : null}
    </>
  );
}
