import { useEffect, useRef, useState } from 'react';
import { api, type Track } from './api';

export function useFavorites(revision: number, onError: (message: string) => void) {
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [change, setChange] = useState(0);
  const [ready, setReady] = useState(false);
  const current = useRef(ids);
  const pending = useRef(new Set<string>());
  const changed = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    changed.current.clear();
    if (!navigator.onLine) {
      setReady(false);
      return;
    }
    const controller = new AbortController();
    api<{ ids: string[] }>('/favorites/ids', { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) {
          const next = new Set(result.ids);
          for (const id of new Set([...changed.current, ...pending.current])) {
            if (current.current.has(id)) next.add(id);
            else next.delete(id);
          }
          current.current = next;
          setIds(next);
          setReady(true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) onError('暂时无法读取收藏，请刷新重试。');
      });
    return () => controller.abort();
  }, [revision, onError]);
  async function toggle(track: Track) {
    if (!ready || pending.current.has(track.id)) return;
    pending.current.add(track.id);
    changed.current.add(track.id);
    const loved = !current.current.has(track.id);
    function apply(value: boolean) {
      const next = new Set(current.current);
      if (value) next.add(track.id);
      else next.delete(track.id);
      current.current = next;
      if (mounted.current) setIds(next);
    }
    apply(loved);
    setBusy((previous) => new Set(previous).add(track.id));
    try {
      await api(`/tracks/${encodeURIComponent(track.id)}/favorite`, {
        method: 'PUT',
        body: JSON.stringify({ loved }),
      });
      if (!mounted.current) return;
      setChange((value) => value + 1);
    } catch {
      if (!mounted.current) return;
      apply(!loved);
      onError('收藏未保存，请重试。');
    } finally {
      pending.current.delete(track.id);
      if (mounted.current)
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
      aria-busy={favorites.busy.has(track.id)}
      disabled={!favorites.ready || favorites.busy.has(track.id)}
      onClick={() => void favorites.toggle(track)}
      data-help={loved ? '取消喜欢' : '喜欢'}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
      </svg>
    </button>
  );
}
