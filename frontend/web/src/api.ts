export interface Track {
  id: string;
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
  track_number: number | null;
  disc_number: number | null;
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
    public code?: string,
    public traceId?: string,
  ) {
    super(traceId ? `${message}（诊断编号：${traceId}）` : message);
  }
}

const messages: Record<string, string> = {
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
  current_password_incorrect: '当前密码不正确。',
  username_taken: '这个用户名已被使用。',
  user_not_found: '账号不存在，请刷新列表。',
  user_version_conflict: '账号已变化，请重新读取后操作。',
  cannot_change_self_role: '不能停用或修改当前账号的角色。',
  use_self_password_change: '请到账号设置修改自己的密码。',
  lyrics_version_conflict: '歌词或文件已经变化，请重新读取后再保存。',
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
  admin_setup_required: '请先在服务端设置管理员密码。',
  authentication_required: '登录已过期，请重新登录。',
};

export const errorCodeMessage = (code: string) => messages[code] || code;

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
    throw new ApiError(response.status, messages[code] || '请求未完成，请重试。', code, traceId);
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
  source: string | null;
  source_url?: string;
  layers?: Record<string, { time_ms: number | null; text: string }[]>;
  lines: {
    time_ms: number | null;
    text: string;
    words?: { start_ms: number; end_ms: number; text: string }[];
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
  role: 'admin' | 'user';
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
