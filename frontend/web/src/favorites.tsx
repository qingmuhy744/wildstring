import { useEffect, useState } from 'react';
import { api, type Track } from './api';

export function useFavorites(revision: number, onError: (message: string) => void) {
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [change, setChange] = useState(0);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<{ ids: string[] }>('/favorites/ids', { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) {
          setIds(new Set(result.ids));
          setReady(true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) onError('暂时无法读取收藏，请刷新重试。');
      });
    return () => controller.abort();
  }, [revision, onError]);
  async function toggle(track: Track) {
    if (busy.has(track.id)) return;
    const loved = !ids.has(track.id);
    setBusy((previous) => new Set(previous).add(track.id));
    try {
      await api(`/tracks/${encodeURIComponent(track.id)}/favorite`, {
        method: 'PUT',
        body: JSON.stringify({ loved }),
      });
      setIds((previous) => {
        const next = new Set(previous);
        if (loved) next.add(track.id);
        else next.delete(track.id);
        return next;
      });
      setChange((value) => value + 1);
    } catch {
      onError('收藏未保存，请重试。');
    } finally {
      setBusy((previous) => {
        const next = new Set(previous);
        next.delete(track.id);
        return next;
      });
    }
  }
  return { ids, busy, toggle, change, ready };
}
export type Favorites = ReturnType<typeof useFavorites>;
export function FavoriteButton({ track, favorites }: { track: Track; favorites: Favorites }) {
  const loved = favorites.ids.has(track.id);
  return (
    <button
      className={`favorite-button icon-button ${loved ? 'is-loved' : ''}`}
      aria-label={`${loved ? '取消喜欢' : '喜欢'} ${track.title}`}
      aria-pressed={loved}
      disabled={!favorites.ready || favorites.busy.has(track.id)}
      onClick={() => void favorites.toggle(track)}
      title={loved ? '取消喜欢' : '喜欢'}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
      </svg>
    </button>
  );
}
