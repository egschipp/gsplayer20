"use client";

import Image from "next/image";
import { formatDuration } from "@/app/components/playlist/utils";

export type SelectedTrackListItem = {
  id: string;
  name: string;
  artists: string;
  albumName: string | null;
  imageUrl: string | null;
  durationMs: number | null;
};

type SelectedListPanelProps = {
  items: SelectedTrackListItem[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onRemove: (trackId: string) => void;
  onClear: () => void;
};

export default function SelectedListPanel({
  items,
  collapsed,
  onToggleCollapsed,
  onRemove,
  onClear,
}: SelectedListPanelProps) {
  return (
    <section className="recommendations-panel-shell">
      <div className="recommendations-panel-header">
        <button
          type="button"
          className="recommendations-toggle"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-controls="selected-list-panel-body"
        >
          <span className={`recommendations-toggle-chevron${collapsed ? "" : " open"}`}>
            ▸
          </span>
          <span>Geselecteerd ({items.length})</span>
        </button>
        <button
          type="button"
          className="recommendations-secondary-btn"
          onClick={onClear}
          disabled={!items.length}
        >
          Leegmaken
        </button>
      </div>

      {!collapsed ? (
        <div id="selected-list-panel-body" className="recommendations-panel-body">
          {!items.length ? (
            <div className="empty-state">
              <div style={{ fontWeight: 600 }}>Nog geen tracks geselecteerd</div>
              <div className="text-body">
                Selecteer tracks via het plus-icoon in de tracklijst.
              </div>
            </div>
          ) : (
            <ul className="selected-track-list" aria-label="Geselecteerde tracks">
              {items.map((item) => (
                <li key={item.id} className="selected-track-item">
                  <div className="selected-track-main">
                    {item.imageUrl ? (
                      <Image
                        src={item.imageUrl}
                        alt=""
                        width={36}
                        height={36}
                        className="selected-track-cover"
                        unoptimized
                      />
                    ) : (
                      <span className="selected-track-cover placeholder" />
                    )}
                    <div className="selected-track-text">
                      <div className="selected-track-title" title={item.name}>
                        {item.name}
                      </div>
                      <div
                        className="selected-track-subtitle text-subtle"
                        title={item.albumName ? `${item.artists} • ${item.albumName}` : item.artists}
                      >
                        {item.albumName ? `${item.artists} • ${item.albumName}` : item.artists}
                      </div>
                    </div>
                  </div>
                  <div className="selected-track-actions">
                    <span className="text-subtle selected-track-duration">
                      {formatDuration(item.durationMs)}
                    </span>
                    <button
                      type="button"
                      className="selected-track-remove"
                      onClick={() => onRemove(item.id)}
                      aria-label={`Verwijder ${item.name} uit selectie`}
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
