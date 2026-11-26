import './playback-glyph.css';

export function PlaybackGlyph({ playing, buffering }: { playing: boolean; buffering: boolean }) {
  return (
    <span
      className="playback-glyph"
      data-state={buffering ? 'buffering' : playing ? 'pause' : 'play'}
      aria-hidden="true"
    >
      <svg className="glyph-play" viewBox="0 0 24 24">
        <path d="M8.33 5l11 7-11 7z" />
      </svg>
      <svg className="glyph-pause" viewBox="0 0 24 24">
        <path d="M7 5h4v14H7zm6 0h4v14h-4z" />
      </svg>
      <svg className="glyph-spinner" viewBox="0 0 24 24">
        <circle
          cx="12"
          cy="12"
          r="8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="38 13"
        />
      </svg>
    </span>
  );
}
