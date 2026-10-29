import { expect, test } from '@playwright/test';
import { continuePodcastQueue } from '../src/podcast-continuation';
import { podcastEpisodeToTrack } from '../src/podcast-track';
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

test('倒序续播跳过完成项，保留半途进度且最多补充三集', () => {
  const queue = continuePodcastQueue(
    [track(8)],
    0,
    detail,
    { order: 'desc', skipCompleted: true },
    new Set(),
  );
  expect(ids(queue)).toEqual(['podcast_ep_8', 'podcast_ep_6', 'podcast_ep_5', 'podcast_ep_4']);
  expect(queue[1].podcast_position_seconds).toBe(40);
  expect(
    continuePodcastQueue(queue, 0, detail, { order: 'desc', skipCompleted: true }, new Set()),
  ).toBe(queue);
});
test('跟随列表的正序从当前单集向后续播，关闭时不删除手动项', () => {
  const current = { ...track(3), podcast_list_order: 'asc' as const };
  const manual = track(8);
  const queue = continuePodcastQueue(
    [current, manual],
    0,
    detail,
    { order: 'follow', skipCompleted: true },
    new Set(),
  );
  expect(ids(queue)).toEqual([
    'podcast_ep_3',
    'podcast_ep_8',
    'podcast_ep_4',
    'podcast_ep_5',
    'podcast_ep_6',
  ]);
  expect(
    ids(continuePodcastQueue(queue, 0, detail, { order: 'off', skipCompleted: true }, new Set())),
  ).toEqual(['podcast_ep_3', 'podcast_ep_8']);
});
test('手动项优先、移除项不重新出现、队列不会重复单集', () => {
  const queue = continuePodcastQueue(
    [track(8), track(5)],
    0,
    detail,
    { order: 'desc', skipCompleted: true },
    new Set(['podcast_ep_6']),
  );
  expect(ids(queue)).toEqual([
    'podcast_ep_8',
    'podcast_ep_5',
    'podcast_ep_4',
    'podcast_ep_3',
    'podcast_ep_2',
  ]);
});
test('切换顺序只替换自动尾部，并允许主动重听已完成项', () => {
  const queue = continuePodcastQueue(
    [track(5)],
    0,
    detail,
    { order: 'desc', skipCompleted: true },
    new Set(),
  );
  expect(
    ids(continuePodcastQueue(queue, 0, detail, { order: 'asc', skipCompleted: false }, new Set())),
  ).toEqual(['podcast_ep_5', 'podcast_ep_6', 'podcast_ep_7', 'podcast_ep_8']);
});
test('读不到当前单集时不猜测接续，且不改其他节目的队列', () => {
  const unrelated = [{ ...track(3), podcast_id: 'another' }];
  expect(
    continuePodcastQueue(unrelated, 0, detail, { order: 'desc', skipCompleted: true }, new Set()),
  ).toBe(unrelated);
  expect(
    continuePodcastQueue(
      [{ ...track(3), id: 'missing' }],
      0,
      detail,
      { order: 'desc', skipCompleted: true },
      new Set(),
    ),
  ).toHaveLength(1);
});
