import { hints } from './help-content';
import { useState } from 'react';

export type CatalogSort = { sort: string; order: 'asc' | 'desc' };
export const albumSorts = [
  ['title', '专辑名称'],
  ['added_at', '入库时间'],
  ['release_date', '发行时间'],
  ['artist', '艺人名称'],
];
export const trackSorts = [
  ['name', '歌曲名称'],
  ['added_at', '入库时间'],
  ['duration_ms', '歌曲时长'],
  ['play_count', '播放次数'],
  ['listened_ms', '收听时长'],
  ['last_played_at', '最近听过'],
];
export function defaultSort(context: string): CatalogSort {
  return context === 'album-tracks'
    ? { sort: 'track_number', order: 'asc' }
    : context === 'recent'
      ? { sort: 'last_played_at', order: 'desc' }
      : { sort: 'title', order: 'asc' };
}
export function sortChoices(context: string) {
  return context.endsWith('albums')
    ? albumSorts
    : context === 'album-tracks'
      ? [['track_number', '碟号与曲序'], ...trackSorts]
      : trackSorts.map(([key, label]) => [key === 'name' ? 'title' : key, label]);
}
export function useCatalogSorting(userId: string, context: string) {
  const key = `wildstring:catalog-sorting:${userId}`;
  const [stored, setStored] = useState<Record<string, CatalogSort>>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) || '{}') || {};
    } catch {
      return {};
    }
  });
  const candidate = stored[context];
  const selection =
    candidate &&
    sortChoices(context).some(([key]) => key === candidate.sort) &&
    ['asc', 'desc'].includes(candidate.order)
      ? candidate
      : defaultSort(context);
  function change(value: CatalogSort) {
    setStored((previous) => {
      const next = { ...previous, [context]: value };
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* session-only preference */
      }
      return next;
    });
  }
  return { selection, change };
}
export function CatalogSortControl({
  context,
  selection,
  change,
}: {
  context: string;
  selection: CatalogSort;
  change: (value: CatalogSort) => void;
}) {
  return (
    <div className="catalog-sort-control" data-help={hints.sorting}>
      <select
        aria-label="列表排序"
        value={selection.sort}
        onChange={(event) => {
          const sort = event.target.value;
          change({
            sort,
            order: ['title', 'name', 'artist', 'track_number'].includes(sort) ? 'asc' : 'desc',
          });
        }}
      >
        {sortChoices(context).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      <button
        className="text-button"
        aria-label={selection.order === 'asc' ? '切换为降序' : '切换为升序'}
        data-help={
          selection.order === 'asc' ? '当前升序，点击切换为降序。' : '当前降序，点击切换为升序。'
        }
        onClick={() => change({ ...selection, order: selection.order === 'asc' ? 'desc' : 'asc' })}
      >
        {selection.order === 'asc' ? '↑ 升序' : '↓ 降序'}
      </button>
    </div>
  );
}
