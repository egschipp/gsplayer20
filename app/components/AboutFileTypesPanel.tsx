"use client";

import { useEffect, useState } from "react";
import type { FileTypeStat } from "@/lib/about/codebaseStats";

type AboutFileTypesPanelProps = {
  fileTypes: FileTypeStat[];
};

const OPEN_KEY = "gs_about_filetypes_open_v1";
const PIN_KEY = "gs_about_filetypes_pinned_v1";

export default function AboutFileTypesPanel({
  fileTypes,
}: AboutFileTypesPanelProps) {
  const [manualOpen, setManualOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(OPEN_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [pinned, setPinned] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(PIN_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(OPEN_KEY, manualOpen ? "true" : "false");
      window.localStorage.setItem(PIN_KEY, pinned ? "true" : "false");
    } catch {
      // ignore storage failures
    }
  }, [manualOpen, pinned]);

  const open = pinned || manualOpen;

  function formatFileType(type: string) {
    if (type === "dockerfile") return "Dockerfile";
    if (type === "makefile") return "Makefile";
    return `.${type}`;
  }

  return (
    <div className="about-filetypes-dock player-library-dock" data-open={open ? "true" : "false"}>
      <div className={`player-library-dock-toggle${open ? " open" : ""}`}>
        <span className="player-library-dock-label">File types</span>
        <span className="player-library-dock-value">
          <strong>Breakdown by type</strong>
          <span className="player-library-dock-meta">
            {fileTypes.length} types in the current release scan
          </span>
        </span>
        <button
          type="button"
          className="player-library-dock-chevron-btn"
          aria-controls="about-filetypes-body"
          aria-expanded={open}
          aria-label={open ? "Collapse list" : "Expand list"}
          onClick={() => setManualOpen((prev) => !prev)}
        >
          <span className={`player-library-dock-chevron${open ? " open" : ""}`} aria-hidden="true">
            ⌄
          </span>
        </button>
        <button
          type="button"
          className={`player-library-dock-pin${pinned ? " active" : ""}`}
          aria-pressed={pinned}
          aria-label={pinned ? "Unpin panel" : "Pin panel"}
          title={pinned ? "Unpin panel" : "Pin panel"}
          onClick={() => setPinned((prev) => !prev)}
        >
          <svg
            className="player-library-dock-pin-icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M14 3l7 7-2 2-2-2-3 3v4l-2 2-2-6-3-3-2 2-2-2 7-7 2 2 3-3z" />
          </svg>
        </button>
      </div>

      <div
        id="about-filetypes-body"
        className={`player-library-dock-body about-filetypes-body${open ? " open" : ""}`}
        aria-hidden={!open}
      >
        <div className="about-table-wrap">
          <table className="about-types-table" aria-label="File type overview">
            <thead>
              <tr>
                <th>Type</th>
                <th className="num">Files</th>
                <th className="num">Lines</th>
                <th className="num">Non-empty</th>
              </tr>
            </thead>
            <tbody>
              {fileTypes.map((row) => (
                <tr key={row.type}>
                  <td>{formatFileType(row.type)}</td>
                  <td className="num">{row.files.toLocaleString("en-US")}</td>
                  <td className="num">{row.lines.toLocaleString("en-US")}</td>
                  <td className="num">{row.nonEmptyLines.toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
