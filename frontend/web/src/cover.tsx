import { useEffect, useState } from 'react';
import { offlineCover, usingOfflineAccess } from './offline';

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
  const [local, setLocal] = useState('');
  const [failed, setFailed] = useState('');
  useEffect(() => {
    if (failed.startsWith('blob:') || (navigator.onLine && !usingOfflineAccess() && !failed))
      return;
    let live = true;
    let url = '';
    void offlineCover(trackId).then((blob) => {
      if (blob && live) {
        url = URL.createObjectURL(blob);
        setLocal(url);
      }
    });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [trackId, failed]);
  const src = local || coverUrl(trackId, size) + (revision ? `&revision=${revision}` : '');
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
