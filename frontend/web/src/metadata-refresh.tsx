import { hints } from './help-content';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { JobDiagnostics, jobStatus, type ProviderJob } from './provider-diagnostics';

export type RefreshTarget = { scope: 'track' | 'album' | 'library'; id?: string; label: string };
interface RefreshBatch {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  no_match: number;
  stale: number;
  items: ProviderJob[];
  truncated: boolean;
}
export function MetadataRefreshDialog({
  target,
  onClose,
  onQueued,
}: {
  target: RefreshTarget;
  onClose: () => void;
  onQueued?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    pending = useRef(false);
  const progress = useRef<HTMLParagraphElement>(null);
  const [mode, setMode] = useState('missing'),
    [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [done, setDone] = useState(false);
  const [batchId, setBatchId] = useState(''),
    [batch, setBatch] = useState<RefreshBatch | null>(null);
  const [statusError, setStatusError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    if (done) {
      progress.current?.focus({ preventScroll: true });
      if (dialog.current) dialog.current.scrollTop = 0;
    }
  }, [done]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      previous?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!batchId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStatusError('');
    async function load() {
      try {
        const response = await api<RefreshBatch>(
          `/manage/providers/refresh/${encodeURIComponent(batchId)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setBatch(response);
        setStatusError('');
        if (response.queued + response.running > 0) timer = setTimeout(() => void load(), 2000);
      } catch {
        if (!controller.signal.aborted)
          setStatusError(
            '本批状态暂时无法读取，任务不会重新提交。可以重试查询，或到管理的任务记录查看。',
          );
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [batchId, retry]);
  async function submit() {
    if (pending.current || done) return;
    pending.current = true;
    setBusy(true);
    setMessage('正在提交更新任务…');
    try {
      const result = await api<{
        queued: number;
        already_active: number;
        total: number;
        batch_id: string;
      }>('/manage/providers/refresh', {
        method: 'POST',
        body: JSON.stringify({
          scope: target.scope,
          ...(target.id ? { id: target.id } : {}),
          mode,
          force,
        }),
      });
      setMessage(
        result.total
          ? `已加入 ${result.queued} 首（新增排队 ${result.queued} 首，已有任务 ${result.already_active} 首${
              (result as { upgraded?: number; refresh_intents?: number }).upgraded ||
              (result as { upgraded?: number; refresh_intents?: number }).refresh_intents
                ? `，刷新意图已更新 ${
                    ((result as { upgraded?: number }).upgraded || 0) +
                    ((result as { refresh_intents?: number }).refresh_intents || 0)
                  } 首`
                : ''
            }）。`
          : '当前范围没有可更新的歌曲。',
      );
      setDone(true);
      setBatchId(result.batch_id || '');
      onQueued?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '更新未提交，请检查联网设置后重试。');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const active = !!batchId && (!batch || batch.queued + batch.running > 0);
  const finished = batch ? batch.completed + batch.failed + batch.no_match + batch.stale : 0;
  return (
    <dialog
      className="metadata-refresh-dialog"
      ref={dialog}
      aria-label="更新元数据"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2>更新元数据</h2>
        <button aria-label="关闭元数据更新" disabled={busy} onClick={onClose}>
          ×
        </button>
      </header>
      <p>{target.label}</p>
      {!done ? (
        <fieldset disabled={busy}>
          <label>
            更新方式
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="missing">只查缺失资料</option>
              <option value="all">查询全部资料</option>
            </select>
          </label>
          <label className="check-label">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            重新联网查询
          </label>
          <p className="muted">开启后重新向已启用的资料来源查询；关闭时可以复用近期结果。</p>
        </fieldset>
      ) : (
        <p className="muted">
          本次：{mode === 'all' ? '查询全部资料' : '只查缺失资料'} ·{' '}
          {force ? '重新联网查询' : '可复用近期结果'}
        </p>
      )}
      <p className="muted">更新先生成建议，在歌曲信息里确认后应用。人工修改和已有封面会保留。</p>
      <p ref={progress} tabIndex={-1} role="status" aria-live="polite">
        {batch ? '本批更新已提交。' : message}
        {batchId && (
          <>
            <br />
            {batch
              ? `本批 ${batch.total} 首 · 已处理 ${finished} 首 · 排队 ${batch.queued} 首 · 查询中 ${batch.running} 首`
              : '正在读取本批任务进度…'}
            {batch && !active ? ' · 本批查询已结束。' : ''}
          </>
        )}
      </p>
      {batch && (
        <section className="metadata-batch-results" aria-label="本批更新结果">
          <progress aria-label="本批元数据更新进度" max={batch.total || 1} value={finished} />
          <p className="muted">
            建议已生成 {batch.completed} 首 · 失败 {batch.failed} 首 · 没有新增资料 {batch.no_match}{' '}
            首 · 信息已变化 {batch.stale} 首
          </p>
          <ul className="metadata-batch-tracks">
            {batch.items.map((job) => (
              <li key={job.id}>
                <strong>{job.title || '歌曲'}</strong>
                <span>{jobStatus[job.status] || '状态待确认'}</span>
                <JobDiagnostics job={job} />
              </li>
            ))}
          </ul>
          {batch.truncated && (
            <p className="muted">
              逐曲列表仅展示前 {batch.items.length} 首，上方统计覆盖本批全部歌曲。
            </p>
          )}
        </section>
      )}
      {statusError && (
        <div className="error" role="alert">
          <p>{statusError}</p>
          <button onClick={() => setRetry((value) => value + 1)}>重试查询进度</button>
        </div>
      )}
      {done && active && <p className="muted">关闭弹窗后，更新会在服务端继续执行。</p>}
      <footer>
        <button onClick={onClose} disabled={busy}>
          {done ? (active ? '关闭（后台继续）' : '完成') : '取消'}
        </button>
        {!done && (
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '正在提交…' : '开始更新'}
          </button>
        )}
      </footer>
    </dialog>
  );
}
const names: Record<string, string> = { musicbrainz: 'MusicBrainz', lastfm: 'Last.fm' };
export function ProviderPriority({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const drag = useRef<{ from: number; to: number; pointer: number; centers: number[] } | null>(
    null,
  );
  const [over, setOver] = useState<number | null>(null);
  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= value.length) return;
    const next = [...value];
    next.splice(to, 0, next.splice(from, 1)[0]);
    onChange(next);
    requestAnimationFrame(() =>
      list.current?.querySelectorAll<HTMLButtonElement>('button')[to]?.focus(),
    );
  }
  return (
    <>
      <p id="provider-priority-help" className="muted">
        拖动调整来源优先级，也可用方向键。靠前来源优先推荐；同一录音的不同发行版仍需分别核对。
      </p>
      <ol
        ref={list}
        className="provider-priority"
        aria-label="元数据来源优先级"
        data-help={hints.providerPriority}
      >
        {value.map((source, index) => (
          <li key={source} className={over === index ? 'priority-target' : ''}>
            <button
              className="icon-button"
              aria-label={`拖动 ${names[source]} 优先级`}
              aria-describedby="provider-priority-help"
              onPointerDown={(event) => {
                if (!event.isPrimary || event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = {
                  from: index,
                  to: index,
                  pointer: event.pointerId,
                  centers: Array.from(list.current!.children, (node) => {
                    const b = node.getBoundingClientRect();
                    return (b.top + b.bottom) / 2;
                  }),
                };
                setOver(index);
              }}
              onPointerMove={(event) => {
                const current = drag.current;
                if (!current || event.pointerId !== current.pointer) return;
                current.to = current.centers.reduce(
                  (best, center, i) =>
                    Math.abs(center - event.clientY) <
                    Math.abs(current.centers[best] - event.clientY)
                      ? i
                      : best,
                  0,
                );
                setOver(current.to);
              }}
              onPointerUp={(event) => {
                const current = drag.current;
                if (!current || event.pointerId !== current.pointer) return;
                drag.current = null;
                setOver(null);
                move(current.from, current.to);
              }}
              onPointerCancel={() => {
                drag.current = null;
                setOver(null);
              }}
              onLostPointerCapture={() => {
                drag.current = null;
                setOver(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  drag.current = null;
                  setOver(null);
                  return;
                }
                const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
                if (direction) {
                  event.preventDefault();
                  move(index, index + direction);
                }
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M5 7h14M5 12h14M5 17h14" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
            <span>
              {index + 1}. {names[source]}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}
