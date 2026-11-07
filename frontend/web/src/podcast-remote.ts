import { api, ApiError, type Track } from './api';
import type { PodcastEpisode, PodcastSummary } from './podcasts';
import type { PodcastPreference } from './podcast-continuation';
import { podcastEpisodeToTrack } from './podcast-track';

export type QueueOrigin = 'manual' | 'rule';
export type NewEpisodeAction = 'inbox' | 'queue_last' | 'queue_next' | 'ignore';

export interface RemoteQueueItem {
  episode_id: string;
  origin: QueueOrigin;
}

export interface RemoteQueue {
  version: number;
  device_id: string;
  items: RemoteQueueItem[];
  updated_at: string | null;
}

export interface InboxItem {
  episode_id: string;
  podcast_id: string;
  source: string;
  added_at: string;
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
  shows: Record<string, ShowQueuePreference>;
}

const deviceKey = 'wildstring:device-id';

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
  return api<RemoteQueue>('/podcasts/queue', {
    method: 'PUT',
    body: JSON.stringify({ version, device_id: podcastDeviceId(), items }),
  });
}

export function getInbox() {
  return api<{ version: number; items: InboxItem[] }>('/podcasts/inbox');
}

export function addInbox(episodeId: string) {
  return api(`/podcasts/inbox/items/${encodeURIComponent(episodeId)}`, { method: 'PUT' });
}

export function removeInbox(episodeId: string) {
  return api(`/podcasts/inbox/items/${encodeURIComponent(episodeId)}`, { method: 'DELETE' });
}

export function getQueuePreferences() {
  return api<QueuePreferences>('/podcasts/queue/preferences');
}

export function putQueuePreferences(body: QueuePreferences) {
  return api<QueuePreferences>('/podcasts/queue/preferences', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function saveShowPlaybackPreference(showId: string, preference: PodcastPreference) {
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
}

export async function saveShowDelivery(
  showId: string,
  action: NewEpisodeAction,
  autoLimit: number,
) {
  const current = await getQueuePreferences();
  const previous = current.shows[showId];
  current.shows[showId] = {
    action,
    auto_limit: autoLimit,
    order: previous?.order ?? 'follow',
    skip_completed: previous?.skip_completed ?? true,
    auto_continue: previous?.auto_continue ?? true,
  };
  return putQueuePreferences(current);
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

export async function saveQueueDefaults(action: NewEpisodeAction, autoLimit: number) {
  const current = await getQueuePreferences();
  current.default_action = action;
  current.auto_limit = Math.max(0, Math.min(100, autoLimit));
  return putQueuePreferences(current);
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
