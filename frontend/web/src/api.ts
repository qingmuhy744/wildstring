export interface Track {
  id: string;
  album_id: string;
  title: string;
  artists: string[];
  album: string | null;
  duration_ms: number;
  format: 'mp3' | 'flac' | 'm4a';
  sample_rate: number | null;
  status: 'available' | 'missing' | 'unreadable';
  loved: boolean;
  play_count: number;
  listened_ms: number;
  last_played_at: string | null;
  added_at: string;
}

export interface TrackPage {
  items: Track[];
  total: number;
  limit: number;
  offset: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const messages: Record<string, string> = {
  playlist_version_conflict: '歌单已在其他页面修改，请刷新后重试。',
  playlist_order_conflict: '歌单内容已变化，请刷新后重新排序。',
  favorites_playlist_readonly: '我喜欢歌单由收藏自动管理。',
  smart_playlist_tracks_readonly: '规则歌单的曲目由规则自动管理。',
  playlist_track_limit: '每个普通歌单最多保存 5000 首歌曲。',
  invalid_credentials: '账号或密码不正确。',
  login_throttled: '尝试次数较多，请稍后一分钟再试。',
  admin_setup_required: '请先在服务端设置管理员密码。',
  authentication_required: '登录已过期，请重新登录。',
};

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Wildstring-Client': 'web',
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 && path !== '/auth/login') {
      window.dispatchEvent(new Event('wildstring:unauthorized'));
    }
    throw new ApiError(response.status, messages[body.detail] || '请求未完成，请重试。');
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export const artist = (track: Track) => track.artists.join(' / ') || '未知艺人';
export const streamUrl = (track: Track) => `/api/v1/tracks/${encodeURIComponent(track.id)}/stream`;
export const time = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}`;
};

export interface Album {
  id: string;
  title: string;
  artists: string[];
  track_count: number;
  duration_ms: number;
  cover_track_id: string;
}
export interface AlbumPage {
  items: Album[];
  total: number;
  limit: number;
  offset: number;
}
export interface Lyrics {
  kind: 'none' | 'plain' | 'synced';
  source: 'sidecar_lrc' | 'embedded' | 'sidecar_text' | null;
  lines: { time_ms: number | null; text: string }[];
}

export interface Artist {
  id: string;
  name: string;
  track_count: number;
  album_count: number;
  duration_ms: number;
  cover_track_id: string;
}
export interface ArtistPage {
  items: Artist[];
  total: number;
  limit: number;
  offset: number;
}
export interface SmartDefinition {
  all?: Record<string, unknown>[];
  any?: Record<string, unknown>[];
  sort: string;
  order: 'asc' | 'desc';
  limit: number;
}
export interface Playlist {
  id: string;
  name: string;
  kind: 'manual' | 'smart' | 'favorites';
  definition: SmartDefinition | null;
  version: number;
  track_count: number;
  duration_ms: number;
  cover_track_id: string | null;
}
export interface PlaylistPage {
  items: Playlist[];
  total: number;
  limit: number;
  offset: number;
}
export interface ListeningSummary {
  play_count: number;
  listened_ms: number;
  tracks_played: number;
  favorites: number;
  last_played_at: string | null;
}
export const listeningTime = (milliseconds: number) => {
  if (milliseconds < 60000) return `${Math.floor(milliseconds / 1000)} 秒`;
  const minutes = Math.floor(milliseconds / 60000);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
    : `${minutes} 分钟`;
};
