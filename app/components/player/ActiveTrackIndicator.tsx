import type { PlaybackFocusStatus } from "./playbackFocus";

export default function ActiveTrackIndicator({
  status,
  isStale,
}: {
  status: PlaybackFocusStatus;
  isStale: boolean;
}) {
  const ariaLabel =
    status === "playing"
      ? "Now playing"
      : status === "paused"
        ? "Gepauzeerd"
        : status === "loading"
          ? "Buffering"
          : status === "ended"
            ? "Track beëindigd"
            : status === "error"
              ? "Playback fout"
              : "Actieve track";
  return (
    <span
      className={`playing-indicator ${status}${isStale ? " stale" : ""}`}
      aria-label={ariaLabel}
    >
      {status === "playing" ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className="playing-indicator-icon equalizer"
        >
          <rect x="1" y="7" width="2.2" height="8" rx="1" />
          <rect x="6.1" y="3" width="2.2" height="12" rx="1" />
          <rect x="11.2" y="5.5" width="2.2" height="9.5" rx="1" />
        </svg>
      ) : status === "loading" ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className="playing-indicator-icon spinner"
        >
          <circle cx="8" cy="8" r="5.5" fill="none" strokeWidth="2.2" opacity="0.35" />
          <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" fill="none" strokeWidth="2.2" />
        </svg>
      ) : status === "paused" ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className="playing-indicator-icon"
        >
          <path d="M4.2 3.2h2.6v9.6H4.2zM9.2 3.2h2.6v9.6H9.2z" />
        </svg>
      ) : status === "ended" ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className="playing-indicator-icon"
        >
          <path d="M8 2.2a5.8 5.8 0 1 0 5.65 7.1h-1.8A4.2 4.2 0 1 1 8 3.8c1.1 0 2.08.42 2.82 1.1L8.9 6.82h4.9v-4.9l-1.74 1.74A5.73 5.73 0 0 0 8 2.2Z" />
        </svg>
      ) : status === "error" ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className="playing-indicator-icon"
        >
          <path d="M8 1.8 1.6 13.6h12.8L8 1.8Zm-.8 4.1h1.6v4.3H7.2V5.9Zm0 5.3h1.6v1.6H7.2v-1.6Z" />
        </svg>
      ) : (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className="playing-indicator-icon"
        >
          <path d="M4.4 3.2v9.6l8-4.8-8-4.8Z" />
        </svg>
      )}
    </span>
  );
}
