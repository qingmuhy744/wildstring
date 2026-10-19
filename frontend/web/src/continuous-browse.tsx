import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api, type DiscSummary } from './api';

export interface BrowsePage<T> {
  discs?: DiscSummary[];
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
type Window<T> = { page: BrowsePage<T>; end: number };

// A window may start at a letter far beyond page one. Loading backwards extends
// that same window, so an index jump never makes earlier songs inaccessible.
export function useContinuousBrowse<T extends { id: string }>({
  identity,
  path,
  enabled,
}: {
  identity: string;
  path: string;
  enabled: boolean;
}) {
  const cache = useRef(new Map<string, Window<T>>());
  const [snapshot, setSnapshot] = useState<{ identity: string; window: Window<T> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{
    identity: string;
    offset: number;
    message: string;
    replace: boolean;
  } | null>(null);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const active = useRef({ identity, path, enabled });
  active.current = { identity, path, enabled };
  const current = snapshot?.identity === identity ? snapshot.window : null;

  async function load(offset: number, replace = false) {
    if (!enabled || (request.current && !replace)) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const token = ++generation.current;
    const queryIdentity = identity;
    setBusy(true);
    setFailure(null);
    let retryOffset = offset;
    let retryReplace = replace;
    try {
      const parameters = new URLSearchParams(path.split('?')[1]);
      parameters.set('limit', '50');
      parameters.set('offset', String(offset));
      const page = await api<BrowsePage<T>>(`${path.split('?')[0]}?${parameters}`, {
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        token !== generation.current ||
        active.current.identity !== queryIdentity
      )
        return;
      if (page.total > 0 && offset >= page.total) {
        request.current = null;
        void load(Math.max(0, page.total - 50), true);
        return;
      }
      const before = replace ? undefined : cache.current.get(queryIdentity);
      if (
        page.offset !== offset ||
        page.items.length !== Math.min(50, Math.max(0, page.total - offset)) ||
        (before && before.page.total !== page.total) ||
        (before &&
          offset !== before.end &&
          !(offset < before.page.offset && offset + page.items.length >= before.page.offset))
      ) {
        retryOffset = 0;
        retryReplace = true;
        throw new Error('曲库内容已变化，请重新加载列表。');
      }
      const start = before ? Math.min(before.page.offset, page.offset) : page.offset;
      const combined = !before
        ? page.items
        : page.offset < before.page.offset
          ? [...page.items, ...before.page.items]
          : [...before.page.items, ...page.items];
      const ids = new Set<string>();
      const items = combined.filter((item) => !ids.has(item.id) && !!ids.add(item.id));
      const end = Math.max(before?.end || 0, page.offset + page.items.length);
      if (items.length !== end - start) {
        retryOffset = 0;
        retryReplace = true;
        throw new Error('曲库顺序已变化，请重新加载列表。');
      }
      const next = {
        page: { ...page, offset: start, items },
        end,
      };
      cache.current.set(queryIdentity, next);
      // Keep navigation caches bounded without discarding the active context.
      if (cache.current.size > 20) cache.current.delete(cache.current.keys().next().value!);
      setSnapshot({ identity: queryIdentity, window: next });
    } catch (error) {
      if (!controller.signal.aborted && token === generation.current)
        setFailure({
          identity: queryIdentity,
          offset: retryOffset,
          replace: retryReplace,
          message: error instanceof Error ? error.message : '无法连接音乐服务，请检查连接。',
        });
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    request.current?.abort();
    request.current = null;
    generation.current++;
    setFailure(null);
    setBusy(false);
    if (!enabled) return;
    const saved = cache.current.get(identity);
    if (saved) setSnapshot({ identity, window: saved });
    else {
      setSnapshot(null);
      void loadRef.current(0, true);
    }
    return () => {
      request.current?.abort();
      request.current = null;
      generation.current++;
    };
  }, [identity, enabled]);

  const setPage: Dispatch<SetStateAction<BrowsePage<T> | null>> = (update) => {
    request.current?.abort();
    request.current = null;
    generation.current++;
    setBusy(false);
    setSnapshot((before) => {
      const prior = before?.identity === identity ? before.window : null;
      const page = typeof update === 'function' ? update(prior?.page || null) : update;
      if (!page) {
        cache.current.delete(identity);
        return null;
      }
      const next = { page, end: prior?.end ?? page.offset + page.items.length };
      cache.current.set(identity, next);
      return { identity, window: next };
    });
  };
  return {
    page: current?.page || null,
    setPage,
    loading: enabled && !current && !failure,
    busy,
    error: failure?.identity === identity ? failure.message : '',
    hasPrevious: !!current && current.page.offset > 0,
    hasNext: !!current && current.end < current.page.total,
    loadPrevious: () => current && load(Math.max(0, current.page.offset - 50)),
    loadNext: () => current && load(current.end),
    jump: (offset: number) => load(offset, true),
    retry: () => failure && load(failure.offset, failure.replace),
  };
}

export interface BrowseIndex {
  kind: string;
  total: number;
  groups: { key: string; offset: number | null; count: number }[];
}

export function AlphabetRail({
  index,
  onJump,
}: {
  index: BrowseIndex;
  onJump: (offset: number) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const gesture = useRef<{ pointer: number; key: string; offset: number | null } | null>(null);
  function at(y: number, element: HTMLElement) {
    const buttons = Array.from(element.querySelectorAll('button'));
    let nearest = 0;
    let distance = Infinity;
    buttons.forEach((button, position) => {
      const box = button.getBoundingClientRect();
      const delta = Math.abs(y - box.top - box.height / 2);
      if (delta < distance) {
        nearest = position;
        distance = delta;
      }
    });
    return index.groups[nearest];
  }
  return (
    <>
      <nav
        className="alphabet-rail"
        aria-label="首字母定位"
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          const group = at(event.clientY, event.currentTarget);
          gesture.current = { pointer: event.pointerId, key: group.key, offset: group.offset };
          event.currentTarget.setPointerCapture(event.pointerId);
          setPreview(group.key);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (gesture.current?.pointer !== event.pointerId) return;
          const group = at(event.clientY, event.currentTarget);
          gesture.current = { pointer: event.pointerId, key: group.key, offset: group.offset };
          setPreview(group.key);
        }}
        onPointerUp={(event) => {
          if (gesture.current?.pointer !== event.pointerId) return;
          const offset = gesture.current.offset;
          gesture.current = null;
          setPreview(null);
          event.currentTarget.releasePointerCapture(event.pointerId);
          if (offset !== null) onJump(offset);
        }}
        onPointerCancel={() => {
          gesture.current = null;
          setPreview(null);
        }}
      >
        {index.groups.map((group) => (
          <button
            key={group.key}
            type="button"
            disabled={group.offset === null || !group.count}
            aria-label={`定位到 ${group.key}`}
            aria-pressed={preview === group.key}
            onClick={(event) => {
              if (event.detail === 0 && group.offset !== null) onJump(group.offset);
            }}
          >
            {group.key}
          </button>
        ))}
      </nav>
      {preview && (
        <div className="alphabet-preview" aria-hidden="true">
          {preview}
        </div>
      )}
    </>
  );
}
