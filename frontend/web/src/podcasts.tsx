import { PodcastDownloadDialog } from './podcast-download-settings';
import { useCanAddPodcast } from './podcast-catalog-settings';
import { OPML_EXPORT_URL, PodcastOpmlImportDialog } from './podcast-opml';
import { PodcastSearchDialog } from './podcast-search';
import { PodcastResourceManager } from './podcast-resources';
import { DialogCloseButton } from './dialog-close';
import React, { useEffect, useState, useRef, useMemo } from 'react';
import type { EpisodeProgress } from './podcast-progress';
import { api, type Track } from './api';
import { Icon } from './icons';
import { rememberPodcastCover } from './cover';
import { cleanPodcastDescription, renderPodcastDescription } from './podcast-description';
import { podcastEpisodeToTrack } from './podcast-track';
import { RowMenu } from './row-menu';
import {
  PublisherAffiliation,
  type PodcastPublisher,
  type PublisherDetail,
} from './podcast-publishers';

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
  slow_download?: boolean;
  max_retries?: number;
  retry_backoff_base?: number;
  last_updated_at: string | null;
  created_at: string;
  total_episodes: number;
  unplayed_episodes: number;
  downloaded_episodes: number;
  storage_path: string;
  publisher?: PodcastPublisher | null;
  publisher_version?: number;
  followed?: boolean;
}

export interface PodcastPlaybackSettings {
  user_id: string;
  auto_cache_current: boolean;
  prefetch_next: boolean;
  network_policy: 'off' | 'wifi' | 'any';
  version: number;
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
  download_status?: 'none' | 'queued' | 'downloading' | 'downloaded' | 'failed';
  resource_saved?: boolean;
  resource_automatic?: boolean;
  resource_playback_cached?: boolean;
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
  status: 'queued' | 'downloading' | 'downloaded' | 'failed' | 'retrying';
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
  slow_mode?: boolean;
  attempt?: number;
  max_retries?: number;
  backoff_seconds?: number;
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

interface PodcastsProps {
  userId: string;
  canEditPublishers?: boolean;
  canManageSources?: boolean;
  canManageResources?: boolean;
  onPlayTrack: (track: Track) => void;
  onQueueTrack: (track: Track, next: boolean) => void;
}

type EpisodeScope = 'saved' | 'downloaded' | 'all';
type DownloadQueueView = 'active' | 'failed' | 'completed';

function readEpisodeScope(userId: string): EpisodeScope {
  try {
    const value = localStorage.getItem(`wildstring:podcast-scope:${userId}`);
    return value === 'all' || value === 'saved' ? value : 'downloaded';
  } catch {
    return 'downloaded';
  }
}

interface ContextMenuState {
  x: number;
  y: number;
  podcast: PodcastSummary;
}

export const PodcastsPage: React.FC<PodcastsProps> = ({
  userId,
  canEditPublishers = false,
  canManageSources = false,
  canManageResources = false,
  onPlayTrack,
  onQueueTrack,
}) => {
  const [showResources, setShowResources] = useState(false);
  const [podcasts, setPodcasts] = useState<PodcastSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPodcast, setSelectedPodcast] = useState<PodcastSummary | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<PodcastDetail | null>(null);
  const [publisherView, setPublisherView] = useState<PublisherDetail | null>(null);
  const [followingOnly, setFollowingOnly] = useState(true);
  const personalOnly = !canManageSources || followingOnly;
  const [followBusy, setFollowBusy] = useState<string | null>(null);
  const overviewPodcasts = publisherView?.podcasts ?? podcasts;
  const visiblePodcasts = personalOnly
    ? overviewPodcasts.filter((podcast) => podcast.followed)
    : overviewPodcasts;
  const [selectedEpisode, setSelectedEpisode] = useState<PodcastEpisode | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showSubscribeModal, setShowSubscribeModal] = useState(false);
  const [showOpmlImport, setShowOpmlImport] = useState(false);
  const canAddPodcast = useCanAddPodcast(userId, canManageSources);
  const [modalFeedUrl, setModalFeedUrl] = useState('');
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [playbackSettings, setPlaybackSettings] = useState<PodcastPlaybackSettings | null>(null);
  const [showPlaybackSettings, setShowPlaybackSettings] = useState(false);
  const [savingPlaybackSettings, setSavingPlaybackSettings] = useState(false);
  const [playbackSettingsError, setPlaybackSettingsError] = useState<string | null>(null);

  // Download queue state
  const [showQueueModal, setShowQueueModal] = useState(false);
  const [queueInfo, setQueueInfo] = useState<DownloadQueueInfo | null>(null);
  const [retryingFailed, setRetryingFailed] = useState(false);
  const [queueView, setQueueView] = useState<DownloadQueueView | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Settings modal state
  const [settingsPodcast, setSettingsPodcast] = useState<PodcastSummary | null>(null);
  const [storageInfo, setStorageInfo] = useState<PodcastStorageInfo | null>(null);
  const [personalDownload, setPersonalDownload] = useState<PodcastSummary | null>(null);
  const [slowDownload, setSlowDownload] = useState(false);
  const [maxRetries, setMaxRetries] = useState(3);
  const [retryBackoffBase, setRetryBackoffBase] = useState(5);
  const [savingSettings, setSavingSettings] = useState(false);
  const [cleaningDownloads, setCleaningDownloads] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageNotice, setStorageNotice] = useState<string | null>(null);

  // Episodes sort & filter state
  const [sortField, setSortField] = useState<'pub_date' | 'episode_number' | 'duration' | 'title'>(
    'pub_date',
  );
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [filterUnplayed, setFilterUnplayed] = useState(false);
  const [episodeScope, setEpisodeScope] = useState<EpisodeScope>(() => readEpisodeScope(userId));
  const [searchQuery, setSearchQuery] = useState('');

  const menuRef = useRef<HTMLDivElement | null>(null);
  const downloadDialog = useRef<HTMLDialogElement | null>(null);
  const settingsDialog = useRef<HTMLDialogElement | null>(null);
  const previousCompleted = useRef<string | null>(null);
  const completedRevision =
    queueInfo?.recent_completed
      .map((task) => `${task.episode_id}:${task.completed_at}`)
      .join('|') || '';

  useEffect(() => {
    const dialog = downloadDialog.current;
    if (!showQueueModal || !dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, [showQueueModal]);

  useEffect(() => setEpisodeScope(readEpisodeScope(userId)), [userId]);
  useEffect(() => {
    const updated = (event: Event) => {
      const progress = (event as CustomEvent<EpisodeProgress>).detail;
      if (!progress) return;
      setSelectedDetail((detail) =>
        detail
          ? {
              ...detail,
              episodes: detail.episodes.map((episode) =>
                episode.id === progress.episode_id
                  ? {
                      ...episode,
                      position_seconds: progress.position_seconds,
                      completed: progress.completed,
                    }
                  : episode,
              ),
            }
          : detail,
      );
    };
    window.addEventListener('wildstring:podcast-progress-updated', updated);
    return () => window.removeEventListener('wildstring:podcast-progress-updated', updated);
  }, [userId]);

  useEffect(() => {
    const dialog = settingsDialog.current;
    if (!settingsPodcast || !dialog) return;
    dialog.showModal();
    let active = true;
    void api<PodcastStorageInfo>(`/podcasts/${encodeURIComponent(settingsPodcast.id)}/storage`)
      .then((info) => {
        if (active) setStorageInfo(info);
      })
      .catch(() => {
        if (active) setStorageError('暂时无法读取存储信息，可以稍后重新打开。');
      });
    return () => {
      active = false;
      dialog.close();
    };
  }, [settingsPodcast?.id]);

  useEffect(() => {
    const previous = previousCompleted.current;
    previousCompleted.current = completedRevision;
    if (previous === null || previous === completedRevision || !completedRevision) return;
    let active = true;
    // Refresh saved episodes in place when a background download finishes.
    // Keep the current list visible, and discard replies after changing podcasts.
    void api<PodcastSummary[]>('/podcasts')
      .then((items) => {
        if (active) setPodcasts(items);
      })
      .catch(() => {});
    if (selectedPodcast?.id) {
      void api<PodcastDetail>(`/podcasts/${encodeURIComponent(selectedPodcast.id)}`)
        .then((detail) => {
          if (!active) return;
          setSelectedDetail(detail);
          setSelectedPodcast(detail.podcast);
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [completedRevision, selectedPodcast?.id]);

  const changeEpisodeScope = (scope: EpisodeScope) => {
    setEpisodeScope(scope);
    if (scope === 'saved' && selectedPodcast) void openDetail(selectedPodcast);
    try {
      localStorage.setItem(`wildstring:podcast-scope:${userId}`, scope);
    } catch {
      // Keep browsing usable when the browser does not allow local storage.
    }
  };
  const downloadedCount =
    selectedDetail?.episodes.filter((episode) => episode.download_status === 'downloaded').length ||
    0;
  const personalDownloadCount =
    selectedDetail?.episodes.filter(
      (episode) =>
        episode.resource_saved || episode.resource_automatic || episode.resource_playback_cached,
    ).length || 0;
  const activeQueueView: DownloadQueueView =
    queueView ||
    (queueInfo?.total_pending
      ? 'active'
      : queueInfo?.failed_count
        ? 'failed'
        : queueInfo?.recent_completed.length
          ? 'completed'
          : 'active');

  const sortOrderLabels: Record<typeof sortField, { asc: string; desc: string }> = {
    pub_date: { asc: '最早发布在前', desc: '最新发布在前' },
    episode_number: { asc: '期号从低到高', desc: '期号从高到低' },
    duration: { asc: '时长从短到长', desc: '时长从长到短' },
    title: { asc: '标题正序排列', desc: '标题倒序排列' },
  };
  const currentSortOrderLabel = sortOrderLabels[sortField][sortOrder];
  const nextSortOrderLabel = sortOrderLabels[sortField][sortOrder === 'desc' ? 'asc' : 'desc'];

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

    if (episodeScope === 'saved')
      list = list.filter(
        (ep) => ep.resource_saved || ep.resource_automatic || ep.resource_playback_cached,
      );
    if (episodeScope === 'downloaded') {
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
  }, [selectedDetail?.episodes, sortField, sortOrder, filterUnplayed, episodeScope, searchQuery]);

  const showNotice = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 3000);
  };

  const loadPodcasts = async (background = false) => {
    try {
      if (!background) setLoading(true);
      const res = await api<PodcastSummary[]>(
        canManageSources ? '/podcasts' : '/podcasts?followed=true',
      );
      setPodcasts(res);
    } catch (e) {
      showNotice(e instanceof Error ? e.message : '获取播客订阅失败');
    } finally {
      if (!background) setLoading(false);
    }
  };

  const openDetail = async (p: PodcastSummary) => {
    setSelectedPodcast(p);
    try {
      setDetailLoading(true);
      const detail = await api<PodcastDetail>(`/podcasts/${encodeURIComponent(p.id)}`);
      setSelectedDetail(detail);
      setSelectedPodcast(detail.podcast);
    } catch (e) {
      showNotice(e instanceof Error ? e.message : '加载单集失败');
    } finally {
      setDetailLoading(false);
    }
  };

  async function toggleFollow(podcast: PodcastSummary) {
    if (followBusy) return;
    setFollowBusy(podcast.id);
    try {
      const result = await api<{ followed: boolean }>(
        `/podcasts/${encodeURIComponent(podcast.id)}/follow`,
        {
          method: 'PUT',
          body: JSON.stringify({ followed: !podcast.followed }),
        },
      );
      const update = (item: PodcastSummary) =>
        item.id === podcast.id ? { ...item, followed: result.followed } : item;
      setPodcasts((items) => items.map(update));
      setSelectedPodcast((item) => item && update(item));
      setPublisherView((value) => value && { ...value, podcasts: value.podcasts.map(update) });
      showNotice(result.followed ? '已关注节目' : '已取消关注，收听进度已保留');
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : '关注状态保存失败');
    } finally {
      setFollowBusy(null);
    }
  }

  const openPublisher = async (publisher: PodcastPublisher) => {
    try {
      const detail = await api<PublisherDetail>(
        `/podcasts/publishers/${encodeURIComponent(publisher.id)}`,
      );
      setPublisherView(detail);
      setSelectedPodcast(null);
      setSelectedDetail(null);
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : '出品方节目加载失败');
    }
  };

  const publisherSaved = (detail: PodcastDetail) => {
    setSelectedPodcast(detail.podcast);
    setSelectedDetail(detail);
    setPodcasts((items) =>
      items.map((item) => (item.id === detail.podcast.id ? detail.podcast : item)),
    );
    setPublisherView((view) => {
      if (!view) return null;
      const shows = view.podcasts
        .map((item) => (item.id === detail.podcast.id ? detail.podcast : item))
        .filter((item) => item.publisher?.id === view.publisher.id);
      return {
        ...view,
        podcasts: shows,
        publisher: { ...view.publisher, podcast_count: shows.length },
      };
    });
    void loadPodcasts(true);
    showNotice('出品方归属已保存');
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
      await loadPodcasts(true);
    } catch (e) {
      showNotice(e instanceof Error ? e.message : '全部更新失败');
    } finally {
      setRefreshingAll(false);
    }
  };

  const handleDelete = async (p: PodcastSummary, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setContextMenu(null);
    if (
      !canManageSources ||
      !confirm(
        `从本服删除《${p.title}》？所有用户的关注和收听记录都会移除。只取消自己的关注，请使用“取消关注”。`,
      )
    )
      return;
    try {
      await api(`/podcasts/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      setPublisherView((view) =>
        view
          ? {
              ...view,
              podcasts: view.podcasts.filter((item) => item.id !== p.id),
              publisher: {
                ...view.publisher,
                podcast_count: view.podcasts.filter((item) => item.id !== p.id).length,
              },
            }
          : null,
      );
      showNotice(`已从本服删除节目: ${p.title}`);
      if (selectedPodcast?.id === p.id) {
        setSelectedPodcast(null);
        setSelectedDetail(null);
      }
      await loadPodcasts();
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '删除节目失败');
    }
  };

  const handleOpenSettings = (p: PodcastSummary, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!canManageSources) return;
    setContextMenu(null);
    setStorageInfo(null);
    setStorageError(null);
    setStorageNotice(null);
    setSettingsError(null);
    setSettingsPodcast(p);
    setSlowDownload(Boolean(p.slow_download));
    setMaxRetries(p.max_retries ?? 3);
    setRetryBackoffBase(p.retry_backoff_base ?? 5);
  };

  const handleCopyPath = (path: string) => {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(path).then(
        () => setStorageNotice('已复制完整路径'),
        () => setStorageNotice('复制失败，请长按或选中路径复制。'),
      );
    } else {
      setStorageNotice('当前环境不支持直接复制，请长按或选中路径复制。');
    }
  };

  const loadPlaybackSettings = async () => {
    try {
      setPlaybackSettingsError(null);
      setPlaybackSettings(await api<PodcastPlaybackSettings>('/podcasts/playback-settings'));
    } catch {
      // Older servers simply omit this optional client setting.
    }
  };

  const savePlaybackSettings = async () => {
    if (!playbackSettings) return;
    try {
      setSavingPlaybackSettings(true);
      setPlaybackSettingsError(null);
      const updated = await api<PodcastPlaybackSettings>('/podcasts/playback-settings', {
        method: 'PUT',
        body: JSON.stringify({
          version: playbackSettings.version,
          auto_cache_current: playbackSettings.auto_cache_current,
          prefetch_next: playbackSettings.prefetch_next,
          network_policy: playbackSettings.network_policy,
        }),
      });
      setPlaybackSettings(updated);
      setShowPlaybackSettings(false);
      showNotice('播放缓存设置已保存');
    } catch (err) {
      setPlaybackSettingsError(err instanceof Error ? err.message : '播放缓存设置保存失败');
    } finally {
      setSavingPlaybackSettings(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!settingsPodcast) return;
    try {
      setSavingSettings(true);
      setSettingsError(null);
      const updated = await api<PodcastDetail>(
        `/podcasts/${encodeURIComponent(settingsPodcast.id)}/settings`,
        {
          method: 'PUT',
          body: JSON.stringify({
            slow_download: slowDownload,
            max_retries: maxRetries,
            retry_backoff_base: retryBackoffBase,
          }),
        },
      );
      showNotice(`已更新《${updated.podcast.title}》的服务器下载设置`);
      if (selectedPodcast?.id === updated.podcast.id) {
        setSelectedPodcast(updated.podcast);
        setSelectedDetail(updated);
      }
      setPodcasts((items) =>
        items.map((item) => (item.id === updated.podcast.id ? updated.podcast : item)),
      );
      setSettingsPodcast(null);
      await loadPodcasts(true);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : '保存设置失败');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleCleanDownloads = async (targetPodcast?: PodcastSummary) => {
    const podcast = targetPodcast || settingsPodcast;
    if (!podcast || !canManageResources) return;
    try {
      setCleaningDownloads(true);
      setSettingsError(null);
      setStorageNotice(null);
      const preview = await api<{ candidate_count: number; candidate_bytes: number }>(
        '/podcasts/resources/cleanup',
        { method: 'POST', body: JSON.stringify({ dry_run: true, podcast_id: podcast.id }) },
      );
      if (
        !confirm(
          `《${podcast.title}》可清理 ${preview.candidate_count} 个零引用文件，共 ${(preview.candidate_bytes / 1048576).toFixed(1)} MB。确认立即清理？`,
        )
      )
        return;
      const res = await api<{ deleted_count: number; freed_bytes: number }>(
        `/podcasts/${encodeURIComponent(podcast.id)}/clean-downloads`,
        { method: 'POST' },
      );
      const message = `已清理 ${res.deleted_count} 个音频文件，释放空间 ${(res.freed_bytes / 1024 / 1024).toFixed(1)} MB`;
      if (settingsPodcast?.id === podcast.id) setStorageNotice(message);
      else showNotice(message);
      const info = await api<PodcastStorageInfo>(
        `/podcasts/${encodeURIComponent(podcast.id)}/storage`,
      );
      setStorageInfo(info);
      await loadPodcasts();
      if (selectedPodcast?.id === podcast.id) {
        await openDetail(podcast);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '清理音频失败';
      if (settingsPodcast?.id === podcast.id) setSettingsError(message);
      else showNotice(message);
    } finally {
      setCleaningDownloads(false);
    }
  };

  const fetchQueue = async () => {
    try {
      const q = await api<DownloadQueueInfo>('/podcasts/downloads/queue');
      setQueueInfo(q);
      setQueueError(null);
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : '下载状态加载失败，请重试');
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
      if (res.retried_count > 0) setQueueView('active');
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : '重试任务失败');
    } finally {
      setRetryingFailed(false);
    }
  };

  const handleClearCompleted = async () => {
    try {
      await api('/podcasts/downloads/clear-completed', { method: 'POST' });
      await fetchQueue();
      showNotice('已清除完成记录，下载的音频仍保留');
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : '清除记录失败，请重试');
    }
  };

  const handleRetryDownload = async (task: DownloadTaskItem) => {
    try {
      await api(`/podcasts/episodes/${encodeURIComponent(task.episode_id)}/download`, {
        method: 'POST',
      });
      await fetchQueue();
      setQueueView('active');
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : '重新下载失败，请重试');
    }
  };

  useEffect(() => {
    if (!canManageSources) return;
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
  }, [showQueueModal, queueInfo?.total_pending, canManageSources]);

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

  const handleDownloadSingleEpisode = async (ep: PodcastEpisode, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      const saved = !ep.resource_saved;
      const result = await api<{ saved: boolean; reused?: boolean }>(
        `/podcasts/episodes/${encodeURIComponent(ep.id)}/download`,
        { method: saved ? 'POST' : 'DELETE' },
      );
      const patch = (item: PodcastEpisode): PodcastEpisode =>
        item.id === ep.id
          ? {
              ...item,
              resource_saved: result.saved,
              ...(saved ? { download_status: result.reused ? 'downloaded' : 'downloading' } : {}),
            }
          : item;
      setSelectedDetail((detail) => detail && { ...detail, episodes: detail.episodes.map(patch) });
      setSelectedEpisode((item) => item && patch(item));
      showNotice(
        !saved
          ? '已取消个人保存，共享音频按服务器清理策略保留。'
          : result.reused
            ? '已复用服务器已有音频，无需重复下载'
            : '已保存，正在准备服务器音频。',
      );
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '保存单集失败');
    }
  };

  const handleContextMenu = (e: React.MouseEvent, p: PodcastSummary) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canManageSources) return;
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

  const closeSubscribe = () => {
    setShowSubscribeModal(false);
    setModalFeedUrl('');
  };

  const openFromSearch = async (podcastId: string) => {
    closeSubscribe();
    const detail = await api<PodcastDetail>(`/podcasts/${encodeURIComponent(podcastId)}`).catch(
      (err: Error) => {
        showNotice(err.message);
        return null;
      },
    );
    if (detail) await openDetail(detail.podcast);
  };

  const handleSubscribed = async (podcastId: string, title: string) => {
    showNotice(`已关注《${title}》`);
    await loadPodcasts();
    await openFromSearch(podcastId);
  };

  const playEpisode = (ep: PodcastEpisode, podcast: PodcastSummary) => {
    const trackId = `podcast_ep_${ep.id}`;
    if (podcast.cover_url) {
      rememberPodcastCover(trackId, podcast.cover_url);
    }
    const track = podcastEpisodeToTrack(ep, podcast);
    track.podcast_list_order =
      sortField === 'pub_date' || sortField === 'episode_number' ? sortOrder : 'desc';
    onPlayTrack(track);
  };

  const queueEpisode = (ep: PodcastEpisode, podcast: PodcastSummary, next: boolean) => {
    const track = podcastEpisodeToTrack(ep, podcast);
    track.podcast_list_order =
      sortField === 'pub_date' || sortField === 'episode_number' ? sortOrder : 'desc';
    onQueueTrack(track, next);
    showNotice(next ? '已安排为下一集播放' : '已加入手动待播清单');
  };

  useEffect(() => {
    void loadPodcasts();
    void loadPlaybackSettings();
  }, []);

  return (
    <div
      className={`podcasts-page${publisherView && !selectedPodcast ? ' podcast-publisher-page' : ''}`}
    >
      {notice && (
        <div className="podcasts-toast" role="status">
          {notice}
        </div>
      )}

      <div className="podcasts-header">
        <div className="podcasts-header-title">
          {selectedPodcast || publisherView ? (
            <button
              type="button"
              className="podcast-back-btn"
              onClick={() => {
                if (!selectedPodcast) setPublisherView(null);
                setSelectedPodcast(null);
                setSelectedDetail(null);
                void loadPodcasts();
              }}
            >
              {selectedPodcast && publisherView
                ? `← 返回${publisherView.publisher.name}`
                : '← 返回电台列表'}
            </button>
          ) : (
            <h2>电台 · 播客</h2>
          )}
          {!selectedPodcast && publisherView && (
            <>
              <h2>{publisherView.publisher.name}</h2>
              <p className="publisher-help">
                {personalOnly ? '我关注的' : '本服已有'} {visiblePodcasts.length} 档已确认节目
              </p>
            </>
          )}
        </div>

        <div className="podcasts-actions">
          {canManageResources && (
            <button
              type="button"
              className="podcasts-action-btn"
              onClick={() => setShowResources(true)}
            >
              共享音频管理
            </button>
          )}
          <button
            type="button"
            className="podcasts-action-btn"
            onClick={() => {
              setPlaybackSettingsError(null);
              setShowPlaybackSettings(true);
            }}
            title="播放未下载单集时自动缓存当前单集"
          >
            ⚡ 播放缓存
          </button>
          {canManageSources && (
            <button
              type="button"
              className={`podcasts-action-btn ${queueInfo && queueInfo.total_pending > 0 ? 'highlight-pulse' : ''}`}
              onClick={() => {
                setQueueView(null);
                setShowQueueModal(true);
                void fetchQueue();
              }}
              title="查看播客音频下载队列与传输状态"
            >
              <Icon name="download" /> 下载管理
              {queueInfo && queueInfo.total_pending > 0 && (
                <span className="queue-pill-count">{queueInfo.total_pending}</span>
              )}
              {queueInfo && queueInfo.failed_count > 0 && queueInfo.total_pending === 0 && (
                <span className="queue-pill-count failed">!</span>
              )}
            </button>
          )}
          {!selectedPodcast && canManageSources && (
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
          {!selectedPodcast && canAddPodcast && (
            <button
              type="button"
              className="podcasts-action-btn"
              onClick={() => setShowOpmlImport(true)}
              title="从其他播客应用导出的 OPML 文件批量关注节目"
            >
              导入 OPML
            </button>
          )}
          {!selectedPodcast && (
            <a
              className="podcasts-action-btn"
              href={OPML_EXPORT_URL}
              download="wildstring-podcasts.opml"
              title="把我关注的节目导出为 OPML 文件"
            >
              导出 OPML
            </a>
          )}
          {!selectedPodcast && (
            <button
              type="button"
              className="podcasts-action-btn primary"
              onClick={() => setShowSubscribeModal(true)}
            >
              {canAddPodcast ? '+ 添加节目' : '搜索节目'}
            </button>
          )}
        </div>
      </div>

      {!selectedPodcast && !publisherView && (
        <div className="podcast-catalog-tabs" role="group" aria-label="节目范围">
          <button type="button" aria-pressed={personalOnly} onClick={() => setFollowingOnly(true)}>
            我的关注
          </button>
          {canManageSources && (
            <button
              type="button"
              aria-pressed={!personalOnly}
              onClick={() => setFollowingOnly(false)}
            >
              本服节目
            </button>
          )}
        </div>
      )}

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
              <div className="podcast-meta-top">
                <div className="podcast-meta-heading">
                  <h3>{selectedPodcast.title}</h3>
                  <div className="podcast-meta-subline">
                    <p className="podcast-meta-author">{selectedPodcast.author || '未知播客主'}</p>
                    <PublisherAffiliation
                      podcast={selectedPodcast}
                      canEdit={canEditPublishers}
                      onOpen={(publisher) => void openPublisher(publisher)}
                      onSaved={publisherSaved}
                    />
                  </div>
                </div>
                <div className="podcast-meta-actions">
                  {selectedPodcast.followed && (
                    <button
                      type="button"
                      className="podcast-refresh-btn"
                      onClick={() => setPersonalDownload(selectedPodcast)}
                    >
                      自动下载
                    </button>
                  )}
                  <button
                    type="button"
                    className="podcast-refresh-btn"
                    disabled={followBusy === selectedPodcast.id}
                    onClick={() => void toggleFollow(selectedPodcast)}
                  >
                    {selectedPodcast.followed ? '取消关注' : '关注节目'}
                  </button>
                </div>
              </div>
              <div className="podcast-meta-desc">
                {renderPodcastDescription(selectedPodcast.description) || '暂无详细介绍'}
              </div>
              <div className="podcast-meta-footer">
                <div className="podcast-meta-stats">
                  <span>共 {selectedPodcast.total_episodes} 集</span>
                  {selectedPodcast.downloaded_episodes > 0 && (
                    <span className="ep-download-badge">
                      ✓ 已下载 {selectedPodcast.downloaded_episodes} 集
                    </span>
                  )}
                  {selectedPodcast.unplayed_episodes > 0 && (
                    <span className="unplayed-tag">{selectedPodcast.unplayed_episodes} 未听</span>
                  )}
                </div>
                {canManageSources && (
                  <div className="podcast-meta-footer-actions">
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
                )}
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

                <div className="podcast-sort-control" role="group" aria-label="单集排序">
                  <select
                    className="podcast-select"
                    value={sortField}
                    onChange={(e) => setSortField(e.target.value as typeof sortField)}
                    aria-label="排序依据"
                    title="选择排序依据"
                  >
                    <option value="pub_date">📅 发布时间</option>
                    <option value="episode_number">🔢 单集期号</option>
                    <option value="duration">⏱ 单集时长</option>
                    <option value="title">🔤 标题首字</option>
                  </select>
                  <button
                    type="button"
                    className="podcast-sort-direction"
                    onClick={() => setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')}
                    aria-label={`当前${currentSortOrderLabel}，点击切换为${nextSortOrderLabel}`}
                    title={`当前：${currentSortOrderLabel}；点击切换为：${nextSortOrderLabel}`}
                  >
                    <span aria-hidden="true">{sortOrder === 'desc' ? '↓' : '↑'}</span>
                  </button>
                </div>

                <button
                  type="button"
                  className={`podcast-toolbar-btn ${filterUnplayed ? 'active' : ''}`}
                  onClick={() => setFilterUnplayed(!filterUnplayed)}
                  title="只看未听完的单集"
                >
                  🎧 未听完
                </button>
              </div>
            </div>

            <div className="podcast-episode-scope" role="group" aria-label="单集范围">
              <button
                type="button"
                aria-pressed={episodeScope === 'saved'}
                onClick={() => changeEpisodeScope('saved')}
              >
                我的下载 <span>{personalDownloadCount}</span>
              </button>
              <button
                type="button"
                aria-pressed={episodeScope === 'downloaded'}
                onClick={() => changeEpisodeScope('downloaded')}
                title="已保存在服务器的单集"
              >
                服务器已有 <span>{downloadedCount}</span>
              </button>
              <button
                type="button"
                aria-pressed={episodeScope === 'all'}
                onClick={() => changeEpisodeScope('all')}
              >
                全部单集 <span>{selectedDetail?.episodes.length || 0}</span>
              </button>
            </div>

            {episodeScope === 'saved' && (
              <p className="download-records-note">
                包含你的手动下载、自动下载和播放缓存。播放缓存可按服务器清理规则回收。
              </p>
            )}

            {detailLoading && !selectedDetail ? (
              <div className="podcasts-loading">正在拉取最新单集…</div>
            ) : displayedEpisodes.length === 0 ? (
              <div className="podcasts-empty">
                {episodeScope === 'saved' && personalDownloadCount === 0 ? (
                  <>
                    <p>还没有你的下载</p>
                    <p>浏览全部单集，播放时缓存或选择保存后会显示在这里。</p>
                    <button
                      type="button"
                      className="podcasts-action-btn"
                      onClick={() => changeEpisodeScope('all')}
                    >
                      浏览全部单集
                    </button>
                  </>
                ) : episodeScope === 'downloaded' && downloadedCount === 0 ? (
                  <>
                    <p>这个播客还没有已下载单集</p>
                    <p>浏览全部单集即可播放，也可以选择保存到服务器。</p>
                    <button
                      type="button"
                      className="podcasts-action-btn"
                      onClick={() => changeEpisodeScope('all')}
                    >
                      浏览全部单集
                    </button>
                  </>
                ) : selectedDetail?.episodes.length === 0 ? (
                  '暂无单集'
                ) : (
                  '未找到匹配条件的单集，请调整搜索或筛选条件'
                )}
              </div>
            ) : (
              <div className="podcast-episodes-list">
                {displayedEpisodes.map((ep) => (
                  <RowMenu
                    className="podcast-episode-row"
                    key={ep.id}
                    label={ep.title}
                    actions={[
                      {
                        label: '播放单集',
                        icon: 'play',
                        run: () => playEpisode(ep, selectedPodcast),
                      },
                      {
                        label: '下一集播放',
                        icon: 'next',
                        run: () => queueEpisode(ep, selectedPodcast, true),
                      },
                      {
                        label: '加入待播',
                        icon: 'queue',
                        run: () => queueEpisode(ep, selectedPodcast, false),
                      },
                      {
                        label: ep.resource_saved ? '取消个人保存' : '保存到服务器',
                        icon: 'download',
                        run: () => {
                          void handleDownloadSingleEpisode(ep);
                        },
                      },
                    ]}
                  >
                    <button
                      type="button"
                      className="episode-play-btn"
                      onClick={() => playEpisode(ep, selectedPodcast)}
                      title="播放该单集"
                    >
                      ▶
                    </button>
                    <div className="episode-main-info">
                      <button
                        type="button"
                        className="episode-title episode-title-button"
                        onClick={() => setSelectedEpisode(ep)}
                        title="查看单集详情"
                      >
                        {ep.title}
                      </button>
                      <div className="episode-sub-meta">
                        {ep.pub_date && <span className="ep-date">{ep.pub_date.slice(0, 16)}</span>}
                        {ep.duration_seconds > 0 && (
                          <span className="ep-duration">{formatDuration(ep.duration_seconds)}</span>
                        )}
                        {ep.download_status === 'downloaded' && (
                          <span className="ep-download-badge" title="共享音频已保存在服务器">
                            ✓ 服务器已有
                          </span>
                        )}
                        {['downloading', 'queued'].includes(ep.download_status || '') && (
                          <span className="ep-download-badge">⏳ 准备中…</span>
                        )}
                        {ep.resource_playback_cached &&
                          !ep.resource_saved &&
                          !ep.resource_automatic && <span className="ep-status-tag">播放缓存</span>}
                        <button
                          type="button"
                          className="ep-download-btn"
                          onClick={(e) => void handleDownloadSingleEpisode(ep, e)}
                          title={ep.resource_saved ? '释放自己的保存引用' : '保存并保留服务器音频'}
                        >
                          {ep.resource_saved
                            ? '✓ 已保存 · 取消'
                            : ep.resource_automatic
                              ? '自动保存 · 另作手动保存'
                              : '保存到服务器'}
                        </button>
                        {ep.completed && <span className="ep-status-tag">已听完</span>}
                        {!ep.completed && ep.position_seconds > 0 && (
                          <span className="ep-status-tag">
                            已听至 {formatDuration(ep.position_seconds)}
                          </span>
                        )}
                      </div>
                      {ep.description && (
                        <div className="episode-desc-snippet">
                          {cleanPodcastDescription(ep.description)}
                        </div>
                      )}
                    </div>
                  </RowMenu>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="podcasts-overview">
          {publisherView && visiblePodcasts.length === 0 ? (
            <div className="podcasts-empty-state">
              <h3>该出品方暂无已关联节目</h3>
            </div>
          ) : personalOnly && !loading && visiblePodcasts.length === 0 ? (
            <div className="podcasts-empty-state">
              <h3>还没有关注的节目</h3>
              <p>
                {canAddPodcast
                  ? '添加感兴趣的 RSS，你的关注与收听进度会单独保存。'
                  : '这里仅显示你关注的节目。管理员尚未开放添加 RSS。'}
              </p>
              <button type="button" onClick={() => setShowSubscribeModal(true)}>
                {canAddPodcast ? '搜索或添加节目' : '搜索节目'}
              </button>
              {canManageSources && (
                <button type="button" onClick={() => setFollowingOnly(false)}>
                  浏览本服节目
                </button>
              )}
            </div>
          ) : loading && visiblePodcasts.length === 0 ? (
            <div className="podcasts-loading">正在加载节目…</div>
          ) : visiblePodcasts.length === 0 ? (
            <div className="podcasts-empty-state">
              <div className="empty-state-icon">🎙️</div>
              <h3>本服暂无节目</h3>
              <p>
                {canAddPodcast
                  ? '添加 RSS 节目后，所有用户可分别关注，服务端会统一获取最新单集。'
                  : '节目管理员添加节目后，即可浏览并关注感兴趣的节目。'}
              </p>
              {canAddPodcast && (
                <div className="preset-chips">
                  <span className="preset-label">快捷添加：</span>
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
              )}
            </div>
          ) : (
            <div className="podcasts-grid">
              {visiblePodcasts.map((p) => (
                <div
                  className="podcast-card"
                  key={p.id}
                  onClick={() => openDetail(p)}
                  onContextMenu={(e) => handleContextMenu(e, p)}
                  onKeyDown={(event) => {
                    if (
                      event.target === event.currentTarget &&
                      (event.key === 'Enter' || event.key === ' ')
                    ) {
                      event.preventDefault();
                      void openDetail(p);
                    }
                  }}
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
                        <Icon name="download" /> {p.downloaded_episodes}
                      </span>
                    )}
                  </div>
                  <div className="podcast-card-body">
                    <div className="podcast-card-heading">
                      <h4 className="podcast-card-title" title={p.title}>
                        {p.title}
                      </h4>
                      {canManageSources && (
                        <button
                          type="button"
                          className="podcast-card-menu-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleContextMenu(e, p);
                          }}
                          title="右键或点击打开设置选项"
                          aria-label={`${p.title}的节目操作`}
                        >
                          <Icon name="more" />
                        </button>
                      )}
                    </div>
                    <p className="podcast-card-author">{p.author || '未知创作者'}</p>
                    {p.publisher && (
                      <button
                        type="button"
                        className="podcast-publisher-link"
                        onClick={(event) => {
                          event.stopPropagation();
                          void openPublisher(p.publisher!);
                        }}
                      >
                        出品方：{p.publisher.name}
                      </button>
                    )}
                    <div className="podcast-card-footer">
                      <div className="podcast-card-actions">
                        <button
                          type="button"
                          className="podcast-card-action"
                          disabled={followBusy === p.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            void toggleFollow(p);
                          }}
                        >
                          {p.followed ? '取消关注' : '关注节目'}
                        </button>
                        {p.followed && (
                          <button
                            type="button"
                            className="podcast-card-action"
                            onClick={(event) => {
                              event.stopPropagation();
                              setPersonalDownload(p);
                            }}
                          >
                            自动下载
                          </button>
                        )}
                      </div>
                      <div className="podcast-card-meta">
                        <span>{p.total_episodes} 单集</span>
                        {canManageSources && (
                          <button
                            type="button"
                            className="podcast-delete-btn"
                            onClick={(e) => handleOpenSettings(p, e)}
                            title="服务器下载与存储设置"
                          >
                            <Icon name="settings" /> 设置
                          </button>
                        )}
                      </div>
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
            📥 服务器下载与存储设置…
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
          {canManageResources && (
            <div
              className="podcast-context-item"
              onClick={() => {
                setContextMenu(null);
                setSettingsPodcast(contextMenu.podcast);
                void handleCleanDownloads(contextMenu.podcast);
              }}
            >
              🧹 清理零引用音频
            </div>
          )}
          <div className="podcast-context-separator" />
          <div
            className="podcast-context-item danger"
            onClick={() => handleDelete(contextMenu.podcast)}
          >
            删除共享节目
          </div>
        </div>
      )}

      {showPlaybackSettings && playbackSettings && (
        <div className="podcasts-modal-backdrop" onClick={() => setShowPlaybackSettings(false)}>
          <div className="podcasts-modal" onClick={(event) => event.stopPropagation()}>
            <div className="podcasts-modal-header">
              <h3>播放缓存设置</h3>
              <DialogCloseButton
                className="modal-close-btn"
                aria-label="关闭播放缓存设置"
                onClick={() => setShowPlaybackSettings(false)}
              />
            </div>
            <div className="podcast-settings-section">
              <label className="podcast-checkbox-label">
                <input
                  type="checkbox"
                  checked={playbackSettings.auto_cache_current}
                  onChange={(event) =>
                    setPlaybackSettings({
                      ...playbackSettings,
                      auto_cache_current: event.target.checked,
                    })
                  }
                />
                <span>播放时自动缓存当前单集</span>
              </label>
              <label className="podcast-checkbox-label">
                <input
                  type="checkbox"
                  checked={playbackSettings.prefetch_next}
                  onChange={(event) =>
                    setPlaybackSettings({
                      ...playbackSettings,
                      prefetch_next: event.target.checked,
                    })
                  }
                />
                <span>同时预缓存下一集</span>
              </label>
              <p className="podcast-settings-desc">
                缓存任务在服务器后台执行，缓冲后即可播放，无需等整集下载完成。已有音频直接复用，播放触发的缓存会显示在「我的下载」中，并按服务器清理规则回收。
              </p>
            </div>
            <div className="podcast-settings-section">
              <label className="podcast-settings-title">网络策略</label>
              <div className="podcast-settings-radio-group">
                {[
                  { value: 'off', label: '关闭自动缓存' },
                  { value: 'wifi', label: '仅 Wi‑Fi（推荐）' },
                  { value: 'any', label: '允许所有网络' },
                ].map((option) => (
                  <label key={option.value} className="podcast-radio-label">
                    <input
                      type="radio"
                      name="podcast_network_policy"
                      value={option.value}
                      checked={playbackSettings.network_policy === option.value}
                      onChange={() =>
                        setPlaybackSettings({
                          ...playbackSettings,
                          network_policy: option.value as PodcastPlaybackSettings['network_policy'],
                        })
                      }
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
              <p className="podcast-settings-desc">
                网页无法识别网络类型时，「仅
                Wi-Fi」不会自动缓存。可以手动存入服务器，或选择允许所有网络。
                保存到服务器不等于下载到手机离线。
              </p>
            </div>
            {playbackSettingsError && (
              <p className="podcast-settings-error" role="alert">
                {playbackSettingsError}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="modal-cancel-btn"
                onClick={() => setShowPlaybackSettings(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="modal-submit-btn"
                disabled={savingPlaybackSettings}
                onClick={() => void savePlaybackSettings()}
              >
                {savingPlaybackSettings ? '保存中…' : '保存设置'}
              </button>
            </div>
          </div>
        </div>
      )}

      {personalDownload && (
        <PodcastDownloadDialog
          podcast={personalDownload}
          onClose={() => setPersonalDownload(null)}
          onSaved={(value) => {
            const update = (item: PodcastSummary) =>
              item.id === personalDownload.id
                ? {
                    ...item,
                    download_policy: value.download_policy,
                    retention_policy: value.retention_policy,
                  }
                : item;
            setPodcasts((items) => items.map(update));
            setSelectedPodcast((item) => item && update(item));
            if (selectedPodcast?.id === personalDownload.id)
              void openDetail(update(personalDownload));
            showNotice('已保存你的自动下载设置');
          }}
        />
      )}

      {settingsPodcast && (
        <dialog
          ref={settingsDialog}
          className="podcasts-modal podcast-storage-modal"
          aria-labelledby="podcast-storage-title"
          onCancel={() => setSettingsPodcast(null)}
          onClick={(event) => {
            if (event.target === event.currentTarget) setSettingsPodcast(null);
          }}
        >
          <header className="podcasts-modal-header">
            <div>
              <p className="storage-podcast-name">{settingsPodcast.title}</p>
              <h3 id="podcast-storage-title">下载与存储</h3>
            </div>
            <DialogCloseButton
              className="modal-close-btn"
              aria-label="关闭下载与存储"
              onClick={() => setSettingsPodcast(null)}
            />
          </header>
          <form
            className="podcast-storage-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSaveSettings();
            }}
          >
            <div className="podcast-storage-body">
              <section className="storage-overview" aria-label="服务器存储信息">
                {storageInfo ? (
                  <>
                    <dl className="storage-metrics">
                      <div>
                        <dt>已下载单集</dt>
                        <dd>
                          {storageInfo.downloaded_episodes}
                          <small> / {storageInfo.total_episodes} 集</small>
                        </dd>
                      </div>
                      <div>
                        <dt>服务器占用</dt>
                        <dd>{storageInfo.disk_usage_human}</dd>
                      </div>
                    </dl>
                    <details className="storage-location">
                      <summary>
                        <Icon name="folder" />
                        服务器保存位置
                      </summary>
                      <code>{storageInfo.storage_path}</code>
                      <div className="storage-copy-row">
                        <button
                          type="button"
                          className="storage-copy-btn"
                          onClick={() => handleCopyPath(storageInfo.storage_path)}
                        >
                          复制路径
                        </button>
                      </div>
                    </details>
                  </>
                ) : (
                  <p className="podcast-settings-desc" role="status">
                    {storageError || '正在读取存储信息…'}
                  </p>
                )}
              </section>

              <p className="podcast-settings-desc">
                此处管理全服的共享下载与存储。个人自动下载请使用节目的「自动下载」；清理规则在「共享音频管理」配置。
              </p>

              <details className="storage-advanced">
                <summary>下载速度与重试</summary>
                <label className="storage-slow-option">
                  <input
                    type="checkbox"
                    checked={slowDownload}
                    onChange={(event) => setSlowDownload(event.target.checked)}
                  />
                  <span>
                    <strong>平缓下载</strong>
                    <small>降低下载速度，并在单集之间稍作等待，减少被源站限流的机会。</small>
                  </span>
                </label>
                {slowDownload && (
                  <div className="storage-retry-options">
                    <label>
                      失败后重试
                      <select
                        value={maxRetries}
                        onChange={(event) => setMaxRetries(Number(event.target.value))}
                      >
                        {Array.from({ length: 11 }, (_, value) => (
                          <option key={value} value={value}>
                            {value === 0 ? '不重试' : `${value} 次`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      首次重试等待
                      <select
                        value={retryBackoffBase}
                        onChange={(event) => setRetryBackoffBase(Number(event.target.value))}
                      >
                        {[...new Set([3, 5, 10, 15, retryBackoffBase])]
                          .sort((a, b) => a - b)
                          .map((value) => (
                            <option key={value} value={value}>
                              {value} 秒
                            </option>
                          ))}
                      </select>
                    </label>
                    <p className="podcast-settings-desc">
                      再次失败会逐步延长等待，最多等待 60 秒。
                    </p>
                  </div>
                )}
              </details>

              {canManageResources && (
                <details className="storage-cleanup">
                  <summary>清理零引用音频</summary>
                  <p className="podcast-settings-desc">
                    仅回收无人保存、未受保护且未在使用的音频。会先预览数量与容量。
                  </p>
                  <button
                    type="button"
                    className="podcast-clean-btn"
                    disabled={cleaningDownloads}
                    onClick={() => void handleCleanDownloads()}
                  >
                    {cleaningDownloads ? '清理中…' : '清理零引用音频'}
                  </button>
                </details>
              )}
            </div>
            <footer className="storage-settings-footer">
              {storageNotice && (
                <p className="storage-settings-notice" role="status">
                  {storageNotice}
                </p>
              )}
              {settingsError && (
                <p className="podcast-settings-error" role="alert">
                  {settingsError}
                </p>
              )}
              <button
                type="button"
                className="modal-cancel-btn"
                onClick={() => setSettingsPodcast(null)}
              >
                取消
              </button>
              <button
                type="submit"
                className="modal-submit-btn primary"
                disabled={savingSettings || cleaningDownloads}
              >
                {savingSettings ? '保存中…' : '保存设置'}
              </button>
            </footer>
          </form>
        </dialog>
      )}
      {selectedEpisode && selectedPodcast && (
        <div className="podcasts-modal-backdrop" onClick={() => setSelectedEpisode(null)}>
          <article
            className="podcasts-modal podcast-episode-detail"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="podcasts-modal-header">
              <div>
                <span className="podcast-detail-kicker">{selectedPodcast.title}</span>
                <h3>{selectedEpisode.title}</h3>
              </div>
              <DialogCloseButton
                className="modal-close-btn"
                onClick={() => setSelectedEpisode(null)}
                aria-label="关闭详情"
              />
            </div>
            <div className="podcast-episode-detail-body">
              <div className="podcast-episode-detail-meta">
                {selectedEpisode.pub_date && <span>{selectedEpisode.pub_date.slice(0, 16)}</span>}
                {selectedEpisode.duration_seconds > 0 && (
                  <span>{formatDuration(selectedEpisode.duration_seconds)}</span>
                )}
                {selectedEpisode.download_status === 'downloaded' ? (
                  <span className="ep-download-badge">✓ 已下载</span>
                ) : (
                  <span>在线串流</span>
                )}
              </div>
              <div className="podcast-episode-detail-description">
                {renderPodcastDescription(selectedEpisode.description) || '暂无单集简介。'}
              </div>
              <div className="podcast-episode-detail-actions">
                <button
                  type="button"
                  className="podcasts-action-btn primary"
                  onClick={() => {
                    setSelectedEpisode(null);
                    playEpisode(selectedEpisode, selectedPodcast);
                  }}
                >
                  ▶ 播放单集
                </button>
                {[true, false].map((next) => (
                  <button
                    key={String(next)}
                    type="button"
                    className="podcasts-action-btn"
                    onClick={() => {
                      queueEpisode(selectedEpisode, selectedPodcast, next);
                      setSelectedEpisode(null);
                    }}
                  >
                    {next ? '下一集播放' : '加入待播'}
                  </button>
                ))}
                {
                  <button
                    type="button"
                    className="podcasts-action-btn"
                    onClick={(event) => {
                      void handleDownloadSingleEpisode(selectedEpisode, event);
                    }}
                  >
                    {selectedEpisode.resource_saved ? '取消个人保存' : '保存到服务器'}
                  </button>
                }
              </div>
            </div>
          </article>
        </div>
      )}

      {/* Subscribe / search dialog */}
      {showSubscribeModal && (
        <PodcastSearchDialog
          canAdd={canAddPodcast}
          initialQuery={modalFeedUrl}
          onClose={closeSubscribe}
          onSubscribed={handleSubscribed}
          onOpen={openFromSearch}
        />
      )}

      {showOpmlImport && (
        <PodcastOpmlImportDialog
          onClose={() => setShowOpmlImport(false)}
          onImported={() => void loadPodcasts()}
        />
      )}

      {/* Download Queue Modal */}
      {showQueueModal && (
        <dialog
          ref={downloadDialog}
          className="podcasts-modal podcast-download-modal"
          aria-labelledby="podcast-download-title"
          onCancel={() => setShowQueueModal(false)}
          onClick={() => setShowQueueModal(false)}
        >
          <div className="podcast-download-content" onClick={(e) => e.stopPropagation()}>
            <div className="podcasts-modal-header">
              <div>
                <h3 id="podcast-download-title">下载管理</h3>
                <p>保存在服务器，随时回来接着听。</p>
              </div>
              <DialogCloseButton
                className="modal-close-btn"
                aria-label="关闭下载管理"
                onClick={() => setShowQueueModal(false)}
              />
            </div>

            <div className="download-views" role="group" aria-label="下载状态">
              {(
                [
                  { value: 'active', label: '进行中', count: queueInfo?.total_pending || 0 },
                  { value: 'failed', label: '需重试', count: queueInfo?.failed_count || 0 },
                  {
                    value: 'completed',
                    label: '已完成',
                    count: queueInfo?.recent_completed.length || 0,
                  },
                ] as const
              ).map((view) => (
                <button
                  key={view.value}
                  type="button"
                  aria-pressed={activeQueueView === view.value}
                  onClick={() => setQueueView(view.value)}
                >
                  {view.label} <span>{view.count}</span>
                </button>
              ))}
            </div>

            {queueError && (
              <div className="download-error" role="alert">
                <span>{queueError}</span>
                <button type="button" onClick={() => void fetchQueue()}>
                  重新加载
                </button>
              </div>
            )}
            <div className="queue-list-container">
              {/* Failed Items Section */}
              {activeQueueView === 'failed' && queueInfo && queueInfo.failed.length > 0 && (
                <div className="queue-block">
                  <h4>
                    <span>下载失败 ({queueInfo.failed.length})</span>
                    <button
                      type="button"
                      className="podcast-toolbar-btn"
                      disabled={retryingFailed}
                      onClick={handleRetryFailed}
                    >
                      <Icon name="refresh" /> {retryingFailed ? '重试中…' : '全部重试'}
                    </button>
                  </h4>
                  <div className="queue-cards-group">
                    {queueInfo.failed.map((task) => (
                      <div className="queue-task-card failed" key={task.episode_id}>
                        <div className="queue-task-main">
                          <div className="queue-task-title">{task.episode_title}</div>
                          <div className="queue-task-sub">{task.podcast_title}</div>
                          <div className="queue-task-error">
                            {task.error || '源站下载未成功，请检查网络或重试'}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="queue-retry-single-btn"
                          onClick={() => void handleRetryDownload(task)}
                        >
                          重试
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Downloading & Queued Items Section */}
              {activeQueueView === 'active' && queueInfo && queueInfo.total_pending > 0 && (
                <div className="queue-block">
                  <h4>
                    <span>
                      {queueInfo.active_count} 集正在下载 · {queueInfo.queued_count} 集等待中
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
                              <div
                                className="queue-progress-bar-bg"
                                role="progressbar"
                                aria-label={`${task.episode_title}下载进度`}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={pct ?? undefined}
                              >
                                <div
                                  className={`queue-progress-bar-fill ${pct == null ? 'indeterminate' : ''}`}
                                  style={{ width: pct != null ? `${pct}%` : undefined }}
                                />
                              </div>
                              <div className="queue-task-metrics">
                                <span className="queue-task-speed">
                                  {task.slow_mode ? '平缓下载 · ' : ''}
                                  {task.speed_human || '正在拉取数据…'}
                                </span>
                                <span>
                                  {task.downloaded_human
                                    ? `${task.downloaded_human} / ${task.total_human || '未知'}`
                                    : '连接中…'}
                                </span>
                              </div>
                            </div>
                          </div>
                          <span
                            className={`queue-task-status ${task.status === 'retrying' ? 'queued' : 'downloading'}`}
                          >
                            {task.status === 'retrying'
                              ? `重试等待 (${task.attempt || 1}/${task.max_retries || 3})`
                              : pct != null
                                ? `${pct}%`
                                : '下载中'}
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
              )}

              {/* Recent Completed Section */}
              {activeQueueView === 'completed' &&
                queueInfo &&
                queueInfo.recent_completed.length > 0 && (
                  <div className="queue-block">
                    <h4>
                      <span>近期已完成 ({queueInfo.recent_completed.length})</span>
                      <button
                        type="button"
                        className="queue-clear-btn"
                        onClick={handleClearCompleted}
                      >
                        清除记录
                      </button>
                    </h4>
                    <div className="queue-cards-group">
                      {queueInfo.recent_completed.map((task) => (
                        <div className="queue-task-card" key={task.episode_id}>
                          <div className="queue-task-main">
                            <div className="queue-task-title">{task.episode_title}</div>
                            <div className="queue-task-sub">{task.podcast_title}</div>
                          </div>
                          <span className="queue-task-status downloaded">✓ 已下载</span>
                        </div>
                      ))}
                    </div>
                    <p className="download-records-note">清除记录不会删除已下载的音频。</p>
                  </div>
                )}

              {/* Empty State */}
              {!queueInfo && !queueError && <p className="queue-empty-state">正在加载下载状态…</p>}
              {queueInfo &&
                ((activeQueueView === 'active' && queueInfo.total_pending === 0) ||
                  (activeQueueView === 'failed' && queueInfo.failed.length === 0) ||
                  (activeQueueView === 'completed' && queueInfo.recent_completed.length === 0)) && (
                  <div className="queue-empty-state">
                    <Icon name={activeQueueView === 'completed' ? 'history' : 'download'} />
                    <strong>
                      {activeQueueView === 'active'
                        ? '当前没有下载任务'
                        : activeQueueView === 'failed'
                          ? '没有需要重试的单集'
                          : '暂无已完成记录'}
                    </strong>
                    <p>
                      {activeQueueView === 'active'
                        ? '播放时自动缓存，或从单集列表选择保存到服务器。'
                        : activeQueueView === 'failed'
                          ? '下载遇到问题时，可以在这里查看原因并重试。'
                          : '后续完成的下载会出现在这里。'}
                    </p>
                  </div>
                )}
            </div>
          </div>
        </dialog>
      )}
      {showResources && canManageResources && (
        <PodcastResourceManager onClose={() => setShowResources(false)} />
      )}
    </div>
  );
};
