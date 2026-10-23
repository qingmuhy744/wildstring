import React, { useEffect, useState, useRef, useMemo } from 'react';
import { api, type Track } from './api';
import { Icon } from './icons';
import { rememberPodcastCover } from './cover';

export interface PodcastSummary {
  id: string;
  title: string;
  author: string;
  description: string;
  feed_url: string;
  cover_url: string;
  auto_update: boolean;
  update_interval_minutes: number;
  download_policy: string;
  retention_policy: string;
  last_updated_at: string | null;
  created_at: string;
  total_episodes: number;
  unplayed_episodes: number;
  downloaded_episodes: number;
  storage_path: string;
}

export interface PodcastEpisode {
  id: string;
  podcast_id: string;
  guid: string;
  title: string;
  description: string;
  audio_url: string;
  duration_seconds: number;
  pub_date: string;
  episode_number: number | null;
  season_number: number | null;
  created_at: string;
  position_seconds: number;
  completed: boolean;
  local_path?: string | null;
  download_status?: 'none' | 'downloading' | 'downloaded' | 'failed';
}

export interface PodcastStorageInfo {
  podcast_id: string;
  podcast_title: string;
  storage_path: string;
  relative_path: string;
  total_episodes: number;
  downloaded_episodes: number;
  disk_usage_bytes: number;
  disk_usage_human: string;
}

export interface PodcastDetail {
  podcast: PodcastSummary;
  episodes: PodcastEpisode[];
}

export interface DownloadTaskItem {
  episode_id: string;
  podcast_id: string;
  episode_title: string;
  podcast_title: string;
  cover_url?: string;
  pub_date?: string;
  episode_number?: number | null;
  duration_seconds?: number;
  status: 'queued' | 'downloading' | 'downloaded' | 'failed';
  started_at?: string;
  completed_at?: string;
  failed_at?: string;
  error?: string;
  downloaded_bytes?: number;
  total_bytes?: number;
  progress_pct?: number | null;
  speed_bps?: number;
  speed_human?: string;
  downloaded_human?: string;
  total_human?: string;
}

export interface DownloadQueueInfo {
  active_count: number;
  queued_count: number;
  failed_count: number;
  total_pending: number;
  downloading: DownloadTaskItem[];
  queued: DownloadTaskItem[];
  recent_completed: DownloadTaskItem[];
  failed: DownloadTaskItem[];
}

const PRESET_PODCASTS = [
  { name: '声东击西', url: 'https://etw.fm/rss' },
  { name: '疯投圈', url: 'https://crazy.capital/feed' },
  { name: 'NPR News Now', url: 'https://feeds.npr.org/500005/podcast.xml' },
];

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function safeParseDate(str?: string | null): number {
  if (!str) return 0;
  const t = Date.parse(str);
  if (!isNaN(t)) return t;
  const m = str.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    return d.getTime() || 0;
  }
  return 0;
}

function cleanHtmlDescription(text: string): string {
  if (!text) return '';
  return text
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

interface PodcastsProps {
  onPlayTrack: (track: Track) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  podcast: PodcastSummary;
}

export const PodcastsPage: React.FC<PodcastsProps> = ({ onPlayTrack }) => {
  const [podcasts, setPodcasts] = useState<PodcastSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPodcast, setSelectedPodcast] = useState<PodcastSummary | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<PodcastDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showSubscribeModal, setShowSubscribeModal] = useState(false);
  const [modalFeedUrl, setModalFeedUrl] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Download queue state
  const [showQueueModal, setShowQueueModal] = useState(false);
  const [queueInfo, setQueueInfo] = useState<DownloadQueueInfo | null>(null);
  const [retryingFailed, setRetryingFailed] = useState(false);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Settings modal state
  const [settingsPodcast, setSettingsPodcast] = useState<PodcastSummary | null>(null);
  const [storageInfo, setStorageInfo] = useState<PodcastStorageInfo | null>(null);
  const [downloadPolicy, setDownloadPolicy] = useState('latest_5');
  const [retentionPolicy, setRetentionPolicy] = useState('keep_all');
  const [savingSettings, setSavingSettings] = useState(false);
  const [cleaningDownloads, setCleaningDownloads] = useState(false);

  // Episodes sort & filter state
  const [sortField, setSortField] = useState<'pub_date' | 'episode_number' | 'duration' | 'title'>(
    'pub_date',
  );
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [filterUnplayed, setFilterUnplayed] = useState(false);
  const [filterDownloaded, setFilterDownloaded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const menuRef = useRef<HTMLDivElement | null>(null);

  const displayedEpisodes = useMemo(() => {
    if (!selectedDetail?.episodes) return [];
    let list = [...selectedDetail.episodes];

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(
        (ep) =>
          ep.title.toLowerCase().includes(q) ||
          (ep.description && ep.description.toLowerCase().includes(q)),
      );
    }

    if (filterUnplayed) {
      list = list.filter((ep) => !ep.completed);
    }

    if (filterDownloaded) {
      list = list.filter((ep) => ep.download_status === 'downloaded');
    }

    const parseEpisodeNum = (ep: PodcastEpisode): number => {
      if (ep.episode_number !== null && ep.episode_number !== undefined) {
        return ep.episode_number;
      }
      const m = ep.title.match(/#(\s*\d+)|第\s*(\d+)\s*期/);
      if (m) {
        const raw = (m[1] || m[2]).trim();
        return parseInt(raw, 10) || 0;
      }
      return 0;
    };

    list.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'pub_date') {
        const tA = safeParseDate(a.pub_date);
        const tB = safeParseDate(b.pub_date);
        if (tA !== tB) {
          cmp = tA - tB;
        } else {
          cmp = parseEpisodeNum(a) - parseEpisodeNum(b);
        }
      } else if (sortField === 'episode_number') {
        cmp = parseEpisodeNum(a) - parseEpisodeNum(b);
      } else if (sortField === 'duration') {
        cmp = (a.duration_seconds || 0) - (b.duration_seconds || 0);
      } else if (sortField === 'title') {
        cmp = a.title.localeCompare(b.title, 'zh-CN');
      }
      return sortOrder === 'desc' ? -cmp : cmp;
    });

    return list;
  }, [
    selectedDetail?.episodes,
    sortField,
    sortOrder,
    filterUnplayed,
    filterDownloaded,
    searchQuery,
  ]);

  const showNotice = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 3000);
  };

  const loadPodcasts = async () => {
    try {
      setLoading(true);
      const res = await api<PodcastSummary[]>('/podcasts');
      setPodcasts(res);
    } catch (e) {
      showNotice(e instanceof Error ? e.message : '获取播客订阅失败');
    } finally {
      setLoading(false);
    }
  };

  const openDetail = async (p: PodcastSummary) => {
    setSelectedPodcast(p);
    try {
      setDetailLoading(true);
      const detail = await api<PodcastDetail>(`/podcasts/${encodeURIComponent(p.id)}`);
      setSelectedDetail(detail);
    } catch (e) {
      showNotice(e instanceof Error ? e.message : '加载单集失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const handleRefreshPodcast = async (id: string) => {
    try {
      setDetailLoading(true);
      const detail = await api<PodcastDetail>(`/podcasts/${encodeURIComponent(id)}/refresh`, {
        method: 'POST',
      });
      setSelectedDetail(detail);
      showNotice('已从源端完成单集巡检更新并根据规则触发自动下载');
    } catch (e) {
      showNotice(e instanceof Error ? e.message : '刷新失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const handleRefreshAll = async () => {
    try {
      setRefreshingAll(true);
      const res = await api<{ refreshed_count: number }>('/podcasts/refresh-all', {
        method: 'POST',
      });
      showNotice(`已完成全部更新，更新了 ${res.refreshed_count} 个频道`);
      await loadPodcasts();
    } catch (e) {
      showNotice(e instanceof Error ? e.message : '全部更新失败');
    } finally {
      setRefreshingAll(false);
    }
  };

  const handleDelete = async (p: PodcastSummary, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setContextMenu(null);
    if (!confirm(`确定取消订阅播客《${p.title}》吗？`)) return;
    try {
      await api(`/podcasts/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      showNotice(`已取消订阅: ${p.title}`);
      if (selectedPodcast?.id === p.id) {
        setSelectedPodcast(null);
        setSelectedDetail(null);
      }
      await loadPodcasts();
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '取消订阅失败');
    }
  };

  const handleOpenSettings = async (p: PodcastSummary, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setContextMenu(null);
    setSettingsPodcast(p);
    setDownloadPolicy(p.download_policy || 'latest_5');
    setRetentionPolicy(p.retention_policy || 'keep_all');
    try {
      const info = await api<PodcastStorageInfo>(`/podcasts/${encodeURIComponent(p.id)}/storage`);
      setStorageInfo(info);
    } catch {
      // 容错忽略
    }
  };

  const handleCopyPath = (path: string) => {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(path).then(
        () => showNotice('已复制挂载路径到剪贴板'),
        () => showNotice('复制失败，请手动选择路径'),
      );
    } else {
      showNotice('当前环境不支持直接复制，请手动选择');
    }
  };

  const handleSaveSettings = async () => {
    if (!settingsPodcast) return;
    try {
      setSavingSettings(true);
      const updated = await api<PodcastSummary>(
        `/podcasts/${encodeURIComponent(settingsPodcast.id)}/settings`,
        {
          method: 'PUT',
          body: JSON.stringify({
            download_policy: downloadPolicy,
            retention_policy: retentionPolicy,
          }),
        },
      );
      showNotice(`已更新《${updated.title}》的自动下载与存储策略`);
      setSettingsPodcast(null);
      await loadPodcasts();
      if (selectedPodcast?.id === updated.id) {
        setSelectedPodcast(updated);
      }
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '保存设置失败');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleCleanDownloads = async () => {
    if (!settingsPodcast) return;
    if (
      !confirm(
        `确定清理《${settingsPodcast.title}》的所有已下载本地音频吗？元数据和播放记录仍会保留。`,
      )
    )
      return;
    try {
      setCleaningDownloads(true);
      const res = await api<{ removed_files: number; freed_bytes: number }>(
        `/podcasts/${encodeURIComponent(settingsPodcast.id)}/clean-downloads`,
        { method: 'POST' },
      );
      showNotice(
        `已清理 ${res.removed_files} 个音频文件，释放空间 ${(res.freed_bytes / 1024 / 1024).toFixed(1)} MB`,
      );
      const info = await api<PodcastStorageInfo>(
        `/podcasts/${encodeURIComponent(settingsPodcast.id)}/storage`,
      );
      setStorageInfo(info);
      await loadPodcasts();
      if (selectedPodcast?.id === settingsPodcast.id) {
        await openDetail(settingsPodcast);
      }
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '清理音频失败');
    } finally {
      setCleaningDownloads(false);
    }
  };

  const fetchQueue = async () => {
    try {
      const q = await api<DownloadQueueInfo>('/podcasts/downloads/queue');
      setQueueInfo(q);
    } catch {
      // 忽略
    }
  };

  const handleRetryFailed = async () => {
    try {
      setRetryingFailed(true);
      const res = await api<{ retried_count: number }>('/podcasts/downloads/retry-failed', {
        method: 'POST',
      });
      showNotice(`已将 ${res.retried_count} 个失败任务重新加入下载队列`);
      await fetchQueue();
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '重试任务失败');
    } finally {
      setRetryingFailed(false);
    }
  };

  const handleClearCompleted = async () => {
    try {
      await api('/podcasts/downloads/clear-completed', { method: 'POST' });
      await fetchQueue();
    } catch {
      // 忽略
    }
  };

  useEffect(() => {
    void fetchQueue();
    const intervalTime = showQueueModal
      ? 2000
      : queueInfo && queueInfo.total_pending > 0
        ? 5000
        : 12000;
    const timer = setInterval(() => {
      void fetchQueue();
    }, intervalTime);
    return () => clearInterval(timer);
  }, [showQueueModal, queueInfo?.total_pending]);

  const handleDownloadAll = async (p: PodcastSummary) => {
    setContextMenu(null);
    try {
      showNotice(`正在将《${p.title}》的所有单集加入后台下载队列…`);
      const res = await api<{ queued_episodes: number; message: string }>(
        `/podcasts/${encodeURIComponent(p.id)}/download-all`,
        { method: 'POST' },
      );
      showNotice(res.message);
      void fetchQueue();
      if (selectedPodcast?.id === p.id) {
        await openDetail(p);
      }
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '触发全量下载失败');
    }
  };

  const handleDownloadSingleEpisode = async (ep: PodcastEpisode, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      showNotice(`正在将单集《${ep.title}》加入下载队列…`);
      await api(`/podcasts/episodes/${encodeURIComponent(ep.id)}/download`, { method: 'POST' });
      void fetchQueue();
      // 乐观更新单集状态为 downloading
      if (selectedDetail) {
        setSelectedDetail({
          ...selectedDetail,
          episodes: selectedDetail.episodes.map((item) =>
            item.id === ep.id ? { ...item, download_status: 'downloading' } : item,
          ),
        });
      }
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '下载单集失败');
    }
  };

  const handleContextMenu = (e: React.MouseEvent, p: PodcastSummary) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: Math.min(e.clientX, window.innerWidth - 220),
      y: Math.min(e.clientY, window.innerHeight - 260),
      podcast: p,
    });
  };

  useEffect(() => {
    const handleGlobalClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
        setShowSubscribeModal(false);
        setSettingsPodcast(null);
      }
    };
    window.addEventListener('click', handleGlobalClick);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('click', handleGlobalClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const handleSubscribe = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalFeedUrl.trim()) return;
    try {
      setSubscribing(true);
      setModalError(null);
      const detail = await api<PodcastDetail>('/podcasts', {
        method: 'POST',
        body: JSON.stringify({ feed_url: modalFeedUrl.trim() }),
      });
      showNotice(`成功订阅《${detail.podcast.title}》`);
      setShowSubscribeModal(false);
      setModalFeedUrl('');
      setModalError(null);
      await loadPodcasts();
      await openDetail(detail.podcast);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '订阅失败，请检查 RSS 地址';
      setModalError(msg);
      showNotice(msg);
    } finally {
      setSubscribing(false);
    }
  };

  const playEpisode = (ep: PodcastEpisode, podcast: PodcastSummary) => {
    const trackId = `podcast_ep_${ep.id}`;
    if (podcast.cover_url) {
      rememberPodcastCover(trackId, podcast.cover_url);
    }
    const track: Track = {
      id: trackId,
      album_id: '',
      title: ep.title,
      artists: [podcast.author || podcast.title],
      album_artists: [podcast.author || podcast.title],
      artist_credit: podcast.author || podcast.title,
      album_artist_credit: podcast.author || podcast.title,
      composers: [],
      lyricists: [],
      arrangers: [],
      vocalists: [],
      genres: ['Podcast'],
      tags: [],
      track_total: null,
      disc_total: null,
      release_date: ep.pub_date || null,
      original_date: null,
      external_ids: {},
      description: ep.description || '',
      track_number: ep.episode_number,
      disc_number: ep.season_number,
      album: podcast.title,
      duration_ms: ep.duration_seconds * 1000,
      has_cover: !!podcast.cover_url,
      sample_rate: 44100,
      format: 'mp3',
      status: 'available',
      loved: false,
      play_count: 0,
      listened_ms: 0,
      last_played_at: null,
      added_at: ep.created_at || new Date().toISOString(),
    };
    onPlayTrack(track);

    void api(`/podcasts/episodes/${encodeURIComponent(ep.id)}/progress`, {
      method: 'PUT',
      body: JSON.stringify({
        position_seconds: ep.position_seconds,
        duration_seconds: ep.duration_seconds,
        completed: ep.completed,
      }),
    }).catch(() => {});
  };

  useEffect(() => {
    void loadPodcasts();
  }, []);

  return (
    <div className="podcasts-page">
      {notice && <div className="podcasts-toast">{notice}</div>}

      <div className="podcasts-header">
        <div className="podcasts-header-title">
          {selectedPodcast ? (
            <button
              type="button"
              className="podcast-back-btn"
              onClick={() => {
                setSelectedPodcast(null);
                setSelectedDetail(null);
                void loadPodcasts();
              }}
            >
              ← 返回电台列表
            </button>
          ) : (
            <h2>电台 · 播客</h2>
          )}
        </div>

        <div className="podcasts-actions">
          <button
            type="button"
            className={`podcasts-action-btn ${queueInfo && queueInfo.total_pending > 0 ? 'highlight-pulse' : ''}`}
            onClick={() => {
              setShowQueueModal(true);
              void fetchQueue();
            }}
            title="查看播客音频下载队列与传输状态"
          >
            📥 下载队列
            {queueInfo && queueInfo.total_pending > 0 && (
              <span className="queue-pill-count">{queueInfo.total_pending}</span>
            )}
            {queueInfo && queueInfo.failed_count > 0 && queueInfo.total_pending === 0 && (
              <span className="queue-pill-count failed">!</span>
            )}
          </button>
          {!selectedPodcast && (
            <button
              type="button"
              className="podcasts-action-btn"
              disabled={refreshingAll || loading}
              onClick={handleRefreshAll}
              title="即刻从源端检查所有频道的最新单集并自动下载"
            >
              <Icon name="podcast" /> {refreshingAll ? '更新中…' : '全部更新'}
            </button>
          )}
          {selectedPodcast && (
            <button
              type="button"
              className="podcasts-action-btn"
              onClick={() => handleOpenSettings(selectedPodcast)}
              title="配置自动下载与宿主机挂载存储"
            >
              ⚙️ 自动下载设置
            </button>
          )}
          <button
            type="button"
            className="podcasts-action-btn primary"
            onClick={() => setShowSubscribeModal(true)}
          >
            + 添加订阅
          </button>
        </div>
      </div>

      {selectedPodcast ? (
        <div className="podcast-detail-view">
          <div className="podcast-meta-card">
            <div className="podcast-meta-cover">
              {selectedPodcast.cover_url ? (
                <img src={selectedPodcast.cover_url} alt={selectedPodcast.title} />
              ) : (
                <div className="podcast-cover-placeholder">🎙️</div>
              )}
            </div>
            <div className="podcast-meta-info">
              <h3>{selectedPodcast.title}</h3>
              <p className="podcast-meta-author">{selectedPodcast.author || '未知播客主'}</p>
              <p className="podcast-meta-desc">{selectedPodcast.description || '暂无详细介绍'}</p>
              <div className="podcast-meta-footer">
                <span>共 {selectedPodcast.total_episodes} 集</span>
                {selectedPodcast.downloaded_episodes > 0 && (
                  <span className="ep-download-badge">
                    ✓ 已存本地 {selectedPodcast.downloaded_episodes} 集
                  </span>
                )}
                {selectedPodcast.unplayed_episodes > 0 && (
                  <span className="unplayed-tag">{selectedPodcast.unplayed_episodes} 未听</span>
                )}
                <button
                  type="button"
                  className="podcast-refresh-btn"
                  disabled={detailLoading}
                  onClick={() => handleRefreshPodcast(selectedPodcast.id)}
                >
                  {detailLoading ? '同步中…' : '从源端立即同步'}
                </button>
                <button
                  type="button"
                  className="podcast-refresh-btn"
                  onClick={() => handleOpenSettings(selectedPodcast)}
                >
                  存储与下载设置…
                </button>
              </div>
            </div>
          </div>

          <div className="podcast-episodes-section">
            <div className="podcast-episodes-header">
              <h4>
                单集列表
                <span
                  style={{
                    fontSize: '0.85rem',
                    color: 'var(--muted, #9ca3af)',
                    fontWeight: 'normal',
                  }}
                >
                  ({displayedEpisodes.length}
                  {displayedEpisodes.length !== (selectedDetail?.episodes.length || 0) &&
                    ` / ${selectedDetail?.episodes.length || 0}`}
                  )
                </span>
              </h4>

              <div className="podcast-toolbar">
                <input
                  type="text"
                  className="podcast-search-input"
                  placeholder="🔍 搜索单集..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />

                <select
                  className="podcast-select"
                  value={sortField}
                  onChange={(e) => setSortField(e.target.value as any)}
                  title="选择排序方式"
                >
                  <option value="pub_date">📅 发布时间</option>
                  <option value="episode_number">🔢 单集期号</option>
                  <option value="duration">⏱ 单集时长</option>
                  <option value="title">🔤 标题首字</option>
                </select>

                <button
                  type="button"
                  className="podcast-toolbar-btn"
                  onClick={() => setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')}
                  title={
                    sortOrder === 'desc'
                      ? '当前为最新更新在前，点击切换为最早发布在前'
                      : '当前为最早发布在前，点击切换为最新更新在前'
                  }
                >
                  {sortOrder === 'desc' ? '↓ 最近更新' : '↑ 最早发布'}
                </button>

                <button
                  type="button"
                  className={`podcast-toolbar-btn ${filterUnplayed ? 'active' : ''}`}
                  onClick={() => setFilterUnplayed(!filterUnplayed)}
                  title="只看未听完的单集"
                >
                  🎧 未听完
                </button>

                <button
                  type="button"
                  className={`podcast-toolbar-btn ${filterDownloaded ? 'active' : ''}`}
                  onClick={() => setFilterDownloaded(!filterDownloaded)}
                  title="只看已下载到宿主机库的单集"
                >
                  💾 已存本地
                </button>
              </div>
            </div>

            {detailLoading && !selectedDetail ? (
              <div className="podcasts-loading">正在拉取最新单集…</div>
            ) : displayedEpisodes.length === 0 ? (
              <div className="podcasts-empty">
                {selectedDetail?.episodes.length === 0
                  ? '暂无单集'
                  : '未找到匹配条件的单集，请调整搜索或筛选条件'}
              </div>
            ) : (
              <div className="podcast-episodes-list">
                {displayedEpisodes.map((ep) => (
                  <div className="podcast-episode-row" key={ep.id}>
                    <button
                      type="button"
                      className="episode-play-btn"
                      onClick={() => playEpisode(ep, selectedPodcast)}
                      title="播放该单集"
                    >
                      ▶
                    </button>
                    <div className="episode-main-info">
                      <div className="episode-title">{ep.title}</div>
                      <div className="episode-sub-meta">
                        {ep.pub_date && <span className="ep-date">{ep.pub_date.slice(0, 16)}</span>}
                        {ep.duration_seconds > 0 && (
                          <span className="ep-duration">{formatDuration(ep.duration_seconds)}</span>
                        )}
                        {ep.download_status === 'downloaded' ? (
                          <span
                            className="ep-download-badge"
                            title={ep.local_path || '已保存在宿主机挂载目录'}
                          >
                            ✓ 已存本地
                          </span>
                        ) : ep.download_status === 'downloading' ? (
                          <span className="ep-download-badge">⏳ 下载中…</span>
                        ) : (
                          <button
                            type="button"
                            className="ep-download-btn"
                            onClick={(e) => handleDownloadSingleEpisode(ep, e)}
                            title="下载到本地宿主机存储库"
                          >
                            ⬇ 存入本地
                          </button>
                        )}
                        {ep.completed && <span className="ep-status-tag">已听完</span>}
                      </div>
                      {ep.description && (
                        <p className="episode-desc-snippet">
                          {cleanHtmlDescription(ep.description)}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="podcasts-overview">
          {loading && podcasts.length === 0 ? (
            <div className="podcasts-loading">正在加载已订阅播客…</div>
          ) : podcasts.length === 0 ? (
            <div className="podcasts-empty-state">
              <div className="empty-state-icon">🎙️</div>
              <h3>暂无订阅的播客电台</h3>
              <p>
                输入 RSS
                地址订阅，服务端会在后台持续自动为你获取最新单集，并支持挂载到宿主机独立管理。
              </p>
              <div className="preset-chips">
                <span className="preset-label">快捷订阅推荐：</span>
                {PRESET_PODCASTS.map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    className="preset-chip-btn"
                    onClick={() => {
                      setModalFeedUrl(item.url);
                      setShowSubscribeModal(true);
                    }}
                  >
                    + {item.name}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="podcasts-grid">
              {podcasts.map((p) => (
                <div
                  className="podcast-card"
                  key={p.id}
                  onClick={() => openDetail(p)}
                  onContextMenu={(e) => handleContextMenu(e, p)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="podcast-card-cover">
                    {p.cover_url ? (
                      <img src={p.cover_url} alt={p.title} loading="lazy" />
                    ) : (
                      <div className="podcast-cover-placeholder">🎙️</div>
                    )}
                    {p.downloaded_episodes > 0 && (
                      <span
                        className="podcast-badge-count"
                        title={`已在本地库保存 ${p.downloaded_episodes} 集`}
                      >
                        💾 {p.downloaded_episodes}
                      </span>
                    )}
                  </div>
                  <div className="podcast-card-body">
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.5rem',
                      }}
                    >
                      <h4 className="podcast-card-title" title={p.title}>
                        {p.title}
                      </h4>
                      <button
                        type="button"
                        className="podcast-card-menu-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleContextMenu(e, p);
                        }}
                        title="右键或点击打开设置选项"
                      >
                        ···
                      </button>
                    </div>
                    <p className="podcast-card-author">{p.author || '未知创作者'}</p>
                    <div className="podcast-card-meta">
                      <span>{p.total_episodes} 单集</span>
                      <button
                        type="button"
                        className="podcast-delete-btn"
                        onClick={(e) => handleOpenSettings(p, e)}
                        title="自动下载与存储设置"
                      >
                        ⚙️ 设置
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Floating Context Menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="podcast-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="podcast-context-item"
            onClick={() => handleOpenSettings(contextMenu.podcast)}
          >
            📥 自动下载与存储设置…
          </div>
          <div
            className="podcast-context-item"
            onClick={() => handleDownloadAll(contextMenu.podcast)}
          >
            ⬇ 立即下载全部单集到库
          </div>
          <div
            className="podcast-context-item"
            onClick={() => {
              setContextMenu(null);
              void handleRefreshPodcast(contextMenu.podcast.id);
            }}
          >
            🔄 立即从源端检查更新
          </div>
          <div
            className="podcast-context-item"
            onClick={() => {
              setContextMenu(null);
              setSettingsPodcast(contextMenu.podcast);
              void handleCleanDownloads();
            }}
          >
            🧹 清理本地音频文件
          </div>
          <div className="podcast-context-separator" />
          <div
            className="podcast-context-item danger"
            onClick={() => handleDelete(contextMenu.podcast)}
          >
            ❌ 取消订阅
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {settingsPodcast && (
        <div className="podcasts-modal-backdrop" onClick={() => setSettingsPodcast(null)}>
          <div className="podcasts-modal" onClick={(e) => e.stopPropagation()}>
            <div className="podcasts-modal-header">
              <h3>自动下载与挂载存储设置</h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setSettingsPodcast(null)}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: '0 1.25rem 1.25rem' }}>
              {storageInfo && (
                <div className="podcast-storage-box">
                  <div className="storage-path-header">
                    <span className="storage-label">📁 宿主机 / 容器挂载目录</span>
                    <button
                      type="button"
                      className="storage-copy-btn"
                      onClick={() => handleCopyPath(storageInfo.storage_path)}
                      title="复制完整路径"
                    >
                      复制路径
                    </button>
                  </div>
                  <div className="storage-path-display">
                    <code title={storageInfo.storage_path}>{storageInfo.storage_path}</code>
                  </div>
                  <div className="storage-stats-grid">
                    <div className="storage-stat-item">
                      <span className="storage-stat-label">已存单集 / 总单集</span>
                      <span className="storage-stat-val">
                        {storageInfo.downloaded_episodes} / {storageInfo.total_episodes} 集
                      </span>
                    </div>
                    <div className="storage-stat-item">
                      <span className="storage-stat-label">本地磁盘占用</span>
                      <span className="storage-stat-val">{storageInfo.disk_usage_human}</span>
                    </div>
                  </div>
                </div>
              )}

              <div className="podcast-settings-section">
                <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>自动下载策略</label>
                <div className="podcast-settings-radio-group">
                  {[
                    { val: 'latest_3', label: '自动下载最新 3 集' },
                    { val: 'latest_5', label: '自动下载最新 5 集（推荐）' },
                    { val: 'latest_10', label: '自动下载最新 10 集' },
                    { val: 'unplayed', label: '自动下载所有未听完单集' },
                    { val: 'all', label: '自动下载全部历史单集' },
                    { val: 'none', label: '关闭自动下载（仅按需串流）' },
                  ].map((opt) => (
                    <label key={opt.val} className="podcast-radio-label">
                      <input
                        type="radio"
                        name="download_policy"
                        value={opt.val}
                        checked={downloadPolicy === opt.val}
                        onChange={(e) => setDownloadPolicy(e.target.value)}
                      />
                      <span>{opt.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="podcast-settings-section" style={{ marginTop: '1rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>保留与清理策略</label>
                <div className="podcast-settings-radio-group">
                  {[
                    { val: 'keep_all', label: '始终保留已下载单集' },
                    { val: 'delete_completed', label: '单集听完后自动清理本地音频以释放空间' },
                  ].map((opt) => (
                    <label key={opt.val} className="podcast-radio-label">
                      <input
                        type="radio"
                        name="retention_policy"
                        value={opt.val}
                        checked={retentionPolicy === opt.val}
                        onChange={(e) => setRetentionPolicy(e.target.value)}
                      />
                      <span>{opt.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div
                style={{
                  marginTop: '1.25rem',
                  display: 'flex',
                  gap: '0.75rem',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <button
                  type="button"
                  className="podcast-clean-btn"
                  disabled={cleaningDownloads}
                  onClick={handleCleanDownloads}
                >
                  {cleaningDownloads ? '清理中…' : '🧹 清理所有已下载音频'}
                </button>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    type="button"
                    className="modal-cancel-btn"
                    onClick={() => setSettingsPodcast(null)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="modal-submit-btn primary"
                    disabled={savingSettings}
                    onClick={handleSaveSettings}
                  >
                    {savingSettings ? '保存中…' : '保存设置'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Subscribe Modal */}
      {showSubscribeModal && (
        <div className="podcasts-modal-backdrop" onClick={() => setShowSubscribeModal(false)}>
          <div className="podcasts-modal" onClick={(e) => e.stopPropagation()}>
            <div className="podcasts-modal-header">
              <h3>订阅新播客</h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setShowSubscribeModal(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleSubscribe}>
              {modalError && <div className="modal-error-message">{modalError}</div>}
              <div className="modal-field">
                <label htmlFor="feed-url">RSS 地址</label>
                <input
                  id="feed-url"
                  type="url"
                  placeholder="https://example.com/feed.xml"
                  value={modalFeedUrl}
                  onChange={(e) => {
                    setModalFeedUrl(e.target.value);
                    if (modalError) setModalError(null);
                  }}
                  required
                  autoFocus
                />
              </div>

              <div className="preset-chips in-modal">
                <span className="preset-label">快速填入推荐：</span>
                <div className="preset-chips-row">
                  {PRESET_PODCASTS.map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      className="preset-chip-btn"
                      onClick={() => {
                        setModalFeedUrl(item.url);
                        if (modalError) setModalError(null);
                      }}
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  className="modal-cancel-btn"
                  onClick={() => setShowSubscribeModal(false)}
                  disabled={subscribing}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="modal-submit-btn primary"
                  disabled={subscribing || !modalFeedUrl.trim()}
                >
                  {subscribing ? '正在解析订阅…' : '立即订阅'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Download Queue Modal */}
      {showQueueModal && (
        <div className="podcasts-modal-backdrop" onClick={() => setShowQueueModal(false)}>
          <div
            className="podcasts-modal"
            style={{ maxWidth: '640px' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="podcasts-modal-header">
              <h3>播客下载队列与传输中心</h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setShowQueueModal(false)}
              >
                ✕
              </button>
            </div>

            <div className="queue-modal-summary">
              <span
                className={`queue-badge ${queueInfo && queueInfo.active_count > 0 ? 'active' : ''}`}
              >
                ⚡ {queueInfo?.active_count || 0} 项正在下载
              </span>
              <span className="queue-badge">⏳ {queueInfo?.queued_count || 0} 项排队中</span>
              <span className="queue-badge">
                ✓ {queueInfo?.recent_completed.length || 0} 项近期已存入
              </span>
              {queueInfo && queueInfo.failed_count > 0 && (
                <span className="queue-badge failed">⚠️ {queueInfo.failed_count} 项下载失败</span>
              )}
            </div>

            <div className="queue-list-container">
              {/* Failed Items Section */}
              {queueInfo && queueInfo.failed.length > 0 && (
                <div className="queue-block">
                  <h4>
                    <span>下载失败 ({queueInfo.failed.length})</span>
                    <button
                      type="button"
                      className="podcast-toolbar-btn"
                      style={{ fontSize: '0.75rem', padding: '0.15rem 0.5rem' }}
                      disabled={retryingFailed}
                      onClick={handleRetryFailed}
                    >
                      {retryingFailed ? '重试中…' : '🔄 全部重试'}
                    </button>
                  </h4>
                  <div className="queue-cards-group">
                    {queueInfo.failed.map((task) => (
                      <div className="queue-task-card failed" key={task.episode_id}>
                        <div className="queue-task-main">
                          <div className="queue-task-title">{task.episode_title}</div>
                          <div className="queue-task-sub" style={{ color: '#f87171' }}>
                            ⚠️ {task.error || '源站下载未成功，请检查网络或重试'}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="queue-retry-single-btn"
                          onClick={() => {
                            void api(
                              `/podcasts/episodes/${encodeURIComponent(task.episode_id)}/download`,
                              {
                                method: 'POST',
                              },
                            ).then(() => {
                              showNotice(`已将《${task.episode_title}》重新加入队列`);
                              void fetchQueue();
                            });
                          }}
                        >
                          重试
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Downloading & Queued Items Section */}
              {queueInfo && (queueInfo.downloading.length > 0 || queueInfo.queued.length > 0) ? (
                <div className="queue-block">
                  <h4>
                    <span>
                      传输中与队列 ({queueInfo.downloading.length + queueInfo.queued.length})
                    </span>
                  </h4>
                  <div className="queue-cards-group">
                    {queueInfo.downloading.map((task) => {
                      const pct =
                        task.progress_pct != null
                          ? Math.min(Math.max(task.progress_pct, 0), 100)
                          : null;
                      return (
                        <div className="queue-task-card downloading" key={task.episode_id}>
                          <div className="queue-task-main">
                            <div className="queue-task-title">{task.episode_title}</div>
                            <div className="queue-task-sub">{task.podcast_title}</div>
                            <div className="queue-task-progress-box">
                              <div className="queue-progress-bar-bg">
                                <div
                                  className={`queue-progress-bar-fill ${pct == null ? 'indeterminate' : ''}`}
                                  style={{ width: pct != null ? `${pct}%` : undefined }}
                                />
                              </div>
                              <div className="queue-task-metrics">
                                <span className="queue-task-speed">
                                  ⚡ {task.speed_human || '正在拉取数据…'}
                                </span>
                                <span>
                                  {task.downloaded_human
                                    ? `${task.downloaded_human} / ${task.total_human || '未知'}`
                                    : '连接中…'}
                                  {pct != null ? ` (${pct}%)` : ''}
                                </span>
                              </div>
                            </div>
                          </div>
                          <span className="queue-task-status downloading">
                            {pct != null ? `${pct}%` : '下载中'}
                          </span>
                        </div>
                      );
                    })}
                    {queueInfo.queued.map((task, idx) => (
                      <div className="queue-task-card" key={task.episode_id}>
                        <div className="queue-task-main">
                          <div className="queue-task-title">{task.episode_title}</div>
                          <div className="queue-task-sub">{task.podcast_title}</div>
                        </div>
                        <span className="queue-task-status queued">排队 #{idx + 1}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Recent Completed Section */}
              {queueInfo && queueInfo.recent_completed.length > 0 && (
                <div className="queue-block">
                  <h4>
                    <span>近期已完成 ({queueInfo.recent_completed.length})</span>
                    <button
                      type="button"
                      className="queue-clear-btn"
                      onClick={handleClearCompleted}
                    >
                      清空记录
                    </button>
                  </h4>
                  <div className="queue-cards-group">
                    {queueInfo.recent_completed.slice(0, 15).map((task) => (
                      <div className="queue-task-card" key={task.episode_id}>
                        <div className="queue-task-main">
                          <div className="queue-task-title">{task.episode_title}</div>
                          <div className="queue-task-sub">{task.podcast_title}</div>
                        </div>
                        <span className="queue-task-status downloaded">✓ 已存本地</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Empty State */}
              {(!queueInfo ||
                (queueInfo.downloading.length === 0 &&
                  queueInfo.queued.length === 0 &&
                  queueInfo.failed.length === 0 &&
                  queueInfo.recent_completed.length === 0)) && (
                <div className="queue-empty-state">
                  <div className="queue-empty-icon">📥</div>
                  <div>当前无下载任务进行中</div>
                  <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                    自动下载或手动点击单集的「存入本地」后，任务将在此实时流转
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
