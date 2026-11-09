import { useTranslation } from 'react-i18next';
import { hints } from './help-content';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { MetadataReviewDialog } from './metadata-review';
import { Icon } from './icons';
import { JobDiagnostics, jobStatus, type ProviderJob } from './provider-diagnostics';
import { Pagination } from './track-list';
import './metadata-tasks.css';

type View = 'active' | 'pending' | 'attention' | 'history';
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
  view: View;
  items: Task[];
  total: number;
  offset: number;
  limit: number;
  counts: Record<View, number>;
  queued: number;
  running: number;
  snapshot_at: number;
  retention_days: number;
}
const viewKeys: Record<View, string> = {
  active: 'metadataTasks.viewActive',
  pending: 'metadataTasks.viewPending',
  attention: 'metadataTasks.viewAttention',
  history: 'metadataTasks.viewHistory',
};
const emptyKeys: Record<View, string> = {
  active: 'metadataTasks.emptyActive',
  pending: 'metadataTasks.emptyPending',
  attention: 'metadataTasks.emptyAttention',
  history: 'metadataTasks.emptyHistory',
};

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
  const [view, setView] = useState<View>('active');
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
  const initial = useRef(true),
    request = useRef(false);
  useEffect(() => {
    initial.current = true;
    setView('active');
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
          `/manage/providers/tasks?view=${view}&offset=${offset}${batchId ? `&batch_id=${encodeURIComponent(batchId)}` : ''}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (offset > 0 && offset >= result.total) {
          setOffset(Math.max(0, Math.ceil(result.total / result.limit) - 1) * result.limit);
          return;
        }
        setValue(result);
        setError('');
        if (initial.current) {
          initial.current = false;
          if (!result.counts.active) {
            if (result.counts.pending) setView('pending');
            else if (result.counts.attention) setView('attention');
          }
        }
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
  }, [view, offset, tick, batchId]);
  useEffect(() => {
    if (!historyOpen) return;
    const controller = new AbortController();
    api<TaskPage>(
      `/manage/providers/tasks?view=history&offset=${historyOffset}${batchId ? `&batch_id=${encodeURIComponent(batchId)}` : ''}`,
      {
        signal: controller.signal,
      },
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
  function review(task: Task) {
    if (!value || (view !== 'pending' && view !== 'attention')) return;
    const prompt =
      view === 'pending'
        ? t('metadataTasks.ignorePendingConfirm', { title: task.title })
        : t('metadataTasks.ignoreAttentionConfirm', { title: task.title });
    if (!confirm(prompt)) return;
    void mutate(
      `/manage/providers/tasks/tracks/${encodeURIComponent(task.track_id)}/review`,
      { view, through: value.snapshot_at, ...(batchId ? { batch_id: batchId } : {}) },
      t('metadataTasks.processedArchived'),
    );
  }
  function rows(page: TaskPage, current: View) {
    return page.items.length ? (
      <ul
        className="manage-track-list metadata-task-list"
        aria-label={t('metadataTasks.taskListAria', { view: t(viewKeys[current]) })}
      >
        {page.items.map((task) => (
          <li key={task.track_id}>
            <div className="metadata-task-copy">
              <strong>{task.title}</strong>
              <span
                data-help={hints.taskHistory}
                className={task.requires_attention ? 'metadata-task-warning' : ''}
              >
                {task.status === 'completed' && task.has_issue
                  ? t('metadataTasks.partialCompleted')
                  : current === 'history' && task.status === 'completed'
                    ? t('metadataTasks.queryCompleted')
                    : t(jobStatus[task.status] || 'providerDiagnostics.statusUnknown')}
                {current === 'pending'
                  ? t('metadataTasks.pendingSuggestions', { count: task.suggestion_count })
                  : ''}
                {task.has_issue && !task.requires_attention ? t('metadataTasks.issueResolved') : ''}
              </span>
              <small>
                {new Date(task.created_at * 1000).toLocaleString()}
                {task.job_count > 1
                  ? t('metadataTasks.mergedQueries', { count: task.job_count })
                  : ''}
              </small>
              <JobDiagnostics job={task} />
            </div>
            <div className="metadata-task-actions">
              <button
                aria-label={t('metadataTasks.inspectTrackAria', {
                  action:
                    current === 'history'
                      ? t('metadataTasks.actionView')
                      : t('metadataTasks.actionReview'),
                  title: task.title,
                })}
                onClick={() => {
                  if (current === 'history') onInspect(task.track_id);
                  else {
                    setReviewTrackId(task.track_id);
                    setReviewOpen(true);
                  }
                }}
              >
                {current === 'history'
                  ? t('metadataTasks.viewDetails')
                  : task.requires_attention
                    ? t('metadataTasks.viewOldResults')
                    : t('metadataTasks.viewCandidates')}
              </button>
              {['pending', 'attention'].includes(current) && !!task.requires_attention && (
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
              {(current === 'pending' || current === 'attention') && (
                <button disabled={busy} onClick={() => review(task)}>
                  {current === 'pending'
                    ? t('metadataTasks.ignoreSuggestions')
                    : t('metadataTasks.ignoreIssue')}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    ) : (
      <p className="metadata-task-empty">{t(emptyKeys[current])}</p>
    );
  }
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
          <button
            onClick={() => {
              setReviewTrackId(undefined);
              setReviewOpen(true);
            }}
          >
            {batchId
              ? t('metadataTasks.reviewBatchCandidates')
              : t('metadataTasks.reviewMetadataBatch')}
          </button>
          <p className="muted" role="status">
            {value
              ? t('metadataTasks.queueStatus', { queued: value.queued, running: value.running })
              : t('metadataTasks.loadingTasks')}
          </p>
          {view === 'attention' && !!value?.counts.attention && (
            <p className="muted metadata-task-guidance" role="note">
              {t('metadataTasks.attentionGuidance')}
            </p>
          )}
        </div>
        <div className="metadata-task-toolbar">
          {view === 'attention' && !!value?.counts.attention ? (
            <button
              disabled={busy}
              onClick={() => {
                if (
                  confirm(
                    t('metadataTasks.ignoreAllAttentionConfirm', {
                      count: value.counts.attention,
                    }),
                  )
                ) {
                  void mutate(
                    '/manage/providers/tasks/attention/clear',
                    { through: value.snapshot_at, batch_id: batchId },
                    t('metadataTasks.ignoredAllAttentionNotice', {
                      count: value.counts.attention,
                    }),
                  );
                }
              }}
            >
              {t('metadataTasks.ignoreAllAttention', { count: value.counts.attention })}
            </button>
          ) : null}
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
        </div>
      </div>
      <nav
        className="metadata-task-tabs"
        aria-label={t('metadataTasks.tabsAria')}
        data-help={hints.taskHistory}
      >
        {(['active', 'pending', 'attention'] as const).map((name) => (
          <button
            key={name}
            aria-pressed={view === name}
            onClick={() => {
              setView(name);
              setOffset(0);
            }}
          >
            {t(viewKeys[name])}
            <span>{value?.counts[name] ?? '—'}</span>
          </button>
        ))}
      </nav>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {value?.view === view ? (
        <>
          {rows(value, view)}
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
              ? t('metadataTasks.historyCountSuffix', { count: value.counts.history })
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
