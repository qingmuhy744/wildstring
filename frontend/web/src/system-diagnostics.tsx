import { useState } from 'react';
import { api } from './api';
import {
  DiagnosticId,
  errorText,
  localDate,
  RefreshWorkspace,
  useWorkspaceResource,
  WorkspaceHeader,
  WorkspaceNotice,
} from './workspace-ui';
interface LogEvent {
  id: string;
  time: string;
  level: string;
  event: string;
  trace_id?: string;
  task_id?: string;
  service?: string;
  code?: string;
  http_status?: number;
  elapsed_ms?: number;
  domain?: string;
}
interface LogPage {
  items: LogEvent[];
  next_cursor: string | null;
  debug_until: string | null;
  degraded: boolean;
}
interface SystemStatus {
  version: string;
  schema_version: number;
  logging: {
    retention_days: number;
    max_bytes: number;
    degraded: boolean;
    debug_until: string | null;
  };
  external_services: string[];
  agent_available: boolean;
}
export function SystemDiagnostics() {
  const status = useWorkspaceResource<SystemStatus>('/manage/diagnostics/status');
  const [trace, setTrace] = useState(''),
    [level, setLevel] = useState(''),
    [event, setEvent] = useState(''),
    [task, setTask] = useState(''),
    [query, setQuery] = useState('limit=50'),
    [cursor, setCursor] = useState(''),
    [pages, setPages] = useState<LogEvent[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [debugModule, setDebugModule] = useState('outbound'),
    [minutes, setMinutes] = useState(5);
  const logs = useWorkspaceResource<LogPage>(
    `/manage/diagnostics/events?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
  );
  const displayed = Array.from(
    new Map([...pages, ...(logs.value?.items || [])].map((item) => [item.id, item])).values(),
  );
  async function debug(stop = false) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ debug_until: string | null }>('/manage/diagnostics/debug', {
        method: 'POST',
        body: JSON.stringify({ minutes: stop ? 0 : minutes, module: debugModule }),
      });
      setNotice(
        result.debug_until
          ? `临时详细日志已开启，将在 ${localDate(result.debug_until)} 自动恢复。`
          : '临时详细日志已关闭。',
      );
      void status.reload();
      void logs.reload();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function bundle() {
    setBusy(true);
    setError('');
    try {
      const response = await api<Record<string, unknown>>(
        `/manage/diagnostics/bundle${trace ? `?trace_id=${encodeURIComponent(trace.trim())}` : ''}`,
      );
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(response, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `wildstring-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('诊断包已下载，仅包含服务端允许的脱敏信息。');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workspace-page" aria-label="系统诊断">
      <WorkspaceHeader
        eyebrow="SEE WHAT HAPPENED"
        title="找得到，才修得好。"
        description="按诊断编号查看同一次操作。日志只展示受控摘要，修改审计独立保留。"
      >
        <RefreshWorkspace
          busy={logs.loading || status.loading}
          onClick={() => {
            setPages([]);
            setCursor('');
            void logs.reload();
            void status.reload();
          }}
        />
      </WorkspaceHeader>
      <WorkspaceNotice
        error={error || status.error || logs.error}
        notice={notice}
        unavailable={status.unsupported}
      />
      {!status.unsupported && (
        <>
          <div className="workspace-card">
            <h2>运行状态</h2>
            {status.value && (
              <p className="muted">
                版本 {status.value.version} · 数据库 {status.value.schema_version} · 日志保留{' '}
                {status.value.logging.retention_days} 天 / 上限{' '}
                {Math.round(status.value.logging.max_bytes / 1048576)} MiB
              </p>
            )}
            {(status.value?.logging.degraded || logs.value?.degraded) && (
              <p role="alert" className="error">
                诊断日志存储已降级，部分事件可能缺失；音乐播放继续可用。
              </p>
            )}
            <form
              className="workspace-form"
              onSubmit={(e) => {
                e.preventDefault();
                setPages([]);
                setCursor('');
                const p = new URLSearchParams({ limit: '50' });
                if (trace.trim()) p.set('trace_id', trace.trim());
                if (level) p.set('level', level);
                if (event.trim()) p.set('event', event.trim());
                if (task.trim()) p.set('task_id', task.trim());
                setQuery(p.toString());
              }}
            >
              <label>
                诊断编号
                <input
                  aria-label="筛选诊断编号"
                  value={trace}
                  onChange={(e) => setTrace(e.target.value)}
                  maxLength={80}
                  pattern="[A-Za-z0-9_-]*"
                />
              </label>
              <label>
                日志级别
                <select
                  aria-label="日志级别"
                  value={level}
                  onChange={(e) => setLevel(e.target.value)}
                >
                  <option value="">全部</option>
                  {['DEBUG', 'INFO', 'WARNING', 'ERROR'].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                事件名称
                <input
                  aria-label="事件名称"
                  value={event}
                  onChange={(e) => setEvent(e.target.value)}
                  maxLength={120}
                />
              </label>
              <label>
                任务编号
                <input
                  aria-label="筛选任务编号"
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  maxLength={100}
                />
              </label>
              <div className="span-all workspace-actions">
                <button className="primary" disabled={logs.loading}>
                  查询日志
                </button>
                <button type="button" disabled={busy} onClick={() => void bundle()}>
                  下载脱敏诊断包
                </button>
              </div>
            </form>
          </div>
          <div className="workspace-card" aria-label="诊断事件列表">
            {displayed.map((item) => (
              <article className="workspace-row" key={item.id}>
                <div className="workspace-row-main">
                  <strong>
                    {item.event} <span className="workspace-badge">{item.level}</span>
                  </strong>
                  <small>
                    {localDate(item.time)}
                    {item.service ? ` · ${item.service}` : ''}
                    {item.domain ? ` · ${item.domain}` : ''}
                    {item.code ? ` · ${item.code}` : ''}
                    {item.http_status ? ` · HTTP ${item.http_status}` : ''}
                    {item.elapsed_ms != null ? ` · ${item.elapsed_ms} ms` : ''}
                  </small>
                  <DiagnosticId id={item.trace_id} />
                  {item.task_id && <small>任务 {item.task_id}</small>}
                </div>
                {item.trace_id && (
                  <button
                    aria-label={`查看 ${item.trace_id} 的关联日志`}
                    onClick={() => {
                      setTrace(item.trace_id!);
                      setPages([]);
                      setCursor('');
                      setQuery(
                        new URLSearchParams({ limit: '50', trace_id: item.trace_id! }).toString(),
                      );
                    }}
                  >
                    关联日志
                  </button>
                )}
              </article>
            ))}
            {!displayed.length && (
              <p className="workspace-empty">
                {logs.loading ? '读取日志中…' : '没有符合条件的事件。'}
              </p>
            )}
            {logs.value?.next_cursor && (
              <button
                disabled={logs.loading}
                onClick={() => {
                  setPages(displayed);
                  setCursor(logs.value!.next_cursor!);
                }}
              >
                加载更多事件
              </button>
            )}
          </div>
          <details className="workspace-card">
            <summary>临时详细日志</summary>
            <p className="muted">
              最长 15 分钟后自动恢复。仍然脱敏，不记录对话、歌词、密钥或完整请求正文。
            </p>
            <div className="workspace-inline">
              <label>
                范围
                <select
                  aria-label="详细日志范围"
                  value={debugModule}
                  onChange={(e) => setDebugModule(e.target.value)}
                >
                  <option value="outbound">外部请求</option>
                  <option value="agent">助手与任务</option>
                  <option value="all">全部受控模块</option>
                </select>
              </label>
              <label>
                分钟
                <input
                  aria-label="详细日志分钟数"
                  type="number"
                  min={1}
                  max={15}
                  value={minutes}
                  onChange={(e) => setMinutes(Number(e.target.value))}
                />
              </label>
              <button disabled={busy || minutes < 1 || minutes > 15} onClick={() => void debug()}>
                开启临时详细日志
              </button>
              <button disabled={busy} onClick={() => void debug(true)}>
                立即关闭
              </button>
            </div>
            {status.value?.logging.debug_until && (
              <p className="muted">自动结束：{localDate(status.value.logging.debug_until)}</p>
            )}
          </details>
        </>
      )}
    </section>
  );
}
