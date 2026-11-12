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
const accountPreferenceKey = (user: string) => `wildstring:podcast-account:${user}`;
const PREVIEW_LIMIT = 3;

export interface RemoteShowPreferenceLike {
  order?: PodcastOrder;
  skip_completed?: boolean;
  auto_continue?: boolean;
}

export interface RemotePreferencesLike {
  auto_continue?: boolean;
  shows?: Record<string, RemoteShowPreferenceLike>;
}

export function resolvePodcastPreference(
  prefs: RemotePreferencesLike | null | undefined,
  show: string,
  cached?: PodcastPreference,
): PodcastPreference {
  if (!prefs) return cached ? { ...cached } : { ...defaultPodcastPreference };
  const saved = prefs.shows?.[show];
  if (saved) {
    const order =
      saved.order && ['follow', 'asc', 'desc', 'off'].includes(saved.order)
        ? saved.order
        : 'follow';
    const enabled = saved.auto_continue !== false && order !== 'off';
    return {
      order: enabled ? order : 'off',
      skipCompleted: saved.skip_completed !== false,
      autoContinue: enabled,
    };
  }
  const accountAuto = prefs.auto_continue !== false;
  return {
    order: accountAuto ? 'follow' : 'off',
    skipCompleted: true,
    autoContinue: accountAuto,
  };
}

export function readPodcastPreference(user: string, show: string): PodcastPreference {
  try {
    const showRaw = localStorage.getItem(preferenceKey(user, show));
    if (showRaw) {
      const value = JSON.parse(showRaw);
      const order = ['follow', 'asc', 'desc', 'off'].includes(value?.order)
        ? value.order
        : 'follow';
      return {
        order,
        skipCompleted: value?.skipCompleted !== false,
        autoContinue: order !== 'off' && value?.autoContinue !== false,
      };
    }
    const accountRaw = localStorage.getItem(accountPreferenceKey(user));
    if (accountRaw) {
      const account = JSON.parse(accountRaw);
      if (typeof account?.autoContinue === 'boolean') {
        return {
          order: account.autoContinue ? 'follow' : 'off',
          skipCompleted: true,
          autoContinue: account.autoContinue,
        };
      }
    }
    return { ...defaultPodcastPreference };
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

export function syncPodcastPreferenceCache(
  user: string,
  show: string,
  prefs: RemotePreferencesLike,
): PodcastPreference {
  const resolved = resolvePodcastPreference(prefs, show);
  try {
    localStorage.setItem(
      accountPreferenceKey(user),
      JSON.stringify({ autoContinue: prefs.auto_continue !== false }),
    );
    if (prefs.shows?.[show]) {
      localStorage.setItem(preferenceKey(user, show), JSON.stringify(resolved));
    } else {
      localStorage.removeItem(preferenceKey(user, show));
    }
  } catch {
    // Playback remains available when device storage is disabled.
  }
  return resolved;
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

/** One step along the show order. Forward skips completed episodes; back steps to the previous episode. */
export function adjacentPodcastEpisode(
  currentTrackId: string | null | undefined,
  detail: PodcastDetail | null | undefined,
  preference: PodcastPreference,
  dismissed: ReadonlySet<string>,
  step: 1 | -1,
  options?: { listOrder?: 'asc' | 'desc' },
): Track | null {
  if (step > 0) {
    return nextPodcastPreview(currentTrackId, detail, preference, dismissed, options)[0] ?? null;
  }
  if (!currentTrackId || !detail || !podcastAutoContinues(preference)) return null;
  const direction = preference.order === 'follow' ? options?.listOrder || 'desc' : preference.order;
  if (direction === 'off') return null;
  const episodes = [...detail.episodes].sort((a, b) => {
    const aDate = Date.parse(a.pub_date),
      bDate = Date.parse(b.pub_date);
    const dates = Number.isFinite(aDate) && Number.isFinite(bDate) ? aDate - bDate : 0;
    const order =
      dates || (a.episode_number ?? 0) - (b.episode_number ?? 0) || a.id.localeCompare(b.id);
    return direction === 'asc' ? order : -order;
  });
  const at = episodes.findIndex((episode) => `podcast_ep_${episode.id}` === currentTrackId);
  if (at <= 0) return null;
  const episode = episodes[at - 1];
  if (!episode || dismissed.has(episode.id) || dismissed.has(`podcast_ep_${episode.id}`))
    return null;
  return {
    ...podcastEpisodeToTrack(episode, detail.podcast),
    podcast_queue_origin: 'auto' as const,
  };
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
