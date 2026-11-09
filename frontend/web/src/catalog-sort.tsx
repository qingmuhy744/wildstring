import { hints } from './help-content';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from './i18n';

export type CatalogSort = { sort: string; order: 'asc' | 'desc' };

function makeSortItem(key: string, labelKey: string): [string, string] {
  const item = [key, ''];
  Object.defineProperty(item, 1, {
    get: () => i18n.t(labelKey),
    enumerable: true,
  });
  return item as [string, string];
}

export const albumSorts: [string, string][] = [
  makeSortItem('title', 'catalogSort.title'),
  makeSortItem('added_at', 'catalogSort.added_at'),
  makeSortItem('release_date', 'catalogSort.release_date'),
  makeSortItem('artist', 'catalogSort.artist'),
];
export const trackSorts: [string, string][] = [
  makeSortItem('name', 'catalogSort.name'),
  makeSortItem('added_at', 'catalogSort.added_at'),
  makeSortItem('duration_ms', 'catalogSort.duration_ms'),
  makeSortItem('play_count', 'catalogSort.play_count'),
  makeSortItem('listened_ms', 'catalogSort.listened_ms'),
  makeSortItem('last_played_at', 'catalogSort.last_played_at'),
];
export function defaultSort(context: string): CatalogSort {
  return context === 'album-tracks'
    ? { sort: 'track_number', order: 'asc' }
    : context === 'recent'
      ? { sort: 'last_played_at', order: 'desc' }
      : { sort: 'title', order: 'asc' };
}
export function sortChoices(context: string): [string, string][] {
  return context.endsWith('albums')
    ? albumSorts
    : context === 'album-tracks'
      ? [makeSortItem('track_number', 'catalogSort.track_number'), ...trackSorts]
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
  const { t } = useTranslation();
  return (
    <div className="catalog-sort-control" data-help={hints.sorting}>
      <select
        aria-label={t('catalogSort.ariaLabel')}
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
        aria-label={
          selection.order === 'asc' ? t('catalogSort.orderDescAria') : t('catalogSort.orderAscAria')
        }
        data-help={
          selection.order === 'asc' ? t('catalogSort.orderDescHelp') : t('catalogSort.orderAscHelp')
        }
        onClick={() => change({ ...selection, order: selection.order === 'asc' ? 'desc' : 'asc' })}
      >
        {selection.order === 'asc' ? t('catalogSort.asc') : t('catalogSort.desc')}
      </button>
    </div>
  );
}
