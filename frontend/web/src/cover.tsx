import { useEffect, useState } from 'react';

export const coverUrl = (trackId: string, size = 320) =>
  `/api/v1/tracks/${encodeURIComponent(trackId)}/cover?size=${size}`;

export function Cover({
  trackId,
  title = '',
  size = 96,
  className = '',
  onImage,
}: {
  trackId: string;
  title?: string;
  size?: number;
  className?: string;
  onImage?: (image: HTMLImageElement) => void;
}) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const changed = () => setRevision((v) => v + 1);
    window.addEventListener('wildstring:artwork-updated', changed);
    return () => window.removeEventListener('wildstring:artwork-updated', changed);
  }, []);
  const src = coverUrl(trackId, size) + (revision ? `&revision=${revision}` : '');
  const [failed, setFailed] = useState('');
  return (
    <span className={`cover ${className}`} aria-hidden="true">
      <span>{Array.from(title)[0] || '≋'}</span>
      {failed !== src && (
        <img
          src={src}
          alt=""
          loading={size >= 768 ? 'eager' : 'lazy'}
          decoding="async"
          onLoad={(event) => onImage?.(event.currentTarget)}
          onError={() => setFailed(src)}
        />
      )}
    </span>
  );
}
