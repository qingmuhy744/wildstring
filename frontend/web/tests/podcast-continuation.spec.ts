import { expect, test } from '@playwright/test';
import {
  adjacentPodcastEpisode,
  previewPodcastTracks,
  readPodcastPreference,
  resolvePodcastPreference,
  savePodcastPreference,
  syncPodcastPreferenceCache,
} from '../src/podcast-continuation';
import { podcastEpisodeToTrack } from '../src/podcast-track';
import { placeQueuedEpisode, type RemoteQueueItem } from '../src/podcast-remote';
import type { PodcastDetail } from '../src/podcasts';

const detail = {
  podcast: { id: 'show', title: '一个节目', author: '作者', cover_url: '' },
  episodes: Array.from({ length: 8 }, (_, i) => ({
    id: `${i + 1}`,
    title: `第 ${i + 1} 集`,
    description: '',
    duration_seconds: 100,
    pub_date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    episode_number: i + 1,
    season_number: null,
    created_at: '',
    position_seconds: i === 5 ? 40 : 0,
    completed: i === 6,
  })),
} as PodcastDetail;
const track = (number: number) =>
  podcastEpisodeToTrack(detail.episodes[number - 1], detail.podcast);
const ids = (queue: ReturnType<typeof track>[]) => queue.map((item) => item.id);

test('倒序预览跳过已听完，不含当前集，也不改写输入', () => {
  const current = track(8);
  const preview = previewPodcastTracks(
    current,
    detail,
    { order: 'desc', skipCompleted: true },
    new Set(),
  );
  expect(ids(preview)).toEqual(['podcast_ep_6', 'podcast_ep_5', 'podcast_ep_4']);
  expect(preview[0].podcast_position_seconds).toBe(40);
  expect(preview.every((item) => item.podcast_queue_origin === 'auto')).toBe(true);
  expect(current.podcast_queue_origin).toBeUndefined();
});

test('跟随列表向后续预览，关闭时为空，手动项只作为排除名单', () => {
  const current = { ...track(3), podcast_list_order: 'asc' as const };
  expect(
    ids(
      previewPodcastTracks(
        current,
        detail,
        { order: 'follow', skipCompleted: true },
        new Set(['podcast_ep_8']),
      ),
    ),
  ).toEqual(['podcast_ep_4', 'podcast_ep_5', 'podcast_ep_6']);
  expect(
    previewPodcastTracks(current, detail, { order: 'off', skipCompleted: true }, new Set()),
  ).toEqual([]);
  expect(
    previewPodcastTracks(
      current,
      detail,
      { order: 'asc', skipCompleted: true, autoContinue: false },
      new Set(),
    ),
  ).toEqual([]);
  const episodes = detail.episodes.map((episode) => episode.id);
  previewPodcastTracks(current, detail, { order: 'asc', skipCompleted: true }, new Set());
  expect(detail.episodes.map((episode) => episode.id)).toEqual(episodes);
});

test('被排除的预览不再出现，已听完可以重新纳入', () => {
  expect(
    ids(
      previewPodcastTracks(
        track(8),
        detail,
        { order: 'desc', skipCompleted: true },
        new Set(['podcast_ep_6']),
      ),
    ),
  ).toEqual(['podcast_ep_5', 'podcast_ep_4', 'podcast_ep_3']);
  expect(
    ids(previewPodcastTracks(track(5), detail, { order: 'asc', skipCompleted: false }, new Set())),
  ).toEqual(['podcast_ep_6', 'podcast_ep_7', 'podcast_ep_8']);
});

test('节目线向前跳过已听完，向后回到列表里的上一集', () => {
  const preference = { order: 'desc' as const, skipCompleted: true, autoContinue: true };
  expect(adjacentPodcastEpisode(track(8).id, detail, preference, new Set(), 1)?.id).toBe(
    'podcast_ep_6',
  );
  expect(adjacentPodcastEpisode(track(8).id, detail, preference, new Set(), -1)).toBeNull();
  expect(adjacentPodcastEpisode(track(6).id, detail, preference, new Set(), -1)?.id).toBe(
    'podcast_ep_7',
  );
  expect(
    adjacentPodcastEpisode(
      track(6).id,
      detail,
      { ...preference, autoContinue: false },
      new Set(),
      1,
    ),
  ).toBeNull();
});

test('当前单集不在这个节目里时不猜测下一集', () => {
  expect(
    previewPodcastTracks(
      { ...track(3), podcast_id: 'another' },
      detail,
      { order: 'desc', skipCompleted: true },
      new Set(),
    ),
  ).toEqual([]);
  expect(
    previewPodcastTracks(
      { ...track(3), id: 'missing' },
      detail,
      { order: 'desc', skipCompleted: true },
      new Set(),
    ),
  ).toEqual([]);
});

test('节目设置优先于账号默认值，离线缓存按账号隔离', () => {
  const storage = new Map<string, string>();
  const previousStorage = (globalThis as { localStorage?: Storage }).localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
  });
  try {
    // 1. Account auto_continue is false and show-a has no per-show override: inherits off.
    const remotePrefs = {
      auto_continue: false,
      shows: {
        'show-b': { order: 'asc' as const, skip_completed: false, auto_continue: true },
      },
    };
    const showA = syncPodcastPreferenceCache('alice', 'show-a', remotePrefs);
    expect(showA).toEqual({ order: 'off', skipCompleted: true, autoContinue: false });
    expect(previewPodcastTracks(track(3), detail, showA, new Set())).toEqual([]);

    // 2. show-b has explicit per-show override: overrides account auto_continue=false.
    const showB = syncPodcastPreferenceCache('alice', 'show-b', remotePrefs);
    expect(showB).toEqual({ order: 'asc', skipCompleted: false, autoContinue: true });

    // 3. Offline fallback uses Alice's cached account/show preferences, while Bob's account is isolated.
    expect(readPodcastPreference('alice', 'show-a')).toEqual({
      order: 'off',
      skipCompleted: true,
      autoContinue: false,
    });
    expect(readPodcastPreference('alice', 'show-b')).toEqual({
      order: 'asc',
      skipCompleted: false,
      autoContinue: true,
    });
    expect(readPodcastPreference('bob', 'show-a')).toEqual({
      order: 'follow',
      skipCompleted: true,
      autoContinue: true,
    });

    // 4. Stale per-show local cache is cleared if server no longer has a show override.
    savePodcastPreference('alice', 'show-c', {
      order: 'desc',
      skipCompleted: true,
      autoContinue: true,
    });
    const showCAfterSync = syncPodcastPreferenceCache('alice', 'show-c', remotePrefs);
    expect(showCAfterSync).toEqual({ order: 'off', skipCompleted: true, autoContinue: false });
    expect(readPodcastPreference('alice', 'show-c')).toEqual({
      order: 'off',
      skipCompleted: true,
      autoContinue: false,
    });
    expect(resolvePodcastPreference(null, 'show-c', showCAfterSync)).toEqual({
      order: 'off',
      skipCompleted: true,
      autoContinue: false,
    });
  } finally {
    if (previousStorage) {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: previousStorage,
      });
    }
  }
});

test('加入待播不挪动已在列表中的单集，下一集播放只改位置', () => {
  const queue: RemoteQueueItem[] = [
    { episode_id: 'now', origin: 'manual', added_at: 't1' },
    { episode_id: 'later', origin: 'rule', added_at: 't2' },
  ];
  expect(placeQueuedEpisode(queue, 'later', false, 'now')).toBe(queue);
  expect(placeQueuedEpisode(queue, 'now', true, 'now')).toBe(queue);
  expect(placeQueuedEpisode(queue, 'fresh', false, 'fresh').map((item) => item.episode_id)).toEqual(
    ['now', 'later', 'fresh'],
  );
  const inserted = placeQueuedEpisode(queue, 'later', true, undefined);
  expect(inserted.map((item) => item.episode_id)).toEqual(['later', 'now']);
  expect(inserted[0].origin).toBe('manual');
  expect(inserted[0].added_at).toBe('t2');
  expect(inserted[1].origin).toBe('manual');
});
