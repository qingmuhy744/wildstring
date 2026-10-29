import { useEffect, useState } from 'react';
import { offlineCover, usingOfflineAccess } from './offline';
import { DefaultArtwork } from './default-artwork';

const podcastCovers = new Map<string, string>();

export const rememberPodcastCover = (trackId: string, url: string) => {
  if (url) podcastCovers.set(trackId, url);
};

export const coverUrl = (trackId: string, size = 320, source = '') => {
  if (source) return source;
  const custom = podcastCovers.get(trackId);
  if (custom) return custom;
  return `/api/v1/tracks/${encodeURIComponent(trackId)}/cover?size=${size}`;
};

export function Cover({
  trackId,
  title = '',
  size = 96,
  className = '',
  source = '',
  onImage,
}: {
  trackId: string;
  title?: string;
  size?: number;
  className?: string;
  source?: string;
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
    if (source) {
      setLocal('');
      return;
    }
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
  }, [trackId, failed, source]);
  const src =
    source || local || coverUrl(trackId, size) + (revision ? `&revision=${revision}` : '');
  const hasFailed = failed === src;
  return (
    <span className={`cover ${className}`} aria-hidden="true">
      {hasFailed ? (
        <DefaultArtwork title={title} />
      ) : (
        <>
          <DefaultArtwork title={title} style={{ position: 'absolute', inset: 0 }} />
          <img
            src={src}
            alt=""
            loading={size >= 768 ? 'eager' : 'lazy'}
            decoding="async"
            onLoad={(event) => onImage?.(event.currentTarget)}
            onError={() => setFailed(src)}
          />
        </>
      )}
    </span>
  );
}
