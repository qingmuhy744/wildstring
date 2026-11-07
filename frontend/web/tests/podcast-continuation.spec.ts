import { expect, test } from '@playwright/test';
import { previewPodcastTracks } from '../src/podcast-continuation';
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
