import type { Track } from './api';
import type { PodcastDetail } from './podcasts';
import { podcastEpisodeToTrack } from './podcast-track';

export type PodcastOrder = 'follow' | 'asc' | 'desc' | 'off';
export type PodcastPreference = {
  order: PodcastOrder;
  skipCompleted: boolean;
  autoContinue?: boolean;
};
export const defaultPodcastPreference: PodcastPreference = {
  order: 'follow',
  skipCompleted: true,
  autoContinue: true,
};
const preferenceKey = (user: string, show: string) => `wildstring:podcast-order:${user}:${show}`;
const PREVIEW_LIMIT = 3;

export function readPodcastPreference(user: string, show: string): PodcastPreference {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey(user, show)) || 'null');
    const order = ['follow', 'asc', 'desc', 'off'].includes(value?.order) ? value.order : 'follow';
    return {
      order,
      skipCompleted: value?.skipCompleted !== false,
      autoContinue: order !== 'off' && value?.autoContinue !== false,
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

export function podcastAutoContinues(preference: PodcastPreference) {
  return preference.order !== 'off' && preference.autoContinue !== false;
}

// Read-only lookahead. Never returns the current episode or a rewritten queue.
export function nextPodcastPreview(
  currentTrackId: string | null | undefined,
  detail: PodcastDetail | null | undefined,
  preference: PodcastPreference,
  dismissed: ReadonlySet<string>,
  options?: { listOrder?: 'asc' | 'desc'; excludeIds?: ReadonlySet<string> },
): Track[] {
  if (!currentTrackId || !detail || !podcastAutoContinues(preference)) return [];
  const direction = preference.order === 'follow' ? options?.listOrder || 'desc' : preference.order;
  if (direction === 'off') return [];
  const episodes = [...detail.episodes].sort((a, b) => {
    const aDate = Date.parse(a.pub_date),
      bDate = Date.parse(b.pub_date);
    const dates = Number.isFinite(aDate) && Number.isFinite(bDate) ? aDate - bDate : 0;
    const order =
      dates || (a.episode_number ?? 0) - (b.episode_number ?? 0) || a.id.localeCompare(b.id);
    return direction === 'asc' ? order : -order;
  });
  const at = episodes.findIndex((episode) => `podcast_ep_${episode.id}` === currentTrackId);
  if (at < 0) return [];
  const blocked = new Set(dismissed);
  blocked.add(currentTrackId);
  options?.excludeIds?.forEach((id) => blocked.add(id));
  const skipCompleted = preference.skipCompleted !== false;
  return episodes
    .slice(at + 1)
    .filter((episode) => {
      const id = `podcast_ep_${episode.id}`;
      return (!skipCompleted || !episode.completed) && !blocked.has(id) && !blocked.has(episode.id);
    })
    .slice(0, PREVIEW_LIMIT)
    .map((episode) => ({
      ...podcastEpisodeToTrack(episode, detail.podcast),
      podcast_queue_origin: 'auto' as const,
    }));
}

/** Same preview, addressed by the current track instead of its id. */
export function previewPodcastTracks(
  current: Track | undefined,
  detail: PodcastDetail | null,
  preference: PodcastPreference,
  blocked: ReadonlySet<string>,
): Track[] {
  if (current?.podcast_id && detail && current.podcast_id !== detail.podcast.id) return [];
  return nextPodcastPreview(current?.id, detail, preference, blocked, {
    listOrder: current?.podcast_list_order,
  });
}

export { podcastEpisodeToTrack as episodeTrack } from './podcast-track';
