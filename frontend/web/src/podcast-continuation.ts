import type { Track } from './api';
import type { PodcastDetail } from './podcasts';
import { podcastEpisodeToTrack } from './podcast-track';

export type PodcastOrder = 'follow' | 'asc' | 'desc' | 'off';
export type PodcastPreference = { order: PodcastOrder; skipCompleted: boolean };
export const defaultPodcastPreference: PodcastPreference = { order: 'follow', skipCompleted: true };
const preferenceKey = (user: string, show: string) => `wildstring:podcast-order:${user}:${show}`;

export function readPodcastPreference(user: string, show: string): PodcastPreference {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey(user, show)) || 'null');
    return {
      order: ['follow', 'asc', 'desc', 'off'].includes(value?.order) ? value.order : 'follow',
      skipCompleted: value?.skipCompleted !== false,
    };
  } catch {
    return { ...defaultPodcastPreference };
  }
}

export function savePodcastPreference(user: string, show: string, value: PodcastPreference) {
  try {
    localStorage.setItem(preferenceKey(user, show), JSON.stringify(value));
  } catch {
    // Playback remains available when device storage is disabled.
  }
}

// A continuation is a small, replaceable tail. Explicit entries always keep their order.
export function continuePodcastQueue(
  queue: Track[],
  index: number,
  detail: PodcastDetail,
  preference: PodcastPreference,
  dismissed: ReadonlySet<string>,
): Track[] {
  const current = queue[index];
  if (!current || current.podcast_id !== detail.podcast.id) return queue;
  const prefix = queue.slice(0, index + 1);
  const manual = queue.slice(index + 1).filter((item) => item.podcast_queue_origin !== 'auto');
  const blocked = new Set([...prefix, ...manual].map((item) => item.id));
  const direction =
    preference.order === 'follow' ? current.podcast_list_order || 'desc' : preference.order;
  const episodes = [...detail.episodes].sort((a, b) => {
    const aDate = Date.parse(a.pub_date),
      bDate = Date.parse(b.pub_date);
    const dates = Number.isFinite(aDate) && Number.isFinite(bDate) ? aDate - bDate : 0;
    const order =
      dates || (a.episode_number ?? 0) - (b.episode_number ?? 0) || a.id.localeCompare(b.id);
    return direction === 'asc' ? order : -order;
  });
  const at = episodes.findIndex((episode) => `podcast_ep_${episode.id}` === current.id);
  const upcoming =
    direction === 'off' || at < 0
      ? []
      : episodes
          .slice(at + 1)
          .filter(
            (episode) =>
              (!preference.skipCompleted || !episode.completed) &&
              !blocked.has(`podcast_ep_${episode.id}`) &&
              !dismissed.has(`podcast_ep_${episode.id}`),
          )
          .slice(0, 3)
          .map((episode): Track => ({
            ...podcastEpisodeToTrack(episode, detail.podcast),
            podcast_queue_origin: 'auto',
            podcast_list_order: current.podcast_list_order || 'desc',
          }));
  const next = [...prefix, ...manual, ...upcoming].slice(0, 5000);
  return next.length === queue.length &&
    next.every(
      (item, i) =>
        item.id === queue[i].id && item.podcast_queue_origin === queue[i].podcast_queue_origin,
    )
    ? queue
    : next;
}
