import { PodcastDownloadDialog } from './podcast-download-settings';
import { PodcastCleanupCandidatesDialog, type Cleanup } from './podcast-resources';
import { PodcastDeliverySelect, PodcastInboxDialog, PodcastQueueDefaults } from './podcast-inbox';
import { useCanAddPodcast } from './podcast-catalog-settings';
import { OPML_EXPORT_URL, PodcastOpmlImportDialog } from './podcast-opml';
import {
  invalidatePodcastDiscoverCache,
  PodcastSearchPage,
  prefetchPodcastDiscover,
} from './podcast-search';
import { PodcastEpisodeDialog } from './podcast-episode-dialog';
import { DialogCloseButton } from './dialog-close';
import React, { useEffect, useState, useRef, useMemo } from 'react';
import { setEpisodeCompleted, type EpisodeProgress } from './podcast-progress';
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
import { favoritePodcastEpisode } from './podcast-remote';
import { useTranslation } from 'react-i18next';

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
  follower_count?: number;
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
  favorite?: boolean;
  favorited?: boolean;
  loved?: boolean;
  local_path?: string | null;
  download_status?: 'none' | 'queued' | 'downloading' | 'downloaded' | 'failed';
  resource_saved?: boolean;
  resource_automatic?: boolean;
  resource_playback_cached?: boolean;
}

export function isEpisodeFavorited(
  episode: Pick<PodcastEpisode, 'favorite' | 'favorited' | 'loved'> | null | undefined,
): boolean {
  if (!episode) return false;
  return Boolean(episode.favorite || episode.favorited || episode.loved);
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
  currentEpisodeId?: string | null;
  isPlayingPodcast?: boolean;
  queuedEpisodeIds?: string[];
  focusPodcastId?: string | null;
  onFocusHandled?: () => void;
  onPlayTrack: (track: Track) => void;
  onQueueTrack: (track: Track, next: boolean) => void;
  onPlayQueue?: () => void;
  onRemoveQueuedEpisode?: (episodeId: string) => void;
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
  currentEpisodeId = null,
  isPlayingPodcast = false,
  queuedEpisodeIds = [],
  focusPodcastId = null,
  onFocusHandled,
  onPlayTrack,
  onQueueTrack,
  onPlayQueue,
  onRemoveQueuedEpisode,
}) => {
  const queuedSet = useMemo(() => new Set(queuedEpisodeIds), [queuedEpisodeIds]);
  const { t } = useTranslation();
  const [podcasts, setPodcasts] = useState<PodcastSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPodcast, setSelectedPodcast] = useState<PodcastSummary | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<PodcastDetail | null>(null);
  const [publisherView, setPublisherView] = useState<PublisherDetail | null>(null);
  const [followBusy, setFollowBusy] = useState<string | null>(null);
  const overviewPodcasts = publisherView?.podcasts ?? podcasts;
  const visiblePodcasts = overviewPodcasts.filter((podcast) => podcast.followed);
  const [selectedEpisode, setSelectedEpisode] = useState<PodcastEpisode | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [exploring, setExploring] = useState(false);
  const [showOpmlImport, setShowOpmlImport] = useState(false);
  const [showInbox, setShowInbox] = useState(false);
  const canAddPodcast = useCanAddPodcast(userId, canManageSources);
  const [modalFeedUrl, setModalFeedUrl] = useState('');
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [playbackSettings, setPlaybackSettings] = useState<PodcastPlaybackSettings | null>(null);
  const [showPlaybackSettings, setShowPlaybackSettings] = useState(false);
  const [savingPlaybackSettings, setSavingPlaybackSettings] = useState(false);
  const [playbackSettingsError, setPlaybackSettingsError] = useState<string | null>(null);

  // Download queue state
  const [queueInfo, setQueueInfo] = useState<DownloadQueueInfo | null>(null);
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
  const [cleanupState, setCleanupState] = useState<{
    podcast: PodcastSummary;
    preview: Cleanup;
    returnToSettings: boolean;
  } | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageNotice, setStorageNotice] = useState<string | null>(null);

  // Episodes sort & filter state
  const [sortField, setSortField] = useState<'pub_date' | 'episode_number' | 'duration' | 'title'>(
    'pub_date',
  );
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [filterMode, setFilterMode] = useState<'all' | 'unplayed' | 'favorited'>('all');
  const filterUnplayed = filterMode === 'unplayed';
  const [episodeScope, setEpisodeScope] = useState<EpisodeScope>(() => readEpisodeScope(userId));
  const [searchQuery, setSearchQuery] = useState('');

  const menuRef = useRef<HTMLDivElement | null>(null);
  const headerMenuRef = useRef<HTMLDetailsElement | null>(null);
  const settingsDialog = useRef<HTMLDialogElement | null>(null);
  const closeHeaderMenu = () => {
    headerMenuRef.current?.removeAttribute('open');
  };
  const previousCompleted = useRef<string | null>(null);
  const completedRevision =
    queueInfo?.recent_completed
      .map((task) => `${task.episode_id}:${task.completed_at}`)
      .join('|') || '';

  useEffect(() => setEpisodeScope(readEpisodeScope(userId)), [userId]);
  useEffect(() => {
    const updated = (event: Event) => {
      const progress = (event as CustomEvent<EpisodeProgress>).detail;
      if (!progress) return;
      setSelectedDetail((detail) => {
        if (!detail) return detail;
        const episodes = detail.episodes.map((episode) =>
          episode.id === progress.episode_id
            ? {
                ...episode,
                position_seconds: progress.position_seconds,
                completed: progress.completed,
              }
            : episode,
        );
        const unplayed = episodes.filter((episode) => !episode.completed).length;
        const nextPodcast = { ...detail.podcast, unplayed_episodes: unplayed };
        setSelectedPodcast((current) => (current?.id === nextPodcast.id ? nextPodcast : current));
        setPodcasts((items) =>
          items.map((item) =>
            item.id === nextPodcast.id ? { ...item, unplayed_episodes: unplayed } : item,
          ),
        );
        return {
          ...detail,
          podcast: nextPodcast,
          episodes,
        };
      });
      setSelectedEpisode((current) =>
        current?.id === progress.episode_id
          ? {
              ...current,
              position_seconds: progress.position_seconds,
              completed: progress.completed,
            }
          : current,
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
        if (active) setStorageError(t('podcasts.storageInfoLoadFailed'));
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
  const sortOrderLabels: Record<typeof sortField, { asc: string; desc: string }> = {
    pub_date: { asc: t('podcasts.sortPubDateAsc'), desc: t('podcasts.sortPubDateDesc') },
    episode_number: { asc: t('podcasts.sortEpisodeAsc'), desc: t('podcasts.sortEpisodeDesc') },
    duration: { asc: t('podcasts.sortDurationAsc'), desc: t('podcasts.sortDurationDesc') },
    title: { asc: t('podcasts.sortTitleAsc'), desc: t('podcasts.sortTitleDesc') },
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

    if (filterMode === 'unplayed') {
      list = list.filter((ep) => !ep.completed);
    } else if (filterMode === 'favorited') {
      list = list.filter((ep) => isEpisodeFavorited(ep));
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
  }, [selectedDetail?.episodes, sortField, sortOrder, filterMode, episodeScope, searchQuery]);

  const showNotice = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 3000);
  };

  const loadPodcasts = async (background = false) => {
    try {
      if (!background) setLoading(true);
      const res = await api<PodcastSummary[]>('/podcasts?followed=true');
      setPodcasts(res);
    } catch (e) {
      showNotice(e instanceof Error ? e.message : t('podcasts.loadSubscriptionsFailed'));
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
      showNotice(e instanceof Error ? e.message : t('podcasts.loadEpisodeFailed'));
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
      invalidatePodcastDiscoverCache();
      showNotice(result.followed ? t('podcasts.followed') : t('podcasts.unfollowed'));
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : t('podcasts.followSaveFailed'));
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
      showNotice(reason instanceof Error ? reason.message : t('podcasts.publisherShowsLoadFailed'));
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
    showNotice(t('podcasts.publisherSaved'));
  };

  const handleRefreshPodcast = async (id: string) => {
    try {
      setDetailLoading(true);
      const detail = await api<PodcastDetail>(`/podcasts/${encodeURIComponent(id)}/refresh`, {
        method: 'POST',
      });
      setSelectedDetail(detail);
      showNotice(t('podcasts.refreshDone'));
    } catch (e) {
      showNotice(e instanceof Error ? e.message : t('podcasts.refreshFailed'));
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
      showNotice(t('podcasts.refreshAllDone', { count: res.refreshed_count }));
      await loadPodcasts(true);
    } catch (e) {
      showNotice(e instanceof Error ? e.message : t('podcasts.refreshAllFailed'));
    } finally {
      setRefreshingAll(false);
    }
  };

  const openById = async (id: string) => {
    try {
      setDetailLoading(true);
      const detail = await api<PodcastDetail>(`/podcasts/${encodeURIComponent(id)}`);
      setPublisherView(null);
      setShowSearch(false);
      setSelectedDetail(detail);
      setSelectedPodcast(detail.podcast);
    } catch (e) {
      showNotice(e instanceof Error ? e.message : t('podcasts.loadEpisodeFailed'));
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    if (!focusPodcastId) return;
    void openById(focusPodcastId);
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPodcastId]);

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
        () => setStorageNotice(t('podcasts.pathCopied')),
        () => setStorageNotice(t('podcasts.copyFailed')),
      );
    } else {
      setStorageNotice(t('podcasts.copyUnsupported'));
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
      showNotice(t('podcasts.playbackSettingsSaved'));
    } catch (err) {
      setPlaybackSettingsError(
        err instanceof Error ? err.message : t('podcasts.playbackSettingsSaveFailed'),
      );
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
      showNotice(t('podcasts.serverSettingsSaved', { title: updated.podcast.title }));
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
      setSettingsError(err instanceof Error ? err.message : t('podcasts.settingsSaveFailed'));
    } finally {
      setSavingSettings(false);
    }
  };

  const handleCleanDownloads = async (targetPodcast?: PodcastSummary) => {
    const podcast = targetPodcast || settingsPodcast;
    if (!podcast || !canManageResources) return;
    const returnToSettings = !targetPodcast && settingsPodcast?.id === podcast.id;
    try {
      setCleaningDownloads(true);
      setSettingsError(null);
      setStorageNotice(null);
      const preview = await api<Cleanup>('/podcasts/resources/cleanup', {
        method: 'POST',
        body: JSON.stringify({ dry_run: true, podcast_id: podcast.id }),
      });
      if (returnToSettings) {
        setSettingsPodcast(null);
      }
      setCleanupState({ podcast, preview, returnToSettings });
    } catch (err) {
      const message = err instanceof Error ? err.message : t('podcasts.cleanFailed');
      if (returnToSettings) setSettingsError(message);
      else showNotice(message);
    } finally {
      setCleaningDownloads(false);
    }
  };

  const confirmCleanDownloads = async () => {
    if (!cleanupState || !canManageResources) return;
    const { podcast, returnToSettings } = cleanupState;
    try {
      setCleaningDownloads(true);
      const res = await api<{ deleted_count: number; freed_bytes: number }>(
        `/podcasts/${encodeURIComponent(podcast.id)}/clean-downloads`,
        { method: 'POST' },
      );
      const message = t('podcasts.cleanedFreed', {
        count: res.deleted_count,
        size: (res.freed_bytes / 1024 / 1024).toFixed(1),
      });
      setCleanupState(null);
      if (returnToSettings) {
        setSettingsPodcast(podcast);
        setStorageNotice(message);
      } else {
        showNotice(message);
      }
      const info = await api<PodcastStorageInfo>(
        `/podcasts/${encodeURIComponent(podcast.id)}/storage`,
      );
      setStorageInfo(info);
      await loadPodcasts();
      if (selectedPodcast?.id === podcast.id) {
        await openDetail(podcast);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t('podcasts.cleanFailed');
      setCleanupState(null);
      if (returnToSettings) {
        setSettingsPodcast(podcast);
        setSettingsError(message);
      } else {
        showNotice(message);
      }
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
      setQueueError(err instanceof Error ? err.message : t('podcasts.queueLoadFailed'));
    }
  };

  useEffect(() => {
    if (!canManageSources) return;
    void fetchQueue();
    const intervalTime = queueInfo && queueInfo.total_pending > 0 ? 5000 : 12000;
    const timer = setInterval(() => {
      void fetchQueue();
    }, intervalTime);
    return () => clearInterval(timer);
  }, [queueInfo?.total_pending, canManageSources]);

  const handleDownloadAll = async (p: PodcastSummary) => {
    setContextMenu(null);
    try {
      showNotice(t('podcasts.queueingAll', { title: p.title }));
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
      showNotice(err instanceof Error ? err.message : t('podcasts.downloadAllFailed'));
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
          ? t('podcasts.unsavedNotice')
          : result.reused
            ? t('podcasts.reusedNotice')
            : t('podcasts.savedPreparing'),
      );
    } catch (err) {
      showNotice(err instanceof Error ? err.message : t('podcasts.saveEpisodeFailed'));
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
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target as Node)) {
        headerMenuRef.current.removeAttribute('open');
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
        setSettingsPodcast(null);
        headerMenuRef.current?.removeAttribute('open');
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
    setExploring(false);
    setShowSearch(false);
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
    showNotice(t('podcasts.followedByTitle', { title: title }));
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
    showNotice(next ? t('podcasts.playNextQueued') : t('podcasts.addedToQueue'));
  };

  const toggleEpisodeCompleted = async (ep: PodcastEpisode) => {
    const nextCompleted = !ep.completed;
    try {
      await setEpisodeCompleted(userId, ep.id, ep.duration_seconds, nextCompleted);
      showNotice(nextCompleted ? t('podcasts.markedCompleted') : t('podcasts.markedUnplayed'));
    } catch {
      showNotice(t('podcasts.progressUpdateFailed'));
    }
  };

  const toggleEpisodeFavorite = async (ep: PodcastEpisode) => {
    const currentFav = isEpisodeFavorited(ep);
    const targetFav = !currentFav;
    try {
      await favoritePodcastEpisode(ep.id, targetFav);
      setSelectedDetail((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          episodes: prev.episodes.map((item) =>
            item.id === ep.id
              ? { ...item, favorite: targetFav, loved: targetFav, favorited: targetFav }
              : item,
          ),
        };
      });
      setSelectedEpisode((prev) =>
        prev && prev.id === ep.id
          ? { ...prev, favorite: targetFav, loved: targetFav, favorited: targetFav }
          : prev,
      );
      showNotice(targetFav ? t('podcasts.favoriteAdded') : t('podcasts.favoriteRemoved'));
    } catch {
      showNotice(t('podcasts.favoriteUpdateFailed'));
    }
  };

  useEffect(() => {
    void loadPodcasts();
    void loadPlaybackSettings();
  }, []);

  useEffect(() => {
    if (showSearch || selectedPodcast) return;
    const timer = window.setTimeout(() => {
      prefetchPodcastDiscover();
    }, 800);
    return () => window.clearTimeout(timer);
  }, [showSearch, selectedPodcast]);

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
                ? t('podcasts.backToPublisher', { name: publisherView.publisher.name })
                : t('podcasts.backToStationList')}
            </button>
          ) : (
            <h2>{t('podcasts.title')}</h2>
          )}
          {!selectedPodcast && publisherView && (
            <>
              <h2>{publisherView.publisher.name}</h2>
              <p className="publisher-help">
                {t('podcasts.publisherFollowedCount', { count: visiblePodcasts.length })}
              </p>
            </>
          )}
        </div>

        <div className="podcasts-actions">
          {!selectedPodcast && canManageSources && (
            <button
              type="button"
              className="podcasts-action-btn"
              disabled={refreshingAll || loading}
              onClick={handleRefreshAll}
              title={t('podcasts.refreshAllTitle')}
            >
              <Icon name="podcast" />{' '}
              {refreshingAll ? t('podcasts.refreshing') : t('podcasts.refreshAll')}
            </button>
          )}
          {!selectedPodcast && (
            <button
              type="button"
              className="podcasts-action-btn primary"
              onClick={() => {
                setExploring(false);
                setShowSearch(true);
              }}
            >
              {canAddPodcast ? t('podcasts.addShow') : t('podcasts.searchShows')}
            </button>
          )}
          {queuedSet.size > 0 && onPlayQueue && (
            <button
              type="button"
              className="podcasts-action-btn"
              onClick={() => {
                onPlayQueue();
                showNotice(t('podcasts.queuePlaybackStarted'));
              }}
              title={t('podcasts.playQueueTitle')}
            >
              {t('podcasts.playQueueBtn', { count: queuedSet.size })}
            </button>
          )}
          <button
            type="button"
            className="podcasts-action-btn"
            onClick={() => setShowInbox(true)}
            title={t('podcasts.inboxTitle')}
          >
            {t('podcasts.inbox')}
          </button>
          <details className="podcasts-more-menu" ref={headerMenuRef}>
            <summary
              className={`podcasts-action-btn podcasts-more-trigger`}
              aria-label={t('podcasts.moreActions')}
              title={t('podcasts.moreMenuTitle')}
            >
              <Icon name="more" />
            </summary>
            <div className="podcasts-more-popover">
              <button
                type="button"
                className="podcasts-more-item"
                onClick={() => {
                  closeHeaderMenu();
                  setPlaybackSettingsError(null);
                  setShowPlaybackSettings(true);
                }}
                title={t('podcasts.autoCacheTitle')}
              >
                {t('podcasts.playbackCache')}
              </button>
              {!selectedPodcast && canAddPodcast && (
                <button
                  type="button"
                  className="podcasts-more-item"
                  onClick={() => {
                    closeHeaderMenu();
                    setShowOpmlImport(true);
                  }}
                  title={t('podcasts.opmlImportTitle')}
                >
                  {t('podcasts.importOpml')}
                </button>
              )}
              {!selectedPodcast && (
                <a
                  className="podcasts-more-item"
                  href={OPML_EXPORT_URL}
                  download="wildstring-podcasts.opml"
                  onClick={() => closeHeaderMenu()}
                  title={t('podcasts.opmlExportTitle')}
                >
                  {t('podcasts.exportOpml')}
                </a>
              )}
            </div>
          </details>
        </div>
      </div>

      {!selectedPodcast && !publisherView && (
        <div
          className="podcast-catalog-tabs"
          role="group"
          aria-label={t('podcasts.catalogTabsLabel')}
        >
          <button
            type="button"
            aria-pressed={!showSearch}
            onClick={() => {
              closeSubscribe();
            }}
          >
            {t('podcasts.myFollows')}
          </button>
          <button
            type="button"
            aria-pressed={showSearch}
            onClick={() => {
              setExploring(true);
              setShowSearch(true);
            }}
          >
            {t('podcasts.discoverPodcasts')}
          </button>
        </div>
      )}

      {showSearch && !selectedPodcast && !publisherView ? (
        <PodcastSearchPage
          canAdd={canAddPodcast}
          initialQuery={modalFeedUrl}
          initialExplore={exploring}
          onClose={closeSubscribe}
          onSubscribed={handleSubscribed}
          onOpen={openFromSearch}
        />
      ) : selectedPodcast ? (
        <div className="podcast-detail-view">
          <div className="podcast-meta-card">
            <div className="podcast-meta-cover">
              {selectedPodcast.cover_url ? (
                <img src={selectedPodcast.cover_url} alt={selectedPodcast.title} />
              ) : (
                <div className="podcast-cover-placeholder">
                  <Icon name="podcast" />
                </div>
              )}
            </div>
            <div className="podcast-meta-info">
              <div className="podcast-meta-top">
                <div className="podcast-meta-heading">
                  <h3>{selectedPodcast.title}</h3>
                  <div className="podcast-meta-subline">
                    <p className="podcast-meta-author">
                      {selectedPodcast.author || t('podcasts.unknownAuthor')}
                    </p>
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
                      {t('podcasts.autoDownload')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="podcast-refresh-btn"
                    disabled={followBusy === selectedPodcast.id}
                    onClick={() => void toggleFollow(selectedPodcast)}
                  >
                    {selectedPodcast.followed ? t('podcasts.unfollow') : t('podcasts.follow')}
                  </button>
                </div>
              </div>
              <div className="podcast-meta-desc">
                {renderPodcastDescription(selectedPodcast.description) ||
                  t('podcasts.noDescription')}
              </div>
              <div className="podcast-meta-footer">
                <div className="podcast-meta-stats">
                  <span>
                    {t('podcasts.totalEpisodes', { count: selectedPodcast.total_episodes })}
                  </span>
                  {selectedPodcast.downloaded_episodes > 0 && (
                    <span className="ep-download-badge">
                      {t('podcasts.downloadedEpisodesBadge', {
                        count: selectedPodcast.downloaded_episodes,
                      })}
                    </span>
                  )}
                  {selectedPodcast.unplayed_episodes > 0 && (
                    <span className="unplayed-tag">
                      {t('podcasts.unplayedCount', { count: selectedPodcast.unplayed_episodes })}
                    </span>
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
                      {detailLoading ? t('podcasts.syncing') : t('podcasts.syncNow')}
                    </button>
                    <button
                      type="button"
                      className="podcast-refresh-btn"
                      onClick={() => handleOpenSettings(selectedPodcast)}
                    >
                      {t('podcasts.storageSettings')}
                    </button>
                  </div>
                )}
              </div>
              <PodcastDeliverySelect showId={selectedPodcast.id} />
            </div>
          </div>

          <div className="podcast-episodes-section">
            <div className="podcast-episodes-header">
              <h4>
                {t('podcasts.episodesTitle')}
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
                  placeholder={t('podcasts.searchEpisodesPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />

                <div
                  className="podcast-sort-control"
                  role="group"
                  aria-label={t('podcasts.sortGroupLabel')}
                >
                  <select
                    className="podcast-select"
                    value={sortField}
                    onChange={(e) => setSortField(e.target.value as typeof sortField)}
                    aria-label={t('podcasts.sortBy')}
                    title={t('podcasts.sortByTitle')}
                  >
                    <option value="pub_date">{t('podcasts.sortPubDate')}</option>
                    <option value="episode_number">{t('podcasts.sortEpisodeNumber')}</option>
                    <option value="duration">{t('podcasts.sortDuration')}</option>
                    <option value="title">{t('podcasts.sortTitle')}</option>
                  </select>
                  <button
                    type="button"
                    className="podcast-sort-direction"
                    onClick={() => setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')}
                    aria-label={t('podcasts.sortDirectionAria', {
                      current: currentSortOrderLabel,
                      next: nextSortOrderLabel,
                    })}
                    title={t('podcasts.sortDirectionTitle', {
                      current: currentSortOrderLabel,
                      next: nextSortOrderLabel,
                    })}
                  >
                    <span aria-hidden="true">{sortOrder === 'desc' ? '↓' : '↑'}</span>
                  </button>
                </div>

                <button
                  type="button"
                  className={`podcast-toolbar-btn ${filterMode === 'all' ? 'active' : ''}`}
                  onClick={() => setFilterMode('all')}
                  title={t('podcasts.filterAllTitle')}
                >
                  {t('podcasts.filterAll')}
                </button>
                <button
                  type="button"
                  className={`podcast-toolbar-btn ${filterMode === 'unplayed' ? 'active' : ''}`}
                  onClick={() => setFilterMode(filterMode === 'unplayed' ? 'all' : 'unplayed')}
                  title={t('podcasts.filterUnplayedTitle')}
                >
                  <Icon name="history" /> {t('podcasts.filterUnplayed')}
                </button>
                <button
                  type="button"
                  className={`podcast-toolbar-btn ${filterMode === 'favorited' ? 'active' : ''}`}
                  onClick={() => setFilterMode(filterMode === 'favorited' ? 'all' : 'favorited')}
                  title={t('podcasts.filterFavoritedTitle')}
                >
                  <Icon name="heart" /> {t('podcasts.filterFavorited')}
                </button>
              </div>
            </div>

            <div
              className="podcast-episode-scope"
              role="group"
              aria-label={t('podcasts.scopeGroupLabel')}
            >
              <button
                type="button"
                aria-pressed={episodeScope === 'saved'}
                onClick={() => changeEpisodeScope('saved')}
              >
                {t('podcasts.myDownloads')} <span>{personalDownloadCount}</span>
              </button>
              <button
                type="button"
                aria-pressed={episodeScope === 'downloaded'}
                onClick={() => changeEpisodeScope('downloaded')}
                title={t('podcasts.serverDownloadsTitle')}
              >
                {t('podcasts.serverDownloads')} <span>{downloadedCount}</span>
              </button>
              <button
                type="button"
                aria-pressed={episodeScope === 'all'}
                onClick={() => changeEpisodeScope('all')}
              >
                {t('podcasts.allEpisodes')} <span>{selectedDetail?.episodes.length || 0}</span>
              </button>
            </div>

            {episodeScope === 'saved' && (
              <p className="download-records-note">{t('podcasts.savedScopeNote')}</p>
            )}

            {detailLoading && !selectedDetail ? (
              <div className="podcasts-loading">{t('podcasts.loadingEpisodes')}</div>
            ) : displayedEpisodes.length === 0 ? (
              <div className="podcasts-empty">
                {episodeScope === 'saved' && personalDownloadCount === 0 ? (
                  <>
                    <p>{t('podcasts.emptyMyDownloads')}</p>
                    <p>{t('podcasts.emptyMyDownloadsHint')}</p>
                    <button
                      type="button"
                      className="podcasts-action-btn"
                      onClick={() => changeEpisodeScope('all')}
                    >
                      {t('podcasts.browseAllEpisodes')}
                    </button>
                  </>
                ) : episodeScope === 'downloaded' && downloadedCount === 0 ? (
                  <>
                    <p>{t('podcasts.emptyDownloaded')}</p>
                    <p>{t('podcasts.emptyDownloadedHint')}</p>
                    <button
                      type="button"
                      className="podcasts-action-btn"
                      onClick={() => changeEpisodeScope('all')}
                    >
                      {t('podcasts.browseAllEpisodes')}
                    </button>
                  </>
                ) : selectedDetail?.episodes.length === 0 ? (
                  t('podcasts.noEpisodes')
                ) : (
                  t('podcasts.noMatchingEpisodes')
                )}
              </div>
            ) : (
              <div className="podcast-episodes-list">
                {displayedEpisodes.map((ep) => (
                  <RowMenu
                    className={`podcast-episode-row${ep.completed ? ' completed' : ''}`}
                    key={ep.id}
                    label={ep.title}
                    actions={[
                      {
                        label: t('podcasts.playEpisode'),
                        icon: 'play',
                        run: () => playEpisode(ep, selectedPodcast),
                      },
                      {
                        label: t('podcasts.playNext'),
                        icon: 'next',
                        run: () => queueEpisode(ep, selectedPodcast, true),
                      },
                      {
                        label: t('podcasts.addToQueue'),
                        icon: 'queue',
                        run: () => queueEpisode(ep, selectedPodcast, false),
                      },
                      {
                        label: ep.completed
                          ? t('podcasts.markUnplayed')
                          : t('podcasts.markCompleted'),
                        icon: 'select',
                        run: () => {
                          void toggleEpisodeCompleted(ep);
                        },
                      },
                      {
                        label: isEpisodeFavorited(ep)
                          ? t('podcasts.unfavorite')
                          : t('podcasts.favorite'),
                        icon: 'heart',
                        run: () => {
                          void toggleEpisodeFavorite(ep);
                        },
                      },
                      {
                        label: ep.resource_saved
                          ? t('podcasts.unsave')
                          : t('podcasts.saveToServer'),
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
                      title={t('podcasts.playEpisodeTitle')}
                    >
                      ▶
                    </button>
                    <div className="episode-main-info">
                      <button
                        type="button"
                        className="episode-title episode-title-button"
                        onClick={() => setSelectedEpisode(ep)}
                        title={t('podcasts.episodeDetailsTitle')}
                      >
                        {ep.title}
                      </button>
                      <div className="episode-sub-meta">
                        {ep.pub_date && <span className="ep-date">{ep.pub_date.slice(0, 16)}</span>}
                        {ep.duration_seconds > 0 && (
                          <span className="ep-duration">{formatDuration(ep.duration_seconds)}</span>
                        )}
                        {ep.download_status === 'downloaded' && (
                          <span
                            className="ep-download-badge"
                            title={t('podcasts.serverBadgeTitle')}
                          >
                            {t('podcasts.serverBadge')}
                          </span>
                        )}
                        {['downloading', 'queued'].includes(ep.download_status || '') && (
                          <span className="ep-download-badge">{t('podcasts.preparing')}</span>
                        )}
                        {ep.resource_playback_cached &&
                          !ep.resource_saved &&
                          !ep.resource_automatic && (
                            <span className="ep-status-tag">{t('podcasts.playbackCache')}</span>
                          )}
                        <button
                          type="button"
                          className="ep-download-btn"
                          onClick={(e) => void handleDownloadSingleEpisode(ep, e)}
                          title={
                            ep.resource_saved
                              ? t('podcasts.releaseSaveRef')
                              : t('podcasts.saveKeepAudio')
                          }
                        >
                          {ep.resource_saved
                            ? t('podcasts.savedCancel')
                            : ep.resource_automatic
                              ? t('podcasts.autoSavedManual')
                              : t('podcasts.saveToServer')}
                        </button>
                        {ep.completed && (
                          <span className="ep-status-tag">{t('podcasts.playedBadge')}</span>
                        )}
                        {!ep.completed && ep.position_seconds > 0 && (
                          <span className="ep-status-tag">
                            {t('podcasts.playedUpTo', {
                              time: formatDuration(ep.position_seconds),
                            })}
                          </span>
                        )}
                      </div>
                      {ep.description && (
                        <div className="episode-desc-snippet">
                          {cleanPodcastDescription(ep.description)}
                        </div>
                      )}
                    </div>
                    <div className="episode-row-actions">
                      <button
                        type="button"
                        className={`episode-queue-btn${
                          currentEpisodeId === ep.id && isPlayingPodcast
                            ? ' active'
                            : queuedSet.has(ep.id)
                              ? ' queued'
                              : ''
                        }`}
                        aria-pressed={
                          !(currentEpisodeId === ep.id && isPlayingPodcast) && queuedSet.has(ep.id)
                        }
                        disabled={currentEpisodeId === ep.id && isPlayingPodcast}
                        onClick={() => {
                          if (queuedSet.has(ep.id) && onRemoveQueuedEpisode) {
                            onRemoveQueuedEpisode(ep.id);
                            showNotice(t('podcasts.removedFromQueue'));
                          } else {
                            queueEpisode(ep, selectedPodcast, false);
                          }
                        }}
                        title={
                          currentEpisodeId === ep.id && isPlayingPodcast
                            ? t('podcasts.queueStatePlaying')
                            : queuedSet.has(ep.id)
                              ? t('podcasts.queueStateRemove')
                              : t('podcasts.queueStateAdd')
                        }
                      >
                        {currentEpisodeId === ep.id && isPlayingPodcast
                          ? t('podcasts.nowPlaying')
                          : queuedSet.has(ep.id)
                            ? t('podcasts.queuedBadge')
                            : t('podcasts.addToQueueBtn')}
                      </button>
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
              <h3>{t('podcasts.publisherEmpty')}</h3>
            </div>
          ) : !loading && visiblePodcasts.length === 0 ? (
            <div className="podcasts-empty-state">
              <h3>{t('podcasts.emptyFollows')}</h3>
              <p>
                {canAddPodcast ? t('podcasts.emptyFollowsCanAdd') : t('podcasts.emptyFollowsNoAdd')}
              </p>
              <div className="podcasts-empty-actions">
                <button type="button" onClick={() => setShowSearch(true)}>
                  {canAddPodcast ? t('podcasts.searchOrAddShows') : t('podcasts.searchShows')}
                </button>
              </div>
            </div>
          ) : loading && visiblePodcasts.length === 0 ? (
            <div className="podcasts-loading">{t('podcasts.loadingShows')}</div>
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
                      <div className="podcast-cover-placeholder">
                        <Icon name="podcast" />
                      </div>
                    )}
                    {p.downloaded_episodes > 0 && (
                      <span
                        className="podcast-badge-count"
                        title={t('podcasts.cardDownloadedTitle', { count: p.downloaded_episodes })}
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
                          title={t('podcasts.cardMenuTitle')}
                          aria-label={t('podcasts.cardMenuAria', { title: p.title })}
                        >
                          <Icon name="more" />
                        </button>
                      )}
                    </div>
                    <p className="podcast-card-author">
                      {p.author || t('podcasts.unknownCreator')}
                    </p>
                    {p.publisher && (
                      <button
                        type="button"
                        className="podcast-publisher-link"
                        onClick={(event) => {
                          event.stopPropagation();
                          void openPublisher(p.publisher!);
                        }}
                      >
                        {t('podcasts.publisherLabel', { name: p.publisher.name })}
                      </button>
                    )}
                    <div className="podcast-card-footer">
                      <div className="podcast-card-meta">
                        <span className="podcast-card-ep-count">
                          {t('podcasts.episodeCount', { count: p.total_episodes })}
                          {p.unplayed_episodes > 0 && (
                            <span className="podcast-card-unplayed">
                              {t('podcasts.unplayedCount', { count: p.unplayed_episodes })}
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="podcast-card-actions">
                        <button
                          type="button"
                          className={`podcast-card-action${p.followed ? '' : ' primary'}`}
                          disabled={followBusy === p.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            void toggleFollow(p);
                          }}
                        >
                          {p.followed ? t('podcasts.unfollow') : t('podcasts.follow')}
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
                            {t('podcasts.autoDownload')}
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
            {t('podcasts.contextServerSettings')}
          </div>
          <div
            className="podcast-context-item"
            onClick={() => handleDownloadAll(contextMenu.podcast)}
          >
            {t('podcasts.contextDownloadAll')}
          </div>
          <div
            className="podcast-context-item"
            onClick={() => {
              setContextMenu(null);
              void handleRefreshPodcast(contextMenu.podcast.id);
            }}
          >
            {t('podcasts.contextRefresh')}
          </div>
        </div>
      )}

      {showPlaybackSettings && playbackSettings && (
        <div className="podcasts-modal-backdrop" onClick={() => setShowPlaybackSettings(false)}>
          <div className="podcasts-modal" onClick={(event) => event.stopPropagation()}>
            <div className="podcasts-modal-header">
              <h3>{t('podcasts.playbackSettingsTitle')}</h3>
              <DialogCloseButton
                className="modal-close-btn"
                aria-label={t('podcasts.closePlaybackSettings')}
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
                <span>{t('podcasts.autoCacheCurrent')}</span>
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
                <span>{t('podcasts.prefetchNext')}</span>
              </label>
              <p className="podcast-settings-desc">{t('podcasts.cacheDesc')}</p>
            </div>
            <div className="podcast-settings-section">
              <label className="podcast-settings-title">{t('podcasts.networkPolicy')}</label>
              <div className="podcast-settings-radio-group">
                {[
                  { value: 'off', label: t('podcasts.networkOff') },
                  { value: 'wifi', label: t('podcasts.networkWifi') },
                  { value: 'any', label: t('podcasts.networkAny') },
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
              <p className="podcast-settings-desc">{t('podcasts.networkNote')}</p>
            </div>
            <PodcastQueueDefaults />
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
                {t('podcasts.cancel')}
              </button>
              <button
                type="button"
                className="modal-submit-btn"
                disabled={savingPlaybackSettings}
                onClick={() => void savePlaybackSettings()}
              >
                {savingPlaybackSettings ? t('podcasts.saving') : t('podcasts.saveSettings')}
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
            showNotice(t('podcasts.autoDownloadSaved'));
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
              <h3 id="podcast-storage-title">{t('podcasts.storageDialogTitle')}</h3>
            </div>
            <DialogCloseButton
              className="modal-close-btn"
              aria-label={t('podcasts.closeStorageDialog')}
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
              <section className="storage-overview" aria-label={t('podcasts.storageOverview')}>
                {storageInfo ? (
                  <>
                    <dl className="storage-metrics">
                      <div>
                        <dt>{t('podcasts.downloadedEpisodesLabel')}</dt>
                        <dd>
                          {storageInfo.downloaded_episodes}
                          <small>
                            {t('podcasts.ofTotalEpisodes', { count: storageInfo.total_episodes })}
                          </small>
                        </dd>
                      </div>
                      <div>
                        <dt>{t('podcasts.serverUsage')}</dt>
                        <dd>{storageInfo.disk_usage_human}</dd>
                      </div>
                    </dl>
                    <details className="storage-location">
                      <summary>
                        <Icon name="folder" />
                        {t('podcasts.serverLocation')}
                      </summary>
                      <code>{storageInfo.storage_path}</code>
                      <div className="storage-copy-row">
                        <button
                          type="button"
                          className="storage-copy-btn"
                          onClick={() => handleCopyPath(storageInfo.storage_path)}
                        >
                          {t('podcasts.copyPath')}
                        </button>
                      </div>
                    </details>
                  </>
                ) : (
                  <p className="podcast-settings-desc" role="status">
                    {storageError || t('podcasts.readingStorage')}
                  </p>
                )}
              </section>

              <p className="podcast-settings-desc">{t('podcasts.serverStorageNote')}</p>

              <details className="storage-advanced">
                <summary>{t('podcasts.speedAndRetry')}</summary>
                <label className="storage-slow-option">
                  <input
                    type="checkbox"
                    checked={slowDownload}
                    onChange={(event) => setSlowDownload(event.target.checked)}
                  />
                  <span>
                    <strong>{t('podcasts.gentleDownload')}</strong>
                    <small>{t('podcasts.gentleDownloadHint')}</small>
                  </span>
                </label>
                {slowDownload && (
                  <div className="storage-retry-options">
                    <label>
                      {t('podcasts.retryAfterFail')}
                      <select
                        value={maxRetries}
                        onChange={(event) => setMaxRetries(Number(event.target.value))}
                      >
                        {Array.from({ length: 11 }, (_, value) => (
                          <option key={value} value={value}>
                            {value === 0
                              ? t('podcasts.noRetry')
                              : t('podcasts.retryCount', { count: value })}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {t('podcasts.firstRetryWait')}
                      <select
                        value={retryBackoffBase}
                        onChange={(event) => setRetryBackoffBase(Number(event.target.value))}
                      >
                        {[...new Set([3, 5, 10, 15, retryBackoffBase])]
                          .sort((a, b) => a - b)
                          .map((value) => (
                            <option key={value} value={value}>
                              {t('podcasts.seconds', { count: value })}
                            </option>
                          ))}
                      </select>
                    </label>
                    <p className="podcast-settings-desc">{t('podcasts.backoffNote')}</p>
                  </div>
                )}
              </details>

              {canManageResources && (
                <details className="storage-cleanup">
                  <summary>{t('podcasts.cleanupTitle')}</summary>
                  <p className="podcast-settings-desc">{t('podcasts.cleanupDesc')}</p>
                  <button
                    type="button"
                    className="podcast-clean-btn"
                    disabled={cleaningDownloads}
                    onClick={() => void handleCleanDownloads()}
                  >
                    {cleaningDownloads ? t('podcasts.cleaning') : t('podcasts.cleanupTitle')}
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
                {t('podcasts.cancel')}
              </button>
              <button
                type="submit"
                className="modal-submit-btn primary"
                disabled={savingSettings || cleaningDownloads}
              >
                {savingSettings ? t('podcasts.saving') : t('podcasts.saveSettings')}
              </button>
            </footer>
          </form>
        </dialog>
      )}
      {selectedEpisode && selectedPodcast && (
        <PodcastEpisodeDialog
          episode={selectedEpisode}
          podcast={selectedPodcast}
          date={
            safeParseDate(selectedEpisode.pub_date)
              ? new Intl.DateTimeFormat(document.documentElement.lang, {
                  dateStyle: 'long',
                }).format(safeParseDate(selectedEpisode.pub_date))
              : ''
          }
          duration={formatDuration(selectedEpisode.duration_seconds)}
          onClose={() => setSelectedEpisode(null)}
          onPlay={() => {
            setSelectedEpisode(null);
            playEpisode(selectedEpisode, selectedPodcast);
          }}
          onQueue={(next) => {
            queueEpisode(selectedEpisode, selectedPodcast, next);
            setSelectedEpisode(null);
          }}
          onSave={() => {
            void handleDownloadSingleEpisode(selectedEpisode);
          }}
          onToggleFavorite={() => {
            void toggleEpisodeFavorite(selectedEpisode);
          }}
        />
      )}

      {showInbox && (
        <PodcastInboxDialog
          onClose={() => setShowInbox(false)}
          onBrowse={() => {
            setShowInbox(false);
            setSelectedPodcast(null);
            setSelectedDetail(null);
          }}
          onQueueTrack={onQueueTrack}
          onPlayTrack={onPlayTrack}
          onPlayQueue={onPlayQueue}
          onRemoveQueuedEpisode={onRemoveQueuedEpisode}
        />
      )}
      {cleanupState && (
        <PodcastCleanupCandidatesDialog
          preview={cleanupState.preview}
          busy={cleaningDownloads}
          onClose={() => {
            if (cleaningDownloads) return;
            const { podcast, returnToSettings } = cleanupState;
            setCleanupState(null);
            if (returnToSettings) {
              setSettingsPodcast(podcast);
            }
          }}
          onConfirmCleanup={() => void confirmCleanDownloads()}
        />
      )}
      {showOpmlImport && (
        <PodcastOpmlImportDialog
          onClose={() => setShowOpmlImport(false)}
          onImported={() => void loadPodcasts()}
        />
      )}
    </div>
  );
};
