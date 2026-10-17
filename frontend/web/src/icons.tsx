import type { CSSProperties } from 'react';

const paths = {
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
    </>
  ),
  assistant: (
    <>
      <path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6Z" />
    </>
  ),
  draft: (
    <>
      <path d="M14 3H5v18h14V8Zm0 0v5h5M8 12h8M8 16h6" />
    </>
  ),
  task: (
    <>
      <path d="M9 5h11M9 12h11M9 19h11M3 5l1 1 2-2M3 12l1 1 2-2M3 19l1 1 2-2" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="3" />
      <circle cx="15" cy="17" r="3" />
    </>
  ),
  shuffle: (
    <>
      <path d="M3 6h3c4 0 7 12 11 12h4m-4-4 4 4-4 4M3 18h3c1.8 0 3.4-2.4 5-5m2-3c1.3-2.2 2.6-4 4-4h4m-4-4 4 4-4 4" />
    </>
  ),
  repeat: (
    <>
      <path d="M4 9V6h16l-3-3m3 3-3 3M20 15v3H4l3 3m-3-3 3-3" />
    </>
  ),
  repeatOne: (
    <>
      <path d="M4 9V6h16l-3-3m3 3-3 3M20 15v3H4l3 3m-3-3 3-3M11 10l1-1v6m-1 0h2" />
    </>
  ),
  sequential: (
    <>
      <path d="M3 12h18m-6-6 6 6-6 6" />
    </>
  ),
  album: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="m6 8 2-2m8 12 2-2" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  chevron: <path d="m9 5 7 7-7 7" />,
  edit: (
    <>
      <path d="m14 5 5 5M5 14l10-10a2.1 2.1 0 0 1 3 0l2 2a2.1 2.1 0 0 1 0 3L10 19l-6 1Z" />
      <path d="M13 20h7" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 1 0-2.2 6.5M20 4v7h-7" />
    </>
  ),
  next: (
    <>
      <path d="m9 11 5 4-5 4ZM18 11v8M4 5h16M4 8h8" />
    </>
  ),
  queue: (
    <>
      <path d="M4 5h16M4 10h11M4 15h7M18 12v8m-4-4h8" />
    </>
  ),
  playlist: (
    <>
      <path d="M4 5h12M4 10h10M4 15h7M18 9v10" />
      <ellipse cx="15.5" cy="19" rx="2.5" ry="2" />
    </>
  ),
  add: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4" />
    </>
  ),
  up: <path d="m5 14 7-7 7 7" />,
  down: <path d="m5 10 7 7 7-7" />,
  remove: (
    <>
      <path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5m4-5v5" />
    </>
  ),
};

export function Icon({
  name,
  className,
  style,
}: {
  name: keyof typeof paths;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={`ui-icon ${className || ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      {paths[name]}
    </svg>
  );
}
