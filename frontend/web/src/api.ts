import i18n from './i18n';
import type { LanguagePreference } from './i18n';
import { observeLibraryAccess, selectedLibrary, libraryUser } from './library-context';

export interface Track {
  id: string;
  library_id?: string;
  podcast_id?: string;
  podcast_queue_origin?: 'auto';
  podcast_list_order?: 'asc' | 'desc';
  podcast_position_seconds?: number;
  podcast_completed?: boolean;
  album_id: string;
  title: string;
  artists: string[];
  album_artists: string[];
  artist_credit: string;
  album_artist_credit: string;
  composers: string[];
  lyricists: string[];
  arrangers: string[];
  vocalists: string[];
  genres: string[];
  tags: string[];
  track_total: number | null;
  disc_total: number | null;
  release_date: string | null;
  original_date: string | null;
  external_ids: Record<string, string | string[]>;
  description: string;
  cover_url?: string;
  track_number: number | null;
  disc_number: number | null;
  album: string | null;
  duration_ms: number;
  format: 'mp3' | 'flac' | 'm4a';
  has_cover?: boolean;
  sample_rate: number | null;
  status: 'available' | 'missing' | 'unreadable';
  loved: boolean;
  play_count: number;
  listened_ms: number;
  last_played_at: string | null;
  added_at: string;
}

export interface DiscSummary {
  number: number;
  track_count: number;
  duration_ms: number;
  offset: number;
}

export interface TrackPage {
  discs?: DiscSummary[];
  items: Track[];
  total: number;
  limit: number;
  offset: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public traceId?: string,
  ) {
    super(traceId ? i18n.t('api.withDiagnostic', { message, id: traceId }) : message);
  }
}

export class NetworkError extends TypeError {
  constructor(message = i18n.t('api.networkFailed')) {
    super(message);
    this.name = 'NetworkError';
  }
}

// Error-code messages live in locales/*.json under `errors`.
const codeMessage = (code: string | undefined): string =>
  code && /^[a-z0-9_]+$/.test(code) && i18n.exists(`errors.${code}`)
    ? i18n.t(`errors.${code}`)
    : '';

const isCodeLike = (str: string) => /^[a-z0-9_-]+$/i.test(str);

export const errorCodeMessage = (code: string) =>
  codeMessage(code) || (code && !isCodeLike(code) ? code : i18n.t('api.actionFailed'));

export interface ApiOptions extends RequestInit {
  timeoutMs?: number;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const expectedOwner = libraryUser();
  const timeoutMs = options.timeoutMs ?? 20000;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }
  const userSignal = options.signal;
  let userAbortHandler: (() => void) | null = null;
  if (userSignal) {
    if (userSignal.aborted) {
      controller.abort(userSignal.reason);
    } else {
      userAbortHandler = () => controller.abort(userSignal.reason);
      userSignal.addEventListener('abort', userAbortHandler, { once: true });
    }
  }

  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...options,
      signal: controller.signal,
      credentials: 'same-origin',
      headers: {
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        'X-Wildstring-Client': 'web',
        ...(expectedOwner && !path.startsWith('/auth/')
          ? { 'X-Wildstring-Account': expectedOwner }
          : {}),
        'X-Wildstring-Library': selectedLibrary(),
        ...options.headers,
      },
    });
  } catch (err: any) {
    if (timedOut) {
      throw new NetworkError(i18n.t('api.networkTimeout'));
    }
    if (userSignal?.aborted) {
      throw err;
    }
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    if (
      err instanceof TypeError ||
      (typeof navigator !== 'undefined' && !navigator.onLine) ||
      (typeof err?.message === 'string' &&
        (err.message.includes('fetch') || err.message.includes('NetworkError')))
    ) {
      throw new NetworkError(i18n.t('api.networkFailed'));
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (userSignal && userAbortHandler) {
      userSignal.removeEventListener('abort', userAbortHandler);
    }
  }

  if (expectedOwner !== libraryUser()) throw new DOMException('Account changed', 'AbortError');
  observeLibraryAccess(response.headers.get('X-Wildstring-Library-Access'), expectedOwner);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (expectedOwner !== libraryUser()) throw new DOMException('Account changed', 'AbortError');
    if (response.status === 401 && path !== '/auth/login') {
      window.dispatchEvent(new Event('wildstring:unauthorized'));
    }
    const code = typeof body.detail === 'string' ? body.detail : body.detail?.code || body.code;
    const suppliedTrace =
      body.trace_id ||
      body.diagnostic_id ||
      response.headers.get('X-Wildstring-Trace-Id') ||
      response.headers.get('X-Trace-Id');
    const traceId =
      typeof suppliedTrace === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(suppliedTrace)
        ? suppliedTrace
        : undefined;
    const rawMessage =
      typeof body.detail === 'string'
        ? body.detail
        : typeof body.message === 'string'
          ? body.message
          : '';
    const friendlyRaw = rawMessage && !isCodeLike(rawMessage) ? rawMessage : '';
    const message = codeMessage(code) || friendlyRaw || i18n.t('api.requestFailed');
    throw new ApiError(response.status, message, code, traceId);
  }
  const value = response.status === 204 ? (undefined as T) : await response.json();
  if (expectedOwner !== libraryUser()) throw new DOMException('Account changed', 'AbortError');
  return value;
}

export const artist = (track: Track) => track.artists.join(' / ') || '未知艺人';
export const streamUrl = (track: Track) => {
  if (track.id.startsWith('podcast_ep_')) {
    const connection = (navigator as Navigator & { connection?: { type?: string } }).connection;
    const network =
      connection?.type === 'wifi'
        ? 'wifi'
        : connection?.type === 'cellular'
          ? 'cellular'
          : 'unknown';
    return `/api/v1/podcasts/episodes/${encodeURIComponent(track.id.replace('podcast_ep_', ''))}/stream?proxy=1&cache=1&network=${network}`;
  }
  return `/api/v1/tracks/${encodeURIComponent(track.id)}/stream`;
};
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

export interface AlbumMetadataTrack {
  track_id: string;
  title: string;
  album: string;
  album_artists: string[];
  artists: string[];
  track_number: number | null;
  disc_number: number | null;
  metadata_version: number;
  metadata: Record<string, unknown>;
  has_cover: boolean;
  custom_cover?: string | null;
}

export interface AlbumMetadataRecord {
  album_id: string;
  primary_title: string;
  primary_artists: string[];
  cover_track_id: string;
  has_custom_cover: boolean;
  release_date: string;
  original_date: string;
  label: string;
  catalog_number: string;
  disc_total: number;
  discs: number[];
  genres: string[];
  description: string;
  tracks: AlbumMetadataTrack[];
  album_variants: string[];
  album_artist_variants: string[];
  warning: boolean;
}
export interface AlbumPage {
  items: Album[];
  total: number;
  limit: number;
  offset: number;
}
export interface Lyrics {
  kind: 'none' | 'plain' | 'synced';
  source: string | null;
  source_url?: string;
  layers?: Record<string, { time_ms: number | null; text: string }[]>;
  lines: {
    time_ms: number | null;
    text: string;
    words?: { start_ms: number; end_ms: number; text: string }[];
    translation?: string;
    romanization?: string;
  }[];
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

export interface User {
  id: string;
  username: string;
  display_name?: string;
  language?: LanguagePreference;
  email?: string;
  profile: 'owner' | 'librarian' | 'editor' | 'listener';
  enabled: boolean;
  version: number;
}

export interface PlaybackPlan {
  mode: 'original' | 'transcode';
  reason: string;
  duration_ms: number;
  start_ms: number;
  stream_url: string;
  cache_state: 'none' | 'miss' | 'encoding' | 'hit';
  source: { codec: string; lossless: boolean; bitrate_kbps: number | null };
  output: { codec: string; bitrate_kbps: number | null };
}

// getRandomValues also works on LAN HTTP; randomUUID is secure-context-only.
export function eventId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
