import { useEffect } from 'react';
import { api, ApiError, type Playlist, type TrackPage } from './api';
import { activeOfflineUserId, automaticDownloadNetworkAllowed, saveDownloads } from './offline';

const event = 'wildstring:offline-options';
const key = (userId: string) => `wildstring:auto-playlists:${userId}`;
export function followedPlaylists(userId: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(userId)) || '[]');
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string').slice(0, 100)
      : [];
  } catch {
    return [];
  }
}
export function followPlaylist(userId: string, id: string, enabled: boolean) {
  const ids = new Set(followedPlaylists(userId));
  if (enabled) ids.add(id);
  else ids.delete(id);
  localStorage.setItem(key(userId), JSON.stringify([...ids]));
  window.dispatchEvent(new Event(event));
}
export function allowMeteredDownloads() {
  return localStorage.getItem('wildstring:download-any-network') === 'true';
}
export function setAllowMeteredDownloads(enabled: boolean) {
  localStorage.setItem('wildstring:download-any-network', String(enabled));
  window.dispatchEvent(new Event(event));
}
export async function allDownloadPlaylists(): Promise<Playlist[]> {
  const result: Playlist[] = [];
  for (let offset = 0; ;) {
    const page = await api<{ items: Playlist[]; total: number }>(
      `/playlists?limit=100&offset=${offset}`,
    );
    result.push(...page.items);
    offset += page.items.length;
    if (!page.items.length || offset >= page.total) return result;
  }
}
let syncing = false;
export async function syncOfflinePlaylists(userId: string, signal?: AbortSignal) {
  if (syncing || activeOfflineUserId() !== userId) return;
  if (!automaticDownloadNetworkAllowed())
    throw new Error('等待可识别的 Wi-Fi／有线网络；也可以在下载设置中允许移动数据或未知网络。');
  syncing = true;
  const valid = () => !signal?.aborted && activeOfflineUserId() === userId;
  try {
    for (const id of followedPlaylists(userId)) {
      if (!valid()) return;
      const tracks = [];
      let total = -1;
      try {
        for (let offset = 0; ;) {
          const page = await api<TrackPage>(
            `/playlists/${encodeURIComponent(id)}/tracks?limit=200&offset=${offset}`,
            { signal },
          );
          if (!valid()) return;
          if (total === -1) total = page.total;
          if (total !== page.total || total > 1000)
            throw new Error('歌单已变化或超过离线 1000 首上限，请检查后重试。');
          tracks.push(...page.items);
          offset += page.items.length;
          if (!page.items.length || offset >= total) break;
        }
        if (tracks.length !== total) throw new Error('歌单读取不完整，请稍后重试。');
        if (valid() && followedPlaylists(userId).includes(id)) await saveDownloads(tracks, true);
      } catch (error) {
        if (!valid()) return;
        if (error instanceof ApiError && error.status === 404) followPlaylist(userId, id, false);
        else throw error;
      }
    }
  } finally {
    syncing = false;
  }
}
export function useOfflinePlaylistSync(userId: string) {
  useEffect(() => {
    const controller = new AbortController();
    const sync = () => {
      if (document.visibilityState === 'visible')
        void syncOfflinePlaylists(userId, controller.signal).catch(() => {});
    };
    sync();
    window.addEventListener(event, sync);
    window.addEventListener('online', sync);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    const timer = setInterval(sync, 60000);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener(event, sync);
      window.removeEventListener('online', sync);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [userId]);
}
