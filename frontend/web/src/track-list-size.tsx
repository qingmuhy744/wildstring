import { useSyncExternalStore } from 'react';

export type TrackListSize = 'small' | 'medium' | 'large';
const KEY = 'wildstring:track-list-size';
const listeners = new Set<() => void>();
const beforeChange = new Set<() => void>();
function normalized(value: unknown): TrackListSize {
  return value === 'small' || value === 'large' ? value : 'medium';
}
function saved(): TrackListSize {
  try {
    return normalized(localStorage.getItem(KEY));
  } catch {
    return 'medium';
  }
}
let selected = saved();
function publish(value: TrackListSize) {
  if (selected === value) return;
  beforeChange.forEach((capture) => capture());
  selected = value;
  listeners.forEach((changed) => changed());
}
export function beforeTrackListSizeChange(capture: () => void) {
  beforeChange.add(capture);
  return () => {
    beforeChange.delete(capture);
  };
}
function storage(event: StorageEvent) {
  if (event.key === KEY) publish(normalized(event.newValue));
  else if (event.key === null) publish(saved());
}
// Album/artist grids do not mount a song table. Keep the shared preference
// current there too, so returning to songs sees changes from another tab.
window.addEventListener('storage', storage);
function subscribe(changed: () => void) {
  listeners.add(changed);
  return () => {
    listeners.delete(changed);
  };
}
export function useTrackListSize() {
  return useSyncExternalStore(
    subscribe,
    () => selected,
    () => 'medium' as const,
  );
}
function choose(value: string) {
  const size = normalized(value);
  // Persist when available; the external store also works in private/blocked storage.
  try {
    localStorage.setItem(KEY, size);
  } catch {
    /* Keep the current tab preference. */
  }
  publish(size);
}
export function TrackListSizeControl() {
  const size = useTrackListSize();
  return (
    <label className="theme-control track-list-size-control">
      <span>歌曲列表大小</span>
      <select
        aria-label="歌曲列表大小"
        value={size}
        onChange={(event) => choose(event.target.value)}
      >
        <option value="small">小</option>
        <option value="medium">中（推荐）</option>
        <option value="large">大</option>
      </select>
    </label>
  );
}
