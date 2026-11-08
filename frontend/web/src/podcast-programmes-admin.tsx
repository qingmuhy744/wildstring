import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type { PodcastStorageInfo, PodcastSummary } from './podcasts';

type FilterScope = 'all' | 'unfollowed' | 'cached';

function formatSyncTime(value: string | null): string {
  if (!value) return '尚未同步';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString('zh-CN', {
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
      setError(reason instanceof Error ? reason.message : '无法加载本服节目列表');
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
      setNotice(`已检查 ${res.updated_count} 档有订阅节目的源端更新。`);
      await load(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '全部同步失败');
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
      setNotice(`已同步《${podcast.title}》的最新单集。`);
      await load(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '同步节目失败');
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
      setError(reason instanceof Error ? reason.message : '无法读取节目磁盘占用');
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
          `《${podcast.title}》可清理 ${preview.candidate_count} 个零引用音频文件，共 ${(preview.candidate_bytes / 1048576).toFixed(1)} MB。确认立即清理？`,
        )
      ) {
        return;
      }
      const res = await api<{ deleted_count: number; freed_bytes: number }>(
        `/podcasts/${encodeURIComponent(podcast.id)}/clean-downloads`,
        { method: 'POST' },
      );
      setNotice(
        `《${podcast.title}》已清理 ${res.deleted_count} 个零引用文件，释放 ${(res.freed_bytes / 1048576).toFixed(1)} MB。`,
      );
      await load(true);
      if (storageById[podcast.id]) await inspectStorage(podcast);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '清理音频缓存失败');
    } finally {
      setBusyId(null);
    }
  }

  async function deleteProgramme(podcast: PodcastSummary) {
    if (
      !confirm(
        `确认从本服彻底删除《${podcast.title}》？\n这会移除所有用户的关注关系、收听记录以及本地已缓存的音频文件。`,
      )
    ) {
      return;
    }
    setBusyId(podcast.id);
    setNotice(null);
    setError(null);
    try {
      await api(`/podcasts/${encodeURIComponent(podcast.id)}`, { method: 'DELETE' });
      setPodcasts((items) => items.filter((item) => item.id !== podcast.id));
      setNotice(`已从本服删除《${podcast.title}》。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除节目失败');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="management-card podcast-programmes-admin" aria-label="全服节目管理">
      <div className="management-section-heading">
        <div>
          <h2>全服节目</h2>
          <p className="muted">无人关注的节目会暂停定时更新，已有资料与缓存保留。</p>
        </div>
        <button type="button" disabled={refreshingAll || loading} onClick={() => void refreshAll()}>
          {refreshingAll ? '正在同步…' : '同步活跃节目'}
        </button>
      </div>

      <div className="management-metrics" aria-label="本服节目统计">
        <div>
          <strong>{counts.total}</strong>
          <span>本服节目总数</span>
        </div>
        <div>
          <strong>{counts.active}</strong>
          <span>有人关注 · 定时更新</span>
        </div>
        <div>
          <strong>{counts.unfollowed}</strong>
          <span>0 人关注 · 已休眠</span>
        </div>
        <div>
          <strong>{counts.totalDownloaded}</strong>
          <span>本地缓存单集</span>
        </div>
      </div>

      <div className="podcast-admin-toolbar">
        <div className="podcast-catalog-tabs" role="group" aria-label="节目筛选">
          <button
            type="button"
            aria-pressed={filterScope === 'all'}
            onClick={() => setFilterScope('all')}
          >
            全部 ({counts.total})
          </button>
          <button
            type="button"
            aria-pressed={filterScope === 'unfollowed'}
            onClick={() => setFilterScope('unfollowed')}
          >
            0 人关注 · 已休眠 ({counts.unfollowed})
          </button>
          <button
            type="button"
            aria-pressed={filterScope === 'cached'}
            onClick={() => setFilterScope('cached')}
          >
            有本地缓存 ({counts.cachedProgrammes})
          </button>
        </div>
        <input
          type="search"
          aria-label="筛选全服节目"
          placeholder="搜索节目名称、作者或 RSS 地址"
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
        <p role="status">正在读取全服节目…</p>
      ) : filtered.length === 0 ? (
        <p className="management-empty">当前筛选条件下没有节目。</p>
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
                          ? '当前无人关注该节目，已自动暂停定时 RSS 抓取'
                          : `当前有 ${followers} 位用户关注，保持定时更新`
                      }
                    >
                      {followers === 0 ? '0 人关注 · 已休眠' : `${followers} 人关注`}
                    </span>
                    {podcast.downloaded_episodes > 0 && (
                      <span className="candidate-pill">
                        已缓存 {podcast.downloaded_episodes} 集
                        {storage ? ` · ${storage.disk_usage_human}` : ''}
                      </span>
                    )}
                  </div>
                  <p>
                    {podcast.author || '未知创作者'} · 共 {podcast.total_episodes} 集 · 上次同步：
                    {formatSyncTime(podcast.last_updated_at)}
                  </p>
                  {storage && (
                    <p className="candidate-path" title={storage.storage_path}>
                      路径：{storage.storage_path}（占用 {storage.disk_usage_human}）
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
                      查看占用
                    </button>
                  )}
                  <button type="button" onClick={() => onView(podcast.id)}>
                    查看单集
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void refreshSingle(podcast)}
                  >
                    立即同步
                  </button>
                  {canCleanResources && podcast.downloaded_episodes > 0 && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void cleanPodcastCache(podcast)}
                    >
                      清理零引用缓存
                    </button>
                  )}
                  <button
                    type="button"
                    className="danger"
                    disabled={isBusy}
                    onClick={() => void deleteProgramme(podcast)}
                  >
                    从本服删除
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
