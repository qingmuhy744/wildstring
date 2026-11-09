import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import i18n from './i18n';
import type { PodcastStorageInfo, PodcastSummary } from './podcasts';

type FilterScope = 'all' | 'unfollowed' | 'cached';

function formatSyncTime(value: string | null): string {
  if (!value) return i18n.t('podcastProgrammesAdmin.notSyncedYet');
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString(i18n.language === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function PodcastProgrammesAdmin({
  canCleanResources,
  onView,
}: {
  canCleanResources: boolean;
  onView: (podcastId: string) => void;
}) {
  const { t } = useTranslation();
  const [podcasts, setPodcasts] = useState<PodcastSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterScope, setFilterScope] = useState<FilterScope>('all');
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storageById, setStorageById] = useState<Record<string, PodcastStorageInfo>>({});

  async function load(silent = false) {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const list = await api<PodcastSummary[]>('/podcasts');
      setPodcasts(list);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t('podcastProgrammesAdmin.loadListFailed'),
      );
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const counts = useMemo(() => {
    const unfollowed = podcasts.filter((p) => (p.follower_count ?? (p.followed ? 1 : 0)) === 0);
    const cached = podcasts.filter((p) => p.downloaded_episodes > 0);
    const totalDownloaded = podcasts.reduce((sum, p) => sum + p.downloaded_episodes, 0);
    return {
      total: podcasts.length,
      active: podcasts.length - unfollowed.length,
      unfollowed: unfollowed.length,
      cachedProgrammes: cached.length,
      totalDownloaded,
    };
  }, [podcasts]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return podcasts.filter((p) => {
      const followers = p.follower_count ?? (p.followed ? 1 : 0);
      if (filterScope === 'unfollowed' && followers > 0) return false;
      if (filterScope === 'cached' && p.downloaded_episodes === 0) return false;
      if (!term) return true;
      return (
        p.title.toLowerCase().includes(term) ||
        (p.author || '').toLowerCase().includes(term) ||
        (p.feed_url || '').toLowerCase().includes(term)
      );
    });
  }, [podcasts, filterScope, search]);

  async function refreshAll() {
    setRefreshingAll(true);
    setNotice(null);
    setError(null);
    try {
      const res = await api<{ updated_count: number }>('/podcasts/refresh-all', { method: 'POST' });
      setNotice(t('podcastProgrammesAdmin.refreshAllNotice', { count: res.updated_count }));
      await load(true);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t('podcastProgrammesAdmin.refreshAllFailed'),
      );
    } finally {
      setRefreshingAll(false);
    }
  }

  async function refreshSingle(podcast: PodcastSummary) {
    setBusyId(podcast.id);
    setNotice(null);
    setError(null);
    try {
      await api(`/podcasts/${encodeURIComponent(podcast.id)}/refresh`, { method: 'POST' });
      setNotice(t('podcastProgrammesAdmin.refreshSingleNotice', { title: podcast.title }));
      await load(true);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t('podcastProgrammesAdmin.refreshSingleFailed'),
      );
    } finally {
      setBusyId(null);
    }
  }

  async function inspectStorage(podcast: PodcastSummary) {
    try {
      const info = await api<PodcastStorageInfo>(
        `/podcasts/${encodeURIComponent(podcast.id)}/storage`,
      );
      setStorageById((prev) => ({ ...prev, [podcast.id]: info }));
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t('podcastProgrammesAdmin.readStorageFailed'),
      );
    }
  }

  async function cleanPodcastCache(podcast: PodcastSummary) {
    if (!canCleanResources) return;
    setBusyId(podcast.id);
    setNotice(null);
    setError(null);
    try {
      const preview = await api<{ candidate_count: number; candidate_bytes: number }>(
        '/podcasts/resources/cleanup',
        { method: 'POST', body: JSON.stringify({ dry_run: true, podcast_id: podcast.id }) },
      );
      if (
        !confirm(
          t('podcastProgrammesAdmin.confirmCleanCache', {
            title: podcast.title,
            count: preview.candidate_count,
            mb: (preview.candidate_bytes / 1048576).toFixed(1),
          }),
        )
      ) {
        return;
      }
      const res = await api<{ deleted_count: number; freed_bytes: number }>(
        `/podcasts/${encodeURIComponent(podcast.id)}/clean-downloads`,
        { method: 'POST' },
      );
      setNotice(
        t('podcastProgrammesAdmin.cleanCacheNotice', {
          title: podcast.title,
          count: res.deleted_count,
          mb: (res.freed_bytes / 1048576).toFixed(1),
        }),
      );
      await load(true);
      if (storageById[podcast.id]) await inspectStorage(podcast);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t('podcastProgrammesAdmin.cleanCacheFailed'),
      );
    } finally {
      setBusyId(null);
    }
  }

  async function deleteProgramme(podcast: PodcastSummary) {
    if (!confirm(t('podcastProgrammesAdmin.confirmDeleteProgramme', { title: podcast.title }))) {
      return;
    }
    setBusyId(podcast.id);
    setNotice(null);
    setError(null);
    try {
      await api(`/podcasts/${encodeURIComponent(podcast.id)}`, { method: 'DELETE' });
      setPodcasts((items) => items.filter((item) => item.id !== podcast.id));
      setNotice(t('podcastProgrammesAdmin.deleteProgrammeNotice', { title: podcast.title }));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('podcastProgrammesAdmin.deleteProgrammeFailed'),
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section
      className="management-card podcast-programmes-admin"
      aria-label={t('podcastProgrammesAdmin.cardAriaLabel')}
    >
      <div className="management-section-heading">
        <div>
          <h2>{t('podcastProgrammesAdmin.heading')}</h2>
          <p className="muted">{t('podcastProgrammesAdmin.headingHelp')}</p>
        </div>
        <button type="button" disabled={refreshingAll || loading} onClick={() => void refreshAll()}>
          {refreshingAll
            ? t('podcastProgrammesAdmin.refreshing')
            : t('podcastProgrammesAdmin.refreshActiveShows')}
        </button>
      </div>

      <div className="management-metrics" aria-label={t('podcastProgrammesAdmin.metricsAriaLabel')}>
        <div>
          <strong>{counts.total}</strong>
          <span>{t('podcastProgrammesAdmin.totalProgrammes')}</span>
        </div>
        <div>
          <strong>{counts.active}</strong>
          <span>{t('podcastProgrammesAdmin.activeProgrammes')}</span>
        </div>
        <div>
          <strong>{counts.unfollowed}</strong>
          <span>{t('podcastProgrammesAdmin.dormantProgrammes')}</span>
        </div>
        <div>
          <strong>{counts.totalDownloaded}</strong>
          <span>{t('podcastProgrammesAdmin.cachedEpisodes')}</span>
        </div>
      </div>

      <div className="podcast-admin-toolbar">
        <div
          className="podcast-catalog-tabs"
          role="group"
          aria-label={t('podcastProgrammesAdmin.filterTabsAria')}
        >
          <button
            type="button"
            aria-pressed={filterScope === 'all'}
            onClick={() => setFilterScope('all')}
          >
            {t('podcastProgrammesAdmin.tabAll', { count: counts.total })}
          </button>
          <button
            type="button"
            aria-pressed={filterScope === 'unfollowed'}
            onClick={() => setFilterScope('unfollowed')}
          >
            {t('podcastProgrammesAdmin.tabUnfollowed', { count: counts.unfollowed })}
          </button>
          <button
            type="button"
            aria-pressed={filterScope === 'cached'}
            onClick={() => setFilterScope('cached')}
          >
            {t('podcastProgrammesAdmin.tabCached', { count: counts.cachedProgrammes })}
          </button>
        </div>
        <input
          type="search"
          aria-label={t('podcastProgrammesAdmin.searchAriaLabel')}
          placeholder={t('podcastProgrammesAdmin.searchPlaceholder')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {loading ? (
        <p role="status">{t('podcastProgrammesAdmin.loading')}</p>
      ) : filtered.length === 0 ? (
        <p className="management-empty">{t('podcastProgrammesAdmin.noProgrammes')}</p>
      ) : (
        <div className="podcast-resource-list">
          {filtered.map((podcast) => {
            const followers = podcast.follower_count ?? (podcast.followed ? 1 : 0);
            const storage = storageById[podcast.id];
            const isBusy = busyId === podcast.id;
            return (
              <article key={podcast.id} className="podcast-admin-programme-row">
                <div className="podcast-admin-programme-info">
                  <div className="podcast-admin-programme-head">
                    <strong>{podcast.title}</strong>
                    <span
                      className={`candidate-pill${followers === 0 ? ' is-dormant' : ''}`}
                      title={
                        followers === 0
                          ? t('podcastProgrammesAdmin.dormantTooltip')
                          : t('podcastProgrammesAdmin.activeTooltip', { count: followers })
                      }
                    >
                      {followers === 0
                        ? t('podcastProgrammesAdmin.dormantPill')
                        : t('podcastProgrammesAdmin.followersCountPill', { count: followers })}
                    </span>
                    {podcast.downloaded_episodes > 0 && (
                      <span className="candidate-pill">
                        {t('podcastProgrammesAdmin.cachedCount', {
                          count: podcast.downloaded_episodes,
                        })}
                        {storage ? ` · ${storage.disk_usage_human}` : ''}
                      </span>
                    )}
                  </div>
                  <p>
                    {t('podcastProgrammesAdmin.showMeta', {
                      author: podcast.author || t('podcastProgrammesAdmin.unknownAuthor'),
                      total: podcast.total_episodes,
                      syncTime: formatSyncTime(podcast.last_updated_at),
                    })}
                  </p>
                  {storage && (
                    <p className="candidate-path" title={storage.storage_path}>
                      {t('podcastProgrammesAdmin.storagePath', {
                        path: storage.storage_path,
                        usage: storage.disk_usage_human,
                      })}
                    </p>
                  )}
                </div>
                <div className="podcast-admin-programme-actions">
                  {podcast.downloaded_episodes > 0 && !storage && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void inspectStorage(podcast)}
                    >
                      {t('podcastProgrammesAdmin.viewStorage')}
                    </button>
                  )}
                  <button type="button" onClick={() => onView(podcast.id)}>
                    {t('podcastProgrammesAdmin.viewEpisodes')}
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void refreshSingle(podcast)}
                  >
                    {t('podcastProgrammesAdmin.syncNow')}
                  </button>
                  {canCleanResources && podcast.downloaded_episodes > 0 && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void cleanPodcastCache(podcast)}
                    >
                      {t('podcastProgrammesAdmin.cleanZeroRefCache')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="danger"
                    disabled={isBusy}
                    onClick={() => void deleteProgramme(podcast)}
                  >
                    {t('podcastProgrammesAdmin.deleteFromServer')}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
