"use client";

import type { PlaylistLink } from "./types";

type PlaylistChipsProps = {
  playlists?: PlaylistLink[];
  maxVisible?: number;
};

export default function PlaylistChips({
  playlists,
  maxVisible = 2,
}: PlaylistChipsProps) {
  if (!playlists || playlists.length === 0) {
    return <span className="text-subtle">—</span>;
  }
  const visible = playlists.slice(0, maxVisible);
  const remaining = playlists.length - visible.length;
  return (
    <>
      {visible.map((pl) => (
        <a
          key={pl.id}
          href={pl.spotifyUrl}
          target="_blank"
          rel="noreferrer"
          className="playlist-chip"
          onClick={(event) => event.stopPropagation()}
        >
          {pl.name || "Untitled playlist"}
        </a>
      ))}
      {remaining > 0 ? (
        <span className="playlist-more">+{remaining} more</span>
      ) : null}
    </>
  );
}
