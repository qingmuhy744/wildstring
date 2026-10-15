export interface Track {
  id: string;
  title: string;
  artists: string[];
  album: string | null;
  duration_ms: number;
  format: 'mp3' | 'flac' | 'm4a';
  sample_rate: number | null;
  status: 'available' | 'missing' | 'unreadable';
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
