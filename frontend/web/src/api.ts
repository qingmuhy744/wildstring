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
    public retryAfter?: number,
  ) {
    super(traceId ? `${message}（诊断编号：${traceId}）` : message);
  }
}

export class NetworkError extends TypeError {
  constructor(message = '网络连接失败，请检查网络设置后重试。') {
    super(message);
    this.name = 'NetworkError';
  }
}

const messages: Record<string, string> = {
  folder_name_invalid: '请输入有效的文件夹名称，不含路径分隔符、控制字符或开头的点。',
  folder_already_exists: '已有同名文件或文件夹，请换一个名称。',
  folder_source_read_only: '音乐来源保持只读，请选择来源目录以外的位置新建文件夹。',
  folder_not_writable: '服务器没有在此目录创建文件夹的权限。',
  folder_create_failed: '无法创建文件夹，请检查服务器存储空间后重试。',
  folder_path_invalid: '请输入有效的服务器绝对目录路径。',
  folder_not_found: '目录不存在，请检查服务器上的路径。',
  folder_not_readable: '服务器没有读取这个目录的权限。',
  podcast_subscriptions_disabled: '管理员尚未开启普通用户添加 RSS，可先关注本服已有节目。',
  podcast_catalog_management_required: '只有管理员可以修改全服节目设置。',
  podcast_catalog_settings_conflict: '播客添加权限已被修改，请核对最新设置后重试。',
  invalid_avatar: '请选择有效的 JPG、PNG 或 WebP 图片，分辨率不超过 2500 万像素。',
  avatar_too_large: '头像图片超过 5 MiB，请压缩后重试。',
  avatar_account_changed: '账号已变化，请重新打开账号设置。',
  source_plugin_invalid_zip: '插件 ZIP 不符合格式，请检查包结构和 API 版本。',
  source_plugin_zip_too_large: '插件 ZIP 超过 16 MiB。',
  source_plugin_identity_conflict: '此 ZIP 的插件 ID 不同，请选择对应插件的升级包。',
  source_plugin_version_conflict: '插件配置已变化，请刷新后重新操作。',
  source_plugin_disable_first: '请先停用插件，再卸载。',
  source_plugin_disabled: '请先启用并保存此插件，再测试。',
  source_plugin_configuration_changed: '插件配置已变化，请刷新并保存后重新测试。',
  source_plugin_dependency_missing: '运行环境缺少插件依赖，请按插件说明配置。',
  source_plugin_invalid_config: '请检查插件必填配置。',
  source_plugins_disabled: '请先导入并启用提供歌词的数据源插件。',
  source_plugin_timeout: '插件查询超时，请检查服务地址或稍后重试。',
  source_plugin_auth_or_rejected: '上游拒绝请求，请检查插件服务和平台授权。',
  source_plugin_worker_failed: '插件运行失败，请检查插件与运行环境的兼容性。',
  playback_gain_version_conflict: '响度设置已在其他设备变化，请重新打开后保存。',
  loudness_tool_missing: '服务端缺少 FFmpeg，请更新官方镜像或安装后重试。',

  application_policy_version_conflict: '整理设置已在其他设备更新，请重新读取后保存。',
  draft_version_conflict: '草案已变化，请刷新并重新核对当前版本。',
  draft_not_approved: '请先核对并批准当前草案版本。',
  draft_not_found: '草案已不可用，请刷新列表。',
  draft_already_applied: '此草案已经应用，请读取最新结果。',
  notification_cursor_expired: '通知同步位置已过期，正在重新读取。',
  connection_not_found: '模型连接已被撤销，请选择其他连接。',
  connection_disabled: '模型连接已关闭，请到助手设置中启用。',
  connection_not_authorized: '当前连接未授权用于此操作，请检查共享和后台使用设置。',
  daily_budget_exceeded: '这条连接的每日调用预算已用完。',
  ai_budget_exhausted: '本次模型调用已达到预算，已保存完成的部分。',
  ai_endpoint_not_allowed: 'API 主机不在允许的端点列表中，请联系管理员。',
  telegram_target_unverified: '请先验证 Telegram 接收目标。',
  telegram_verification_invalid: '验证码不正确或已过期，请重新发送后核对。',
  verification_invalid: '验证码不正确或已过期，请重新发送后核对。',
  unknown_delivery_requires_acknowledgement: '请先核对 Telegram 中是否已收到消息，再确认重试。',
  scope_denied: '当前凭据没有此操作所需的权限。',
  conversation_busy: '这段对话正在生成回复，请完成后再操作。',
  search_provider_key_required: '请填写所选搜索服务的 API Key，再启用联网。',
  search_settings_version_conflict: '搜索设置已在其他设备更新，请刷新后保存。',
  search_settings_changed: '搜索配置已变化，本次检索已停止。',
  search_daily_budget_exhausted: '今日搜索与读取请求已达到上限。',
  search_run_budget_exhausted: '本轮搜索已达到上限，请根据已有来源回答。',
  native_search_requires_deepseek_pro: 'DeepSeek 原生联网需要支持该功能的 Pro 模型。',
  native_search_not_supported: '当前协议和供应商组合未配置原生搜索，请使用独立搜索服务。',
  reasoning_effort_not_supported: '此模型档案不支持所选推理强度，请选择模型默认或支持的强度。',
  ai_output_incomplete: '模型输出未完成，请适当提高输出 Token 上限或缩小问题范围。',
  ai_output_limit:
    '模型达到输出 Token 上限，分析未完成。请在 AI 连接中提高上限或降低推理强度；旧连接请新建可配置连接。调整后再恢复，恢复可能产生费用。',
  ai_content_filtered: '模型服务过滤了本次输出。请调整问题范围后再恢复，恢复可能产生费用。',
  ai_response_failed: '模型服务未能完成本次响应，请检查服务状态后再恢复，恢复可能产生费用。',
  memory_limit_reached: '长期记忆已达 50 条，请先整理或删除旧条目。',
  memory_version_conflict: '这条记忆已变化，请刷新后再修改。',

  album_not_found: '所属专辑已变化或不可用，请刷新曲库后重试。',
  playback_version_conflict: '共享进度已在其他设备更新，请先读取最新进度，再决定是否共享。',
  playback_track_unavailable: '共享队列中有歌曲已经不可用，请回原设备刷新后重新共享。',
  playback_position_invalid: '共享播放位置已失效，请重新共享进度。',
  recommendation_version_conflict: '推荐偏好已变化，请重新读取后保存。',
  recommendation_event_conflict: '这次偏好操作已变化，请重新读取推荐。',
  recommendation_generation_in_progress: '推荐正在准备，请稍后重新读取。',
  preferences_version_conflict: '推荐偏好已变化，请重新读取后再保存。',
  providers_disabled: '请先在管理设置中启用联网资料。',
  provider_task_not_found: '这条任务已经不可用，请刷新任务列表。',
  provider_task_not_retryable: '任务状态已经变化，请刷新后重试。',
  invalid_proxy_settings: '请检查代理方式和地址；手动代理需使用 http://地址:端口。',
  proxy_not_configured: '请填写手动代理地址，或选择直接连接。',
  proxy_protocol_unsupported: '代理协议不受支持，请使用 http:// 开头的代理地址。',
  network_test_running: '服务端已有一组网络检测正在运行，请稍后重试。',
  acoustid_not_configured: '请先保存 AcoustID 应用 API Key。',
  acoustid_requires_musicbrainz: 'AcoustID 识别需要同时启用 MusicBrainz。',
  invalid_acoustid_credentials: '请检查 AcoustID 应用 API Key。',
  fingerprint_tool_missing: '服务端缺少 Chromaprint 指纹工具，请更新镜像或安装后重试。',
  ai_settings_version_conflict: 'AI 配置已变化，请重新读取后修改。',
  invalid_ai_settings: '请检查 API 地址、模型名称、密钥和超时设置。',
  ai_not_configured: '请先保存 API 地址和模型。',
  ai_connection_failed: '模型连接失败，请检查地址、密钥、模型名称或服务端网络。',
  ai_invalid_response: '服务未返回兼容的模型响应，请检查 API 地址。',
  ai_settings_unavailable: 'AI 配置无法读取，请检查服务端配置文件。',
  ffmpeg_unavailable: '服务端未安装 FFmpeg，请切换原音或联系管理员。',
  transcoding_busy: '转码任务繁忙，请稍后重试或选择原音。',
  transcoding_failed: 'AAC 转码未完成，请重试或选择原音。',
  playback_position_out_of_range: '播放位置超出歌曲时长，请从头播放。',
  admin_required: '此操作需要管理员权限。',
  host_not_allowed: '当前访问域名不在白名单中，需要在服务端数据库中关闭白名单或修正配置。',
  invalid_account_input: '请检查账号格式及密码长度（12–128 个字符）。',
  library_selection_required: '请先选择一个音乐库，再执行管理操作。',
  library_access_required: '当前账号未获授权访问此音乐库。',
  library_not_found: '音乐库不存在或当前账号无权访问。',
  library_source_invalid: '源文件夹必须是服务端现有的绝对目录。',
  library_storage_unavailable: '托管目录暂时无法创建，请检查服务端存储。',
  library_sources_overlap: '源文件夹存在重复、父子重叠，或与托管目录重叠。',
  library_migration_required: '已有库请通过目录迁移切换托管目录。',
  library_migration_busy: '这个库正在迁移目录，完成后可继续管理。',
  library_migration_not_retryable: '库的目录已变化，请重新读取后提交新的迁移。',
  library_target_not_empty: '目标目录需要为空，已有内容不会覆盖。',
  library_target_not_writable: '目标目录不可写，请检查服务端挂载和权限。',
  library_target_invalid: '目标目录必须是独立的服务端绝对路径，不能与来源、其他库或运行数据交叉。',
  podcast_resource_version_conflict: '资源设置已变化，请重新读取后再操作。',
  library_version_conflict: '音乐库配置已变化，请重新读取后再保存。',
  library_access_version_conflict: '库权限已被修改，已重新读取，请核对后再保存。',
  default_library_required: '默认音乐库需要保留。',
  current_password_incorrect: '当前密码不正确。',
  username_taken: '这个用户名已被使用。',
  user_not_found: '账号不存在，请刷新列表。',
  user_version_conflict: '账号已变化，请重新读取后操作。',
  cannot_change_self_profile: '不能停用或修改当前账号的档案。',
  use_self_password_change: '请到账号设置修改自己的密码。',
  lyrics_version_conflict: '歌词或文件已经变化，请重新读取后再保存。',
  draft_preview_required: '请使用新版客户端查看完整图片或逐曲差异后，再批准此草案。',
  album_membership_changed: '专辑的曲目范围已变化，请重新读取并生成整批草案。',
  cover_candidate_changed: '封面候选已变化，请重新生成草案。',
  cover_snapshot_unavailable: '封面快照不可用，请重新生成草案后核对。',
  empty_metadata_changes: '批量草案中每首歌曲都需要明确的修改字段。',
  metadata_version_conflict: '这首歌的信息已变化，请重新读取后再编辑。',
  settings_version_conflict: '设置已被更新，请刷新后重试。',
  library_task_busy: '曲库已有任务在排队或执行，请等待完成。',
  playlist_version_conflict: '歌单已在其他页面修改，请刷新后重试。',
  playlist_order_conflict: '歌单内容已变化，请刷新后重新排序。',
  favorites_playlist_readonly: '我喜欢歌单由收藏自动管理。',
  smart_playlist_tracks_readonly: '规则歌单的曲目由规则自动管理。',
  playlist_track_limit: '每个普通歌单最多保存 5000 首歌曲。',
  invalid_credentials: '账号或密码不正确。',
  login_throttled: '尝试次数较多，请稍后一分钟再试。',
  account_session_changed: '账号已在其他页面变化，请重新登录。',
  podcast_follow_required: '请先关注此节目，再开启自动下载。',
  podcast_download_settings_conflict: '设置已被其他设备修改，请重新读取后再试。',
  podcast_not_found: '节目不存在或当前账号无权访问。',
  podcast_publisher_not_found: '出品方不存在或没有你可访问的节目。',
  invalid_podcast_feed_url: '播客 RSS 源地址无效或不可访问。',
  podcast_feed_too_large: '播客 RSS 源文件过大。',
  invalid_podcast_audio_url: '播客音频地址无效或不可访问。',
  podcast_audio_too_large: '播客音频文件过大。',
  invalid_podcast_network_policy: '播客网络策略设置无效。',
  podcast_playback_settings_conflict: '播客播放设置已被修改，请刷新后重试。',
  track_not_found: '曲目不存在或已被移除。',
  scan_not_found: '扫描任务不存在。',
  owner_setup_required: '请先在服务端设置所有者密码。',
  authentication_required: '登录已过期，请重新登录。',
  podcast_search_query_invalid: '请输入 1 到 100 个字符的节目名称。',
  podcast_search_query_is_url: '这是一个 RSS 地址，请直接预览或添加。',
  podcast_search_region_invalid: '播客搜索区域设置无效，请联系管理员。',
  podcast_search_rate_limited: '搜索太频繁了，请稍后再试。',
  podcast_search_upstream_rate_limited: 'Apple 播客目录暂时限制了搜索，请稍后再试。',
  podcast_search_upstream_failed: '播客目录暂时无法访问，请稍后重试，或直接粘贴 RSS 地址。',
  podcast_search_timeout: '播客目录响应超时，请稍后重试。',
  podcast_feed_fetch_failed: '无法获取这个 RSS 源，请检查地址或稍后重试。',
  podcast_feed_parse_failed: '这个地址返回的内容无法解析为播客 RSS。',
  podcast_feed_invalid: '这个地址不是有效的播客 RSS 源。',
};

const isCodeLike = (str: string) => /^[a-z0-9_-]+$/i.test(str);

export const errorCodeMessage = (code: string) =>
  messages[code] || (code && !isCodeLike(code) ? code : '操作未完成，请重试。');

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
      throw new NetworkError('网络请求超时，请检查网络连接后重试。');
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
      throw new NetworkError('网络连接失败，请检查网络设置后重试。');
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
    const message = messages[code] || friendlyRaw || '请求未完成，请重试。';
    const retryHeader = Number(response.headers.get('Retry-After'));
    const retryBody = Number(body.detail?.retry_after);
    const retryAfter =
      Number.isFinite(retryHeader) && retryHeader > 0
        ? Math.ceil(retryHeader)
        : Number.isFinite(retryBody) && retryBody > 0
          ? Math.ceil(retryBody)
          : undefined;
    throw new ApiError(response.status, message, code, traceId, retryAfter);
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
