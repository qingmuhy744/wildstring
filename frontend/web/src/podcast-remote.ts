import { api, ApiError, type Track } from './api';
import type { PodcastEpisode, PodcastSummary } from './podcasts';
import type { PodcastPreference } from './podcast-continuation';
import { podcastEpisodeToTrack } from './podcast-track';

export type QueueOrigin = 'manual' | 'rule';
export type NewEpisodeAction = 'queue_last' | 'queue_next' | 'ignore';

export interface RemoteQueueItem {
  episode_id: string;
  origin: QueueOrigin;
  added_at?: string;
}

export interface RemoteQueue {
  version: number;
  device_id: string;
  items: RemoteQueueItem[];
  updated_at: string | null;
  /** `queue_full` when an automatic batch was refused because the queue is at the cap. */
  notice?: string;
}

export interface ShowQueuePreference {
  action: NewEpisodeAction;
  auto_limit: number;
  order: PodcastPreference['order'];
  skip_completed: boolean;
  auto_continue: boolean;
}

export interface QueuePreferences {
  default_action: NewEpisodeAction;
  auto_limit: number;
  auto_continue?: boolean;
  shows: Record<string, ShowQueuePreference>;
}

const deviceKey = 'wildstring:device-id';

/** Stored `inbox` from older servers is the tail of the queue. */
export function normalizeDeliveryAction(action: string | undefined): NewEpisodeAction {
  if (action === 'queue_next' || action === 'ignore' || action === 'queue_last') return action;
  return 'queue_last';
}

/**
 * Append, or insert for play-next. An episode already in the queue stays put on append.
 * Play-next of the loaded episode does nothing. Otherwise play-next inserts after that
 * episode when it is queued, or at the front. A newly placed row is manual.
 * Returns the same array when nothing changes.
 */
export function placeQueuedEpisode(
  items: RemoteQueueItem[],
  episodeId: string,
  next: boolean,
  currentEpisodeId?: string | null,
): RemoteQueueItem[] {
  if (!episodeId || (next && currentEpisodeId && episodeId === currentEpisodeId)) return items;
  const existing = items.find((item) => item.episode_id === episodeId);
  if (!next && existing) return items;
  const rest = items.filter((item) => item.episode_id !== episodeId);
  const entry: RemoteQueueItem = existing
    ? { ...existing, origin: 'manual' }
    : { episode_id: episodeId, origin: 'manual' };
  if (!next) return [...rest, entry];
  const at = currentEpisodeId ? rest.findIndex((item) => item.episode_id === currentEpisodeId) : -1;
  const index = at >= 0 ? at + 1 : 0;
  return [...rest.slice(0, index), entry, ...rest.slice(index)];
}

export function podcastDeviceId() {
  try {
    const existing = localStorage.getItem(deviceKey);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(deviceKey, created);
    return created;
  } catch {
    return 'web';
  }
}

export function getPodcastQueue() {
  return api<RemoteQueue>('/podcasts/queue');
}

export async function putPodcastQueue(version: number, items: RemoteQueueItem[]) {
  const normalized = items.map((item) =>
    item.added_at
      ? { episode_id: item.episode_id, origin: item.origin, added_at: item.added_at }
      : { episode_id: item.episode_id, origin: item.origin },
  );
  try {
    return await api<RemoteQueue>('/podcasts/queue', {
      method: 'PUT',
      body: JSON.stringify({ version, device_id: podcastDeviceId(), items: normalized }),
    });
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 422 &&
      normalized.some((item) => 'added_at' in item)
    ) {
      const legacy = normalized.map(({ episode_id, origin }) => ({ episode_id, origin }));
      return api<RemoteQueue>('/podcasts/queue', {
        method: 'PUT',
        body: JSON.stringify({ version, device_id: podcastDeviceId(), items: legacy }),
      });
    }
    throw error;
  }
}

export interface EpisodeFavoriteResponse {
  episode_id: string;
  favorite: boolean;
  loved: boolean;
}

export function favoritePodcastEpisode(id: string, loved: boolean) {
  return api<EpisodeFavoriteResponse>(`/podcasts/episodes/${encodeURIComponent(id)}/favorite`, {
    method: 'PUT',
    body: JSON.stringify({ favorite: loved, loved }),
  });
}

export async function getQueuePreferences() {
  const body = await api<QueuePreferences>('/podcasts/queue/preferences');
  const shows = Object.fromEntries(
    Object.entries(body.shows || {}).map(([id, pref]) => [
      id,
      { ...pref, action: normalizeDeliveryAction(pref.action) },
    ]),
  );
  return { ...body, default_action: normalizeDeliveryAction(body.default_action), shows };
}

export function putQueuePreferences(body: QueuePreferences) {
  return api<QueuePreferences>('/podcasts/queue/preferences', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

let preferenceWriteChain: Promise<unknown> = Promise.resolve();

function serializePreferenceWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = preferenceWriteChain.then(task, task);
  preferenceWriteChain = next.catch(() => {});
  return next;
}

export function saveShowPlaybackPreference(showId: string, preference: PodcastPreference) {
  return serializePreferenceWrite(async () => {
    const current = await getQueuePreferences();
    const previous = current.shows[showId];
    current.shows[showId] = {
      action: previous?.action ?? current.default_action,
      auto_limit: previous?.auto_limit ?? current.auto_limit,
      order: preference.order,
      skip_completed: preference.skipCompleted,
      auto_continue: preference.order !== 'off',
    };
    return putQueuePreferences(current);
  });
}

export function saveShowDelivery(showId: string, action: NewEpisodeAction, autoLimit: number) {
  return serializePreferenceWrite(async () => {
    const current = await getQueuePreferences();
    const previous = current.shows[showId];
    const accountAutoContinue = current.auto_continue !== false;
    current.shows[showId] = {
      action,
      auto_limit: autoLimit,
      order: previous?.order ?? (accountAutoContinue ? 'follow' : 'off'),
      skip_completed: previous?.skip_completed ?? true,
      auto_continue: previous?.auto_continue ?? accountAutoContinue,
    };
    return putQueuePreferences(current);
  });
}

export async function removeQueuedEpisode(episodeId: string) {
  const remote = await getPodcastQueue();
  if (!remote.items.some((item) => item.episode_id === episodeId)) return remote;
  return putPodcastQueue(
    remote.version,
    remote.items.filter((item) => item.episode_id !== episodeId),
  );
}

export function isQueueConflict(error: unknown): error is ApiError {
  return (
    error instanceof ApiError && error.status === 409 && error.code === 'podcast_queue_conflict'
  );
}

export function queueConflictVersion(error: unknown) {
  if (!isQueueConflict(error)) return undefined;
  const version = (error.detail as { current?: { version?: unknown } } | undefined)?.current
    ?.version;
  return typeof version === 'number' ? version : null;
}

export function saveQueueDefaults(action: NewEpisodeAction, autoLimit: number) {
  return serializePreferenceWrite(async () => {
    const current = await getQueuePreferences();
    current.default_action = action;
    current.auto_limit = Math.max(0, Math.min(100, autoLimit));
    return putQueuePreferences(current);
  });
}

export async function resolveQueuedTracks(items: RemoteQueueItem[]): Promise<Track[]> {
  const tracks: Track[] = [];
  for (const item of items) {
    const episode = await api<PodcastEpisode>(
      `/podcasts/episodes/${encodeURIComponent(item.episode_id)}`,
    );
    const detail = await api<{ podcast: PodcastSummary }>(
      `/podcasts/${encodeURIComponent(episode.podcast_id)}`,
    );
    const track = podcastEpisodeToTrack(episode, detail.podcast);
    track.podcast_queue_origin = item.origin;
    tracks.push(track);
  }
  return tracks;
}
