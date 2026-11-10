import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { Icon } from './icons';
import type { DownloadQueueInfo, DownloadTaskItem } from './podcasts';
type DownloadQueueView = 'active' | 'failed' | 'completed';

const taskErrorExactKeys: Record<string, string> = {
  下载失败: 'podcastDownloads.errDownloadFailed',
  下载已被停止: 'podcastDownloads.errDownloadStopped',
  播客音频超过大小限制: 'podcastDownloads.errAudioTooLarge',
  '源站域名被解析为 fake-ip 地址（198.18.0.0/15），请在服务端开启 WILDSTRING_PODCAST_ALLOW_FAKE_IP 或配置出站代理':
    'podcastDownloads.errFakeIp',
  播客音频地址指向非公网资源: 'podcastDownloads.errNonPublicUrl',
  '源站频繁请求限流 (HTTP 429 Too Many Requests)，已启动防限流冷却': 'podcastDownloads.errHttp429',
  '源站频繁请求限流 (HTTP 429 Too Many Requests)，已自动切换平缓下载并启动防限流冷却':
    'podcastDownloads.errHttp429',
  '源站防盗链或拒绝访问 (HTTP 403 Forbidden)': 'podcastDownloads.errHttp403',
  '音频资源文件不存在 (HTTP 404 Not Found)': 'podcastDownloads.errHttp404',
  '源站服务过载不可用 (HTTP 503)': 'podcastDownloads.errHttp503',
  '网络连接超时，源站响应过慢': 'podcastDownloads.errTimeout',
  '网络请求超时，源站响应过慢': 'podcastDownloads.errRequestTimeout',
  '源站 SSL 证书校验失败': 'podcastDownloads.errSsl',
};

export function localizeTaskError(
  t: (key: string, options?: Record<string, unknown>) => string,
  error?: string | null,
): string {
  if (!error) return t('podcastDownloads.defaultTaskError');
  if (taskErrorExactKeys[error]) return t(taskErrorExactKeys[error]);
  const retry = error.match(/^第 (\d+)\/(\d+) 次重试等待中 \((\d+)s\): (.+)$/);
  if (retry) {
    return t('podcastDownloads.errRetryWaitingDetail', {
      attempt: retry[1],
      max: retry[2],
      seconds: retry[3],
      error: localizeTaskError(t, retry[4]),
    });
  }
  const http = error.match(/^源站 HTTP 请求失败 \((\d+)\)$/);
  if (http) return t('podcastDownloads.errHttpStatus', { code: http[1] });
  const net = error.match(/^网络连接失败 \((.+)\)$/);
  if (net) return t('podcastDownloads.errNetworkReason', { reason: net[1] });
  const exc = error.match(/^下载遇到异常: (.+)$/);
  if (exc) return t('podcastDownloads.errExceptionReason', { reason: exc[1] });
  return error;
}

export function PodcastDownloadManager() {
  const { t } = useTranslation();
  const [notice, showNotice] = useState('');
  const [queueInfo, setQueueInfo] = useState<DownloadQueueInfo | null>(null);
  const [retryingFailed, setRetryingFailed] = useState(false);
  const [queueView, setQueueView] = useState<DownloadQueueView | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);

  const activeQueueView: DownloadQueueView =
    queueView ||
    (queueInfo?.total_pending
      ? 'active'
      : queueInfo?.failed_count
        ? 'failed'
        : queueInfo?.recent_completed.length
          ? 'completed'
          : 'active');

  const fetchQueue = async () => {
    try {
      const q = await api<DownloadQueueInfo>('/podcasts/downloads/queue');
      setQueueInfo(q);
      setQueueError(null);
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : t('podcastDownloads.loadStatusFailed'));
    }
  };

  const handleRetryFailed = async () => {
    try {
      setRetryingFailed(true);
      const res = await api<{ retried_count: number }>('/podcasts/downloads/retry-failed', {
        method: 'POST',
      });
      showNotice(t('podcastDownloads.requeuedNotice', { count: res.retried_count }));
      await fetchQueue();
      if (res.retried_count > 0) setQueueView('active');
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : t('podcastDownloads.retryTasksFailed'));
    } finally {
      setRetryingFailed(false);
    }
  };

  const handleClearCompleted = async () => {
    try {
      await api('/podcasts/downloads/clear-completed', { method: 'POST' });
      await fetchQueue();
      showNotice(t('podcastDownloads.clearCompletedNotice'));
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : t('podcastDownloads.clearRecordsFailed'));
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
      setQueueError(err instanceof Error ? err.message : t('podcastDownloads.redownloadFailed'));
    }
  };

  useEffect(() => {
    void fetchQueue();
    const timer = window.setInterval(() => {
      if (!document.hidden) void fetchQueue();
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <section className="podcast-download-content" aria-label={t('podcastDownloads.title')}>
      <h2>{t('podcastDownloads.title')}</h2>
      <p className="muted">{t('podcastDownloads.description')}</p>
      {notice && <p role="status">{notice}</p>}
      <div
        className="download-views"
        role="group"
        aria-label={t('podcastDownloads.downloadStatusAria')}
      >
        {(
          [
            {
              value: 'active',
              label: t('podcastDownloads.tabActive'),
              count: queueInfo?.total_pending || 0,
            },
            {
              value: 'failed',
              label: t('podcastDownloads.tabFailed'),
              count: queueInfo?.failed_count || 0,
            },
            {
              value: 'completed',
              label: t('podcastDownloads.tabCompleted'),
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
            {t('podcastDownloads.reload')}
          </button>
        </div>
      )}
      <div className="queue-list-container">
        {/* Failed Items Section */}
        {activeQueueView === 'failed' && queueInfo && queueInfo.failed.length > 0 && (
          <div className="queue-block">
            <h4>
              <span>{t('podcastDownloads.failedCount', { count: queueInfo.failed.length })}</span>
              <button
                type="button"
                className="podcast-toolbar-btn"
                disabled={retryingFailed}
                onClick={handleRetryFailed}
              >
                <Icon name="refresh" />{' '}
                {retryingFailed ? t('podcastDownloads.retrying') : t('podcastDownloads.retryAll')}
              </button>
            </h4>
            <div className="queue-cards-group">
              {queueInfo.failed.map((task) => (
                <div className="queue-task-card failed" key={task.episode_id}>
                  <div className="queue-task-main">
                    <div className="queue-task-title">{task.episode_title}</div>
                    <div className="queue-task-sub">{task.podcast_title}</div>
                    <div className="queue-task-error">{localizeTaskError(t, task.error)}</div>
                  </div>
                  <button
                    type="button"
                    className="queue-retry-single-btn"
                    onClick={() => void handleRetryDownload(task)}
                  >
                    {t('podcastDownloads.retry')}
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
                {t('podcastDownloads.activeCountSummary', {
                  active: queueInfo.active_count,
                  queued: queueInfo.queued_count,
                })}
              </span>
            </h4>
            <div className="queue-cards-group">
              {queueInfo.downloading.map((task) => {
                const pct =
                  task.progress_pct != null ? Math.min(Math.max(task.progress_pct, 0), 100) : null;
                return (
                  <div className="queue-task-card downloading" key={task.episode_id}>
                    <div className="queue-task-main">
                      <div className="queue-task-title">{task.episode_title}</div>
                      <div className="queue-task-sub">{task.podcast_title}</div>
                      <div className="queue-task-progress-box">
                        <div
                          className="queue-progress-bar-bg"
                          role="progressbar"
                          aria-label={t('podcastDownloads.progressAria', {
                            title: task.episode_title,
                          })}
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
                            {task.slow_mode ? t('podcastDownloads.slowModePrefix') : ''}
                            {task.speed_human || t('podcastDownloads.fetchingData')}
                          </span>
                          <span>
                            {task.downloaded_human
                              ? `${task.downloaded_human} / ${task.total_human && task.total_human !== '未知大小' ? task.total_human : t('podcastDownloads.unknownTotal')}`
                              : t('podcastDownloads.connecting')}
                          </span>
                        </div>
                      </div>
                    </div>
                    <span
                      className={`queue-task-status ${task.status === 'retrying' ? 'queued' : 'downloading'}`}
                    >
                      {task.status === 'retrying'
                        ? t('podcastDownloads.retryWaiting', {
                            attempt: task.attempt || 1,
                            max: task.max_retries || 3,
                          })
                        : pct != null
                          ? `${pct}%`
                          : t('podcastDownloads.downloading')}
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
                  <span className="queue-task-status queued">
                    {t('podcastDownloads.queuedOrder', { order: idx + 1 })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent Completed Section */}
        {activeQueueView === 'completed' && queueInfo && queueInfo.recent_completed.length > 0 && (
          <div className="queue-block">
            <h4>
              <span>
                {t('podcastDownloads.recentCompletedCount', {
                  count: queueInfo.recent_completed.length,
                })}
              </span>
              <button type="button" className="queue-clear-btn" onClick={handleClearCompleted}>
                {t('podcastDownloads.clearRecords')}
              </button>
            </h4>
            <div className="queue-cards-group">
              {queueInfo.recent_completed.map((task) => (
                <div className="queue-task-card" key={task.episode_id}>
                  <div className="queue-task-main">
                    <div className="queue-task-title">{task.episode_title}</div>
                    <div className="queue-task-sub">{task.podcast_title}</div>
                  </div>
                  <span className="queue-task-status downloaded">
                    {t('podcastDownloads.downloadedCheck')}
                  </span>
                </div>
              ))}
            </div>
            <p className="download-records-note">{t('podcastDownloads.clearRecordsNote')}</p>
          </div>
        )}

        {/* Empty State */}
        {!queueInfo && !queueError && (
          <p className="queue-empty-state">{t('podcastDownloads.loadingQueue')}</p>
        )}
        {queueInfo &&
          ((activeQueueView === 'active' && queueInfo.total_pending === 0) ||
            (activeQueueView === 'failed' && queueInfo.failed.length === 0) ||
            (activeQueueView === 'completed' && queueInfo.recent_completed.length === 0)) && (
            <div className="queue-empty-state">
              <Icon name={activeQueueView === 'completed' ? 'history' : 'download'} />
              <strong>
                {activeQueueView === 'active'
                  ? t('podcastDownloads.emptyTitleActive')
                  : activeQueueView === 'failed'
                    ? t('podcastDownloads.emptyTitleFailed')
                    : t('podcastDownloads.emptyTitleCompleted')}
              </strong>
              <p>
                {activeQueueView === 'active'
                  ? t('podcastDownloads.emptyDescActive')
                  : activeQueueView === 'failed'
                    ? t('podcastDownloads.emptyDescFailed')
                    : t('podcastDownloads.emptyDescCompleted')}
              </p>
            </div>
          )}
      </div>
    </section>
  );
}
