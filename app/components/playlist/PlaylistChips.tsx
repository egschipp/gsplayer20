"use client";

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
  if (!playlists || playlists.length === 0) {
    return <span className="text-subtle">—</span>;
  }
  const visible = playlists.slice(0, maxVisible);
  const remaining = playlists.length - visible.length;
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
        <span className="playlist-more">+{remaining} more</span>
      ) : null}
    </>
  );
}
