import type { CSSProperties } from 'react';

const paths = {
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
