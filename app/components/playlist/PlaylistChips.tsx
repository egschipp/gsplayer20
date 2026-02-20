"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  const [popoverOpen, setPopoverOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const normalizedPlaylists = useMemo(
    () =>
      [...(playlists ?? [])].sort((a, b) =>
        String(a?.name ?? "").localeCompare(String(b?.name ?? ""), "nl", {
          sensitivity: "base",
          ignorePunctuation: true,
          numeric: true,
        })
      ),
    [playlists]
  );
  useEffect(() => {
    if (!popoverOpen) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setPopoverOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setPopoverOpen(false);
      }
    }
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [popoverOpen]);

  if (normalizedPlaylists.length === 0) {
    return <span className="text-subtle">—</span>;
  }
  const visible = normalizedPlaylists.slice(0, maxVisible);
  const remaining = normalizedPlaylists.length - visible.length;
  return (
    <span
      ref={rootRef}
      className="playlist-chip-group"
      onClick={(event) => event.stopPropagation()}
    >
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
          aria-haspopup="listbox"
          aria-expanded={popoverOpen}
          onClick={(event) => {
            event.stopPropagation();
            setPopoverOpen((prev) => !prev);
          }}
        >
          +{remaining} more
        </button>
      ) : null}
      {popoverOpen ? (
        <div className="playlist-popover" role="listbox" aria-label="Track playlists">
          {normalizedPlaylists.map((pl) => (
            <button
              key={`popover-${pl.id}`}
              type="button"
              className="playlist-popover-item"
              onClick={(event) => {
                event.stopPropagation();
                setPopoverOpen(false);
                onSelectPlaylist(pl.id);
              }}
            >
              {pl.name || "Untitled playlist"}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
