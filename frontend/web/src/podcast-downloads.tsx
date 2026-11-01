import { useEffect, useState } from 'react';
import { api } from './api';
import { Icon } from './icons';
import type { DownloadQueueInfo, DownloadTaskItem } from './podcasts';
type DownloadQueueView = 'active' | 'failed' | 'completed';
export function PodcastDownloadManager() {
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
    void fetchQueue();
    const timer = window.setInterval(() => {
      if (!document.hidden) void fetchQueue();
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <section className="podcast-download-content" aria-label="下载管理">
      <h2>下载管理</h2>
      <p className="muted">这里是服务器共享音频的下载任务，所有账号按各自保存策略复用。</p>
      {notice && <p role="status">{notice}</p>}
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
        {activeQueueView === 'completed' && queueInfo && queueInfo.recent_completed.length > 0 && (
          <div className="queue-block">
            <h4>
              <span>近期已完成 ({queueInfo.recent_completed.length})</span>
              <button type="button" className="queue-clear-btn" onClick={handleClearCompleted}>
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
    </section>
  );
}
