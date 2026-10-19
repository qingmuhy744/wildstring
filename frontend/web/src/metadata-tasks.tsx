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
const names: Record<View, string> = {
  active: '进行中',
  pending: '待确认',
  attention: '需处理',
  history: '历史记录',
};
const empty: Record<View, string> = {
  active: '当前没有进行中的查询。查询结束后自动归档，待确认的建议会继续保留。',
  pending: '没有待确认的建议。',
  attention: '没有需要处理的问题。',
  history: '没有已归档的查询。',
};

export function MetadataJobs({ onInspect }: { onInspect: (id: string) => void }) {
  const [reviewOpen, setReviewOpen] = useState(false);
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
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const result = await api<TaskPage>(
          `/manage/providers/tasks?view=${view}&offset=${offset}`,
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
        if (!controller.signal.aborted) setError('无法读取元数据任务。');
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void load(), 2000);
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [view, offset, tick]);
  useEffect(() => {
    if (!historyOpen) return;
    const controller = new AbortController();
    api<TaskPage>(`/manage/providers/tasks?view=history&offset=${historyOffset}`, {
      signal: controller.signal,
    })
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
        if (!controller.signal.aborted) setHistoryError('无法读取历史记录。');
      });
    return () => controller.abort();
  }, [historyOpen, historyOffset, tick, value?.counts.history]);

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
      setError(cause instanceof Error ? cause.message : '操作未完成，请重试。');
    } finally {
      request.current = false;
      setBusy(false);
    }
  }
  function review(task: Task) {
    if (!value || (view !== 'pending' && view !== 'attention')) return;
    const prompt =
      view === 'pending'
        ? `忽略“${task.title}”当前待确认的建议？已应用的元数据会保留。`
        : `忽略“${task.title}”当前的问题并归档？`;
    if (!confirm(prompt)) return;
    void mutate(
      `/manage/providers/tasks/tracks/${encodeURIComponent(task.track_id)}/review`,
      { view, through: value.snapshot_at },
      '已处理的记录已归档。',
    );
  }
  function rows(page: TaskPage, current: View) {
    return page.items.length ? (
      <ul
        className="manage-track-list metadata-task-list"
        aria-label={`${names[current]}的元数据任务`}
      >
        {page.items.map((task) => (
          <li key={task.track_id}>
            <div className="metadata-task-copy">
              <strong>{task.title}</strong>
              <span className={task.requires_attention ? 'metadata-task-warning' : ''}>
                {task.status === 'completed' && task.has_issue
                  ? '部分完成'
                  : current === 'history' && task.status === 'completed'
                    ? '查询完成'
                    : jobStatus[task.status] || '状态待确认'}
                {current === 'pending' ? ` · ${task.suggestion_count} 条待确认建议` : ''}
                {task.has_issue && !task.requires_attention ? ' · 问题已处理' : ''}
              </span>
              <small>
                {new Date(task.created_at * 1000).toLocaleString()}
                {task.job_count > 1 ? ` · 合并 ${task.job_count} 次查询` : ''}
              </small>
              <JobDiagnostics job={task} />
            </div>
            <div className="metadata-task-actions">
              <button
                aria-label={`查看 ${task.title} 的资料建议`}
                onClick={() => onInspect(task.track_id)}
              >
                {current === 'pending' ? '查看建议' : '查看详情'}
              </button>
              {['pending', 'attention'].includes(current) && !!task.requires_attention && (
                <button
                  disabled={busy}
                  aria-label={`重新查询 ${task.title}`}
                  onClick={() =>
                    void mutate(
                      `/manage/providers/tasks/${encodeURIComponent(task.id)}/retry`,
                      {},
                      '已重新排队查询，现有建议继续保留。',
                    )
                  }
                >
                  <Icon name="refresh" />
                  重新查询
                </button>
              )}
              {(current === 'pending' || current === 'attention') && (
                <button disabled={busy} onClick={() => review(task)}>
                  {current === 'pending' ? '忽略建议' : '忽略问题'}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    ) : (
      <p className="metadata-task-empty">{empty[current]}</p>
    );
  }
  return (
    <section className="management-card metadata-tasks" aria-label="元数据更新任务">
      {reviewOpen && (
        <MetadataReviewDialog
          onClose={() => setReviewOpen(false)}
          onApplied={() => setTick((n) => n + 1)}
        />
      )}
      <div className="management-section-heading">
        <div>
          <h2>元数据更新</h2>
          <button onClick={() => setReviewOpen(true)}>批量核对资料</button>
          <p className="muted" role="status">
            {value ? `等待 ${value.queued} 首 · 查询中 ${value.running} 首` : '正在读取任务…'}
          </p>
        </div>
        <button onClick={() => setTick((n) => n + 1)}>
          <Icon name="refresh" />
          刷新
        </button>
      </div>
      <nav className="metadata-task-tabs" aria-label="元数据任务分类">
        {(['active', 'pending', 'attention'] as const).map((name) => (
          <button
            key={name}
            aria-pressed={view === name}
            onClick={() => {
              setView(name);
              setOffset(0);
            }}
          >
            {names[name]}
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
          {value.total > value.limit && <Pagination page={value} onOffset={setOffset} unit="首" />}
        </>
      ) : (
        <p role="status">正在读取…</p>
      )}
      <details
        className="metadata-task-history"
        open={historyOpen}
        onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
      >
        <summary>历史记录{value ? ` · ${value.counts.history} 首` : ''}</summary>
        <div className="management-section-heading">
          <p className="muted">
            已处理记录自动归档，默认展示最近 30 天。待确认建议及未处理问题保留。
          </p>
          <button
            disabled={busy || !history?.total}
            onClick={() => {
              if (
                history &&
                confirm(
                  '清理已归档的元数据查询记录？待确认建议、未处理问题和已应用的元数据会保留。',
                )
              )
                void mutate(
                  '/manage/providers/tasks/history/clear',
                  { through: history.snapshot_at },
                  '已清理归档记录。',
                );
            }}
          >
            <Icon name="remove" />
            清理历史
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
              <Pagination page={history} onOffset={setHistoryOffset} unit="首" />
            )}
          </>
        ) : (
          <p role="status">正在读取历史…</p>
        )}
      </details>
    </section>
  );
}
