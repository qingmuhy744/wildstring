import { api, type Track, type TrackPage } from './api';

export type PlaybackMode = 'sequential' | 'repeat_all' | 'repeat_one' | 'shuffle';
export const modeNames: Record<PlaybackMode, string> = {
  sequential: '顺序播放',
  repeat_all: '列表循环',
  repeat_one: '单曲循环',
  shuffle: '随机播放',
};
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];
export function normalizePlaybackRate(value: unknown): PlaybackRate {
  const rate = Number(value);
  return PLAYBACK_RATES.includes(rate as PlaybackRate) ? (rate as PlaybackRate) : 1;
}
export const QUEUE_LIMIT = 5000;
export interface SavedPlayback {
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
      value.tracks.length > QUEUE_LIMIT ||
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
    return {
      ...value,
      tracks: value.tracks.map((track: Partial<Track>) => ({
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
// Fetch every page before replacing the audible queue. Changing collections cannot truncate a queue.
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
    if (!Number.isInteger(page.total) || page.total > QUEUE_LIMIT)
      throw new Error(`整集合播放和保存最多 ${QUEUE_LIMIT} 首，请缩小搜索范围或建立歌单。`);
    if (total !== -1 && total !== page.total)
      throw new Error('曲库内容已变化，请重新播放整个集合。');
    total = page.total;
    if (!page.items.length && cursor < total) throw new Error('集合未读取完整，请重试。');
    for (const track of page.items) {
      if (seen.has(track.id)) throw new Error('集合排序已变化，请重新读取。');
      seen.add(track.id);
      items.push(track);
    }
    cursor += page.items.length;
    if (cursor >= total) return items;
  }
}
