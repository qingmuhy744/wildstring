import { useTranslation } from 'react-i18next';
import { hints } from './help-content';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { MetadataReviewDialog } from './metadata-review';
import { Icon } from './icons';
import { type ProviderJob, providerReason } from './provider-diagnostics';
import { Pagination } from './track-list';
import './metadata-tasks.css';

/** The page is one queue: everything that still needs a decision, newest first. */
type View = 'queue' | 'history';
interface Task extends ProviderJob {
  track_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  job_count: number;
  suggestion_count: number;
  has_issue: number;
  requires_attention: number;
  acknowledged_at: number | null;
}
interface TaskPage {
  view: string;
  items: Task[];
  total: number;
  offset: number;
  limit: number;
  counts: Record<string, number>;
  queued: number;
  running: number;
  snapshot_at: number;
  retention_days: number;
}

/** Reasons arrive as codes; the row speaks the first one and keeps the rest in the details. */
function reasonCodes(task: Task): string[] {
  const codes: unknown[] = task.error ? [task.error] : [];
  if (task.warnings) {
    try {
      const parsed = JSON.parse(task.warnings);
      if (Array.isArray(parsed)) codes.push(...parsed);
    } catch {
      codes.push(undefined);
    }
  }
  return [...new Set(codes.map((code) => providerReason(code)))];
}

export function MetadataJobs({
  onInspect,
  batchId,
}: {
  onInspect: (id: string) => void;
  batchId?: string;
}) {
  const { t } = useTranslation();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewTrackId, setReviewTrackId] = useState<string>();
  const [offset, setOffset] = useState(0);
  const [value, setValue] = useState<TaskPage | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [history, setHistory] = useState<TaskPage | null>(null);
  const [historyError, setHistoryError] = useState('');
  const request = useRef(false);

  useEffect(() => {
    setOffset(0);
    setHistory(null);
    setHistoryOffset(0);
  }, [batchId]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const result = await api<TaskPage>(
          `/manage/providers/tasks?view=queue&offset=${offset}${batchId ? `&batch_id=${encodeURIComponent(batchId)}` : ''}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (offset > 0 && offset >= result.total) {
          setOffset(Math.max(0, Math.ceil(result.total / result.limit) - 1) * result.limit);
          return;
        }
        setValue(result);
        setError('');
      } catch {
        if (!controller.signal.aborted) setError(t('metadataTasks.loadError'));
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void load(), 2000);
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [offset, tick, batchId]);

  useEffect(() => {
    if (!historyOpen) return;
    const controller = new AbortController();
    api<TaskPage>(
      `/manage/providers/tasks?view=history&offset=${historyOffset}${batchId ? `&batch_id=${encodeURIComponent(batchId)}` : ''}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (historyOffset > 0 && historyOffset >= result.total) {
          setHistoryOffset(Math.max(0, Math.ceil(result.total / result.limit) - 1) * result.limit);
          return;
        }
        setHistory(result);
        setHistoryError('');
      })
      .catch(() => {
        if (!controller.signal.aborted) setHistoryError(t('metadataTasks.historyLoadError'));
      });
    return () => controller.abort();
  }, [historyOpen, historyOffset, tick, value?.counts.history, batchId]);

  async function mutate(path: string, body: unknown, success: string) {
    if (request.current) return;
    request.current = true;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setMessage(success);
      setTick((n) => n + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('metadataTasks.mutateFailed'));
    } finally {
      request.current = false;
      setBusy(false);
    }
  }

  /** Archives whatever is still pending for the track, so the row leaves the queue. */
  function archive(task: Task) {
    if (!value) return;
    if (!confirm(t('metadataTasks.archiveConfirm', { title: task.title }))) return;
    void mutate(
      `/manage/providers/tasks/tracks/${encodeURIComponent(task.track_id)}/review`,
      { view: 'queue', through: value.snapshot_at, ...(batchId ? { batch_id: batchId } : {}) },
      t('metadataTasks.archivedNotice'),
    );
  }

  function openReview(task: Task) {
    setReviewTrackId(task.track_id);
    setReviewOpen(true);
  }

  /** One sentence that answers "what is wrong with this song", not a job status. */
  function reason(task: Task): string {
    if (task.suggestion_count > 0) {
      return t('metadataTasks.reasonSuggestions', { count: task.suggestion_count });
    }
    const [first] = reasonCodes(task);
    if (first) return t(first);
    if (task.status === 'failed' || task.status === 'stale')
      return t('metadataTasks.reasonNoResult');
    return t('metadataTasks.reasonDone');
  }

  function rows(page: TaskPage, current: View) {
    if (!page.items.length) {
      return (
        <p className="metadata-task-empty">
          {t(current === 'history' ? 'metadataTasks.emptyHistory' : 'metadataTasks.emptyQueue')}
        </p>
      );
    }
    return (
      <ul
        className="manage-track-list metadata-task-list"
        aria-label={t(
          current === 'history' ? 'metadataTasks.historyListAria' : 'metadataTasks.queueListAria',
        )}
      >
        {page.items.map((task) => (
          <li key={task.track_id}>
            <div className="metadata-task-copy">
              <strong>{task.title}</strong>
              <span
                data-help={hints.taskHistory}
                className={
                  current === 'queue' ? 'metadata-task-reason' : 'metadata-task-reason muted'
                }
              >
                {current === 'history' ? reason(task) : reason(task)}
              </span>
              <small>
                {new Date(task.created_at * 1000).toLocaleString()}
                {task.job_count > 1
                  ? t('metadataTasks.mergedQueries', { count: task.job_count })
                  : ''}
              </small>
            </div>
            <div className="metadata-task-actions">
              <button
                className="primary"
                aria-label={t(
                  current === 'history'
                    ? 'metadataTasks.inspectTrackAria'
                    : 'metadataTasks.reviewTrackAria',
                  { title: task.title },
                )}
                onClick={() =>
                  current === 'history' ? onInspect(task.track_id) : openReview(task)
                }
              >
                {current === 'history'
                  ? t('metadataTasks.viewDetails')
                  : t('metadataTasks.reviewAction')}
              </button>
              {current === 'queue' && !!task.requires_attention && (
                <button
                  disabled={busy}
                  aria-label={t('metadataTasks.retryTrackAria', { title: task.title })}
                  onClick={() =>
                    void mutate(
                      `/manage/providers/tasks/${encodeURIComponent(task.id)}/retry`,
                      {},
                      t('metadataTasks.retryQueued'),
                    )
                  }
                >
                  <Icon name="refresh" />
                  {t('metadataTasks.requery')}
                </button>
              )}
              {current === 'queue' && (
                <details className="metadata-task-more">
                  <summary
                    aria-label={t('metadataTasks.moreActionsAria', { title: task.title })}
                    role="button"
                  >
                    ⋯
                  </summary>
                  <button disabled={busy} onClick={() => archive(task)}>
                    {t('metadataTasks.archiveTask')}
                  </button>
                </details>
              )}
            </div>
          </li>
        ))}
      </ul>
    );
  }

  const pendingCount = value ? (value.counts.pending ?? 0) + (value.counts.attention ?? 0) : 0;
  const activeCount = value ? (value.counts.active ?? 0) : 0;

  return (
    <section className="management-card metadata-tasks" aria-label={t('metadataTasks.sectionAria')}>
      {reviewOpen && (
        <MetadataReviewDialog
          onClose={() => {
            setReviewOpen(false);
            setReviewTrackId(undefined);
          }}
          trackId={reviewTrackId}
          batchId={reviewTrackId ? undefined : batchId}
          onApplied={() => setTick((n) => n + 1)}
        />
      )}
      <div className="management-section-heading">
        <div>
          <h2>{t('metadataTasks.headingTitle')}</h2>
          <p className="muted" role="status">
            {value
              ? pendingCount
                ? t('metadataTasks.queueSummary', { count: pendingCount })
                : t('metadataTasks.queueClear')
              : t('metadataTasks.loadingTasks')}
            {activeCount ? t('metadataTasks.activeSummary', { count: activeCount }) : ''}
          </p>
          {batchId && (
            <button
              onClick={() => {
                setReviewTrackId(undefined);
                setReviewOpen(true);
              }}
            >
              {t('metadataTasks.reviewBatchCandidates')}
            </button>
          )}
        </div>
        <div className="metadata-task-toolbar">
          {value?.queued ? (
            <button
              disabled={busy}
              onClick={() => {
                if (confirm(t('metadataTasks.clearQueuedConfirm', { count: value.queued })))
                  void mutate(
                    '/manage/providers/tasks/clear-queued',
                    {},
                    t('metadataTasks.clearedQueuedNotice', { count: value.queued }),
                  );
              }}
            >
              {t('metadataTasks.clearQueued', { count: value.queued })}
            </button>
          ) : null}
          <button onClick={() => setTick((n) => n + 1)}>
            <Icon name="refresh" />
            {t('metadataTasks.refresh')}
          </button>
          {pendingCount ? (
            <details className="metadata-task-more">
              <summary aria-label={t('metadataTasks.moreToolbarActionsAria')} role="button">
                ⋯
              </summary>
              <button
                disabled={busy}
                onClick={() => {
                  if (confirm(t('metadataTasks.archiveAllConfirm', { count: pendingCount }))) {
                    void mutate(
                      '/manage/providers/tasks/attention/clear',
                      { through: value?.snapshot_at, batch_id: batchId },
                      t('metadataTasks.archivedAllNotice', { count: pendingCount }),
                    );
                  }
                }}
              >
                {t('metadataTasks.archiveAll', { count: pendingCount })}
              </button>
            </details>
          ) : null}
        </div>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {value ? (
        <>
          {rows(value, 'queue')}
          {value.total > value.limit && (
            <Pagination page={value} onOffset={setOffset} unit={t('metadataTasks.unitTracks')} />
          )}
        </>
      ) : (
        <p role="status">{t('metadataTasks.loading')}</p>
      )}
      <details
        className="metadata-task-history"
        open={historyOpen}
        onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
      >
        <summary>
          {t('metadataTasks.historySummary', {
            countSuffix: value
              ? t('metadataTasks.historyCountSuffix', { count: value.counts.history ?? 0 })
              : '',
          })}
        </summary>
        <div className="management-section-heading">
          <p className="muted">{t('metadataTasks.historyMuted')}</p>
          <button
            disabled={busy || !history?.total}
            onClick={() => {
              if (history && confirm(t('metadataTasks.clearHistoryConfirm')))
                void mutate(
                  '/manage/providers/tasks/history/clear',
                  { through: history.snapshot_at },
                  t('metadataTasks.clearedHistoryNotice'),
                );
            }}
          >
            <Icon name="remove" />
            {t('metadataTasks.clearHistory')}
          </button>
        </div>
        {historyError && (
          <p role="alert" className="error">
            {historyError}
          </p>
        )}
        {history ? (
          <>
            {rows(history, 'history')}
            {history.total > history.limit && (
              <Pagination
                page={history}
                onOffset={setHistoryOffset}
                unit={t('metadataTasks.unitTracks')}
              />
            )}
          </>
        ) : (
          <p role="status">{t('metadataTasks.loadingHistory')}</p>
        )}
      </details>
    </section>
  );
}
