import { useSyncExternalStore } from 'react';
import { api, type Track, type TrackPage } from './api';
import i18n from './i18n';
import { selectedLibrary } from './library-context';

export type PlaybackMode = 'sequential' | 'repeat_all' | 'repeat_one' | 'shuffle';
export const modeNames: Record<PlaybackMode, string> = {
  get sequential() {
    return i18n.t('playbackState.sequential');
  },
  get repeat_all() {
    return i18n.t('playbackState.repeatAll');
  },
  get repeat_one() {
    return i18n.t('playbackState.repeatOne');
  },
  get shuffle() {
    return i18n.t('playbackState.shuffle');
  },
};
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];
export function playbackPosition(initial: number) {
  let seconds = initial;
  const listeners = new Set<() => void>();
  return {
    read: () => seconds,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(value: number) {
      if (seconds === value) return;
      seconds = value;
      listeners.forEach((listener) => listener());
    },
  };
}

export type PlaybackPosition = ReturnType<typeof playbackPosition>;
const idlePosition = playbackPosition(0);

export function usePlaybackPosition(position = idlePosition, enabled = true) {
  const source = enabled ? position : idlePosition;
  return useSyncExternalStore(source.subscribe, source.read);
}

export function normalizePlaybackRate(value: unknown): PlaybackRate {
  const rate = Number(value);
  return PLAYBACK_RATES.includes(rate as PlaybackRate) ? (rate as PlaybackRate) : 1;
}
export const MUSIC_QUEUE_LIMIT = 100;
export const COLLECTION_LIMIT = 5000;
export type HeartBatch = { library: string; recommended: boolean };

export function musicWindow(total: number, selected: number) {
  const offset = total > MUSIC_QUEUE_LIMIT ? selected : 0;
  return { offset, count: Math.min(total - offset, MUSIC_QUEUE_LIMIT), index: selected - offset };
}

// Some sources return fewer rows than requested. Stop at the end of the window.
export async function readMusicWindow<T>(
  total: number,
  selected: number,
  read: (offset: number, limit: number) => Promise<{ total: number; items: T[] }>,
) {
  const { offset, count } = musicWindow(total, selected);
  const items: T[] = [];
  while (items.length < count) {
    const remaining = count - items.length;
    const page = await read(offset + items.length, remaining);
    if (page.total !== total) throw new Error(i18n.t('playbackState.collectionChanged'));
    if (!page.items.length) throw new Error(i18n.t('playbackState.collectionIncomplete'));
    items.push(...page.items.slice(0, remaining));
  }
  return items;
}
export function catalogMusicWindow(
  path: string,
  total: number,
  selected: number,
  signal: AbortSignal,
) {
  const url = new URL(path, location.origin);
  return readMusicWindow(total, selected, (offset, limit) => {
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(limit));
    return api<TrackPage>(url.pathname + url.search, { signal });
  });
}
export interface SavedPlayback {
  heart?: HeartBatch | null;
  tracks: Track[];
  index: number;
  position: number;
  quality: string;
  volume: number;
  playbackRate: PlaybackRate;
  mode: PlaybackMode;
}
export function playbackKey(userId: string) {
  return `wildstring:playback:${userId}`;
}
export function readPlayback(userId: string): SavedPlayback | null {
  try {
    const value = JSON.parse(localStorage.getItem(playbackKey(userId)) || 'null');
    if (
      !value ||
      !Array.isArray(value.tracks) ||
      !value.tracks.length ||
      value.tracks.length > COLLECTION_LIMIT ||
      !value.tracks.every(
        (t: Track) =>
          typeof t?.id === 'string' &&
          typeof t.title === 'string' &&
          Array.isArray(t.artists) &&
          Number.isFinite(t.duration_ms),
      ) ||
      !Number.isInteger(value.index) ||
      value.index < 0 ||
      value.index >= value.tracks.length
    )
      return null;
    const music = !value.tracks.some((track: Track) => track.id.startsWith('podcast_ep_'));
    const { offset, count, index } = music
      ? musicWindow(value.tracks.length, value.index)
      : { offset: 0, count: value.tracks.length, index: value.index };
    return {
      ...value,
      heart:
        value.heart?.library === selectedLibrary()
          ? value.heart
          : music && value.tracks.length > MUSIC_QUEUE_LIMIT
            ? { library: selectedLibrary(), recommended: false }
            : null,
      index,
      tracks: value.tracks.slice(offset, offset + count).map((track: Partial<Track>) => ({
        album_artists: [],
        artist_credit: '',
        album_artist_credit: '',
        composers: [],
        lyricists: [],
        arrangers: [],
        vocalists: [],
        genres: [],
        tags: [],
        track_total: null,
        disc_total: null,
        release_date: null,
        original_date: null,
        external_ids: {},
        description: '',
        track_number: null,
        disc_number: null,
        sample_rate: null,
        loved: false,
        play_count: 0,
        listened_ms: 0,
        last_played_at: null,
        added_at: '',
        ...track,
      })),
      position: Math.max(0, Number(value.position) || 0),
      quality: ['original', '128', '192', '256', '320'].includes(value.quality)
        ? value.quality
        : 'original',
      volume: Math.max(0, Math.min(1, Number(value.volume) || 0)),
      playbackRate: normalizePlaybackRate(value.playbackRate),
      mode: Object.hasOwn(modeNames, value.mode) ? value.mode : 'sequential',
    };
  } catch {
    return null;
  }
}
export function savePlayback(userId: string, state: SavedPlayback) {
  try {
    localStorage.setItem(
      playbackKey(userId),
      JSON.stringify({
        ...state,
        tracks: state.tracks.map((track) => ({
          id: track.id,
          album_id: track.album_id,
          library_id: track.library_id,
          title: track.title,
          artists: track.artists,
          album: track.album,
          duration_ms: track.duration_ms,
          format: track.format,
          status: track.status,
          ...(track.id.startsWith('podcast_ep_')
            ? {
                podcast_id: track.podcast_id,
                podcast_queue_origin: track.podcast_queue_origin,
                podcast_list_order: track.podcast_list_order,
                podcast_position_seconds: track.podcast_position_seconds,
                podcast_completed: track.podcast_completed,
                cover_url: track.cover_url,
                description: track.description,
                release_date: track.release_date,
                track_number: track.track_number,
              }
            : {}),
        })),
      }),
    );
  } catch {
    /* storage may be full or disabled */
  }
}
// Offline saving still collects the entire source.
export async function collectTracks(path: string, signal?: AbortSignal): Promise<Track[]> {
  const url = new URL(path, location.origin);
  url.searchParams.set('limit', '200');
  const items: Track[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  let total = -1;
  while (true) {
    url.searchParams.set('offset', String(cursor));
    const page = await api<TrackPage>(`${url.pathname}${url.search}`, { signal });
    if (!Number.isInteger(page.total) || page.total > COLLECTION_LIMIT)
      throw new Error(i18n.t('playbackState.collectionLimitExceeded', { limit: COLLECTION_LIMIT }));
    if (total !== -1 && total !== page.total)
      throw new Error(i18n.t('playbackState.collectionChanged'));
    total = page.total;
    if (!page.items.length && cursor < total)
      throw new Error(i18n.t('playbackState.collectionIncomplete'));
    for (const track of page.items) {
      if (seen.has(track.id)) throw new Error(i18n.t('playbackState.collectionOrderChanged'));
      seen.add(track.id);
      items.push(track);
    }
    cursor += page.items.length;
    if (cursor >= total) return items;
  }
}
