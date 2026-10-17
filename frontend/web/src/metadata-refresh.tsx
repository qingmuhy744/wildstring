import { useEffect, useRef, useState } from 'react';
import { api } from './api';

export type RefreshTarget = { scope: 'track' | 'album' | 'library'; id?: string; label: string };

export function MetadataRefreshDialog({
  target,
  onClose,
  onQueued,
}: {
  target: RefreshTarget;
  onClose: () => void;
  onQueued?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [mode, setMode] = useState('missing');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      previous?.focus({ preventScroll: true });
    };
  }, []);
  async function submit() {
    if (pending.current || done) return;
    pending.current = true;
    setBusy(true);
    setMessage('正在提交更新任务…');
    try {
      const result = await api<{ queued: number; already_active: number; total: number }>(
        '/manage/providers/refresh',
        {
          method: 'POST',
          body: JSON.stringify({
            scope: target.scope,
            ...(target.id ? { id: target.id } : {}),
            mode,
            force,
          }),
        },
      );
      setMessage(
        result.total
          ? `已加入 ${result.queued} 首，已有 ${result.already_active} 首正在处理。`
          : '当前范围没有可更新的歌曲。',
      );
      setDone(true);
      onQueued?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '更新未提交，请检查联网设置后重试。');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
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
      <fieldset disabled={busy || done}>
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
      <p className="muted">更新先生成建议，在歌曲信息里确认后应用。人工修改和已有封面会保留。</p>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <footer>
        <button onClick={onClose} disabled={busy}>
          {done ? '完成' : '取消'}
        </button>
        <button className="primary" disabled={busy || done} onClick={() => void submit()}>
          {busy ? '正在提交…' : '开始更新'}
        </button>
      </footer>
    </dialog>
  );
}

const jobStatus: Record<string, string> = {
  queued: '排队中',
  running: '查询中',
  completed: '建议已生成',
  failed: '查询失败',
  no_match: '没有新增资料',
  stale: '歌曲已修改，请重新更新',
};
export function MetadataJobs({ onInspect }: { onInspect: (id: string) => void }) {
  const [value, setValue] = useState<{
    queued: number;
    running: number;
    items: { id: string; track_id: string; title: string; status: string }[];
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        setValue(await api('/manage/providers/jobs', { signal: controller.signal }));
        setError('');
      } catch {
        if (!controller.signal.aborted) setError('无法读取元数据任务。');
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  return (
    <section className="management-card" aria-label="元数据更新任务">
      <h2>元数据更新</h2>
      <p role="status">
        {value ? `等待 ${value.queued} 首 · 查询中 ${value.running} 首` : '正在读取任务…'}
      </p>
      {error && <p role="alert">{error}</p>}
      <ul className="manage-track-list">
        {value?.items.map((job) => (
          <li key={job.id}>
            <div>
              <strong>{job.title}</strong>
              <span>{jobStatus[job.status] || job.status}</span>
            </div>
            <button
              onClick={() => onInspect(job.track_id)}
              aria-label={`查看 ${job.title} 的资料建议`}
            >
              查看建议
            </button>
          </li>
        ))}
      </ul>
    </section>
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
      <ol ref={list} className="provider-priority" aria-label="元数据来源优先级">
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
