import { HelpLabel } from './desktop-help';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  source?: string;
  line?: number;
  exception_type?: string;
  stack?: {
    exceptions: {
      type: string;
      relation: 'raised' | 'cause' | 'context';
      frames: { module: string; function: string; line: number }[];
      frames_truncated: boolean;
    }[];
    chain_truncated: boolean;
  };
}
interface LogSettings {
  level: 'INFO' | 'WARNING' | 'ERROR';
  capture_stack: boolean;
}
interface LogPage {
  items: LogEvent[];
  next_cursor: string | null;
  debug_until: number | null;
  degraded: boolean;
}
interface SystemStatus {
  version: string;
  schema_version: number;
  logging: LogSettings & {
    retention_days: number;
    max_bytes: number;
    degraded: boolean;
    debug_until: number | null;
  };
  external_services: string[];
  agent_available: boolean;
}
export function SystemDiagnostics() {
  const { t } = useTranslation();
  const status = useWorkspaceResource<SystemStatus>('/manage/diagnostics/status');
  const [logSettings, setLogSettings] = useState<LogSettings | null>(null);
  const configured: LogSettings = logSettings || {
    level: status.value?.logging.level || 'INFO',
    capture_stack: status.value?.logging.capture_stack ?? true,
  };
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
  async function saveLogSettings() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/manage/diagnostics/settings', {
        method: 'PUT',
        body: JSON.stringify(configured),
      });
      await status.reload();
      setLogSettings(null);
      setNotice(t('diagnostics.settingsSaved'));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function debug(stop = false) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ debug_until: number | null }>('/manage/diagnostics/debug', {
        method: 'POST',
        body: JSON.stringify({ minutes: stop ? 0 : minutes, module: debugModule }),
      });
      setNotice(
        result.debug_until
          ? t('systemDiagnostics.debugEnabled', { time: localDate(result.debug_until) })
          : t('systemDiagnostics.debugDisabled'),
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
      setNotice(t('systemDiagnostics.bundleDownloaded'));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workspace-page" aria-label={t('systemDiagnostics.sectionAria')}>
      <WorkspaceHeader
        title={t('systemDiagnostics.title')}
        description={t('systemDiagnostics.description')}
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
            <h2>{t('systemDiagnostics.statusTitle')}</h2>
            {status.value && (
              <p className="muted">
                {t('systemDiagnostics.statusLine', {
                  version: status.value.version,
                  schemaVersion: status.value.schema_version,
                  days: status.value.logging.retention_days,
                  limit: Math.round(status.value.logging.max_bytes / 1048576),
                })}
              </p>
            )}
            {(status.value?.logging.degraded || logs.value?.degraded) && (
              <p role="alert" className="error">
                {t('systemDiagnostics.storageDegraded')}
              </p>
            )}
            <form
              className="workspace-form"
              onSubmit={(e) => {
                e.preventDefault();
                void saveLogSettings();
              }}
            >
              <h3>{t('diagnostics.settings')}</h3>
              <p className="muted">{t('diagnostics.settingsHint')}</p>
              <label>
                {t('diagnostics.minimumLevel')}
                <select
                  aria-label={t('diagnostics.minimumLevel')}
                  value={configured.level}
                  disabled={busy || !status.value}
                  onChange={(e) =>
                    setLogSettings({ ...configured, level: e.target.value as LogSettings['level'] })
                  }
                >
                  <option value="INFO">{t('diagnostics.levelInfo')}</option>
                  <option value="WARNING">{t('diagnostics.levelWarning')}</option>
                  <option value="ERROR">{t('diagnostics.levelError')}</option>
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={configured.capture_stack}
                  disabled={busy || !status.value}
                  onChange={(e) =>
                    setLogSettings({ ...configured, capture_stack: e.target.checked })
                  }
                />
                {t('diagnostics.captureStack')}
              </label>
              <p className="muted">{t('diagnostics.stackHint')}</p>
              <button type="submit" disabled={busy || !status.value || !logSettings}>
                {t('diagnostics.saveSettings')}
              </button>
            </form>
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
                <HelpLabel hint="diagnostic">{t('systemDiagnostics.traceIdLabel')}</HelpLabel>
                <input
                  aria-label={t('systemDiagnostics.filterTraceAria')}
                  value={trace}
                  onChange={(e) => setTrace(e.target.value)}
                  maxLength={80}
                  pattern="[A-Za-z0-9_-]*"
                />
              </label>
              <label>
                {t('systemDiagnostics.levelLabel')}
                <select
                  aria-label={t('systemDiagnostics.levelAria')}
                  value={level}
                  onChange={(e) => setLevel(e.target.value)}
                >
                  <option value="">{t('systemDiagnostics.levelAll')}</option>
                  {['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                {t('systemDiagnostics.eventNameLabel')}
                <input
                  aria-label={t('systemDiagnostics.eventNameAria')}
                  value={event}
                  onChange={(e) => setEvent(e.target.value)}
                  maxLength={120}
                />
              </label>
              <label>
                {t('systemDiagnostics.taskIdLabel')}
                <input
                  aria-label={t('systemDiagnostics.filterTaskAria')}
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  maxLength={100}
                />
              </label>
              <div className="span-all workspace-actions">
                <button className="primary" disabled={logs.loading}>
                  {t('systemDiagnostics.queryLogs')}
                </button>
                <button type="button" disabled={busy} onClick={() => void bundle()}>
                  {t('systemDiagnostics.downloadBundle')}
                </button>
              </div>
            </form>
          </div>
          <div className="workspace-card" aria-label={t('systemDiagnostics.eventsListAria')}>
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
                  {item.task_id && (
                    <small>{t('systemDiagnostics.taskPrefix', { taskId: item.task_id })}</small>
                  )}
                  {(item.exception_type || item.source) && (
                    <small>
                      {[item.exception_type, item.source, item.line].filter(Boolean).join(' · ')}
                    </small>
                  )}
                  {item.stack && (
                    <details className="diagnostic-stack">
                      <summary>{t('diagnostics.errorStack')}</summary>
                      {item.stack.exceptions.map((exception, index) => (
                        <div key={index}>
                          <strong>
                            {t(`diagnostics.relation.${exception.relation}`)} · {exception.type}
                          </strong>
                          <ol>
                            {exception.frames.map((frame, frameIndex) => (
                              <li key={frameIndex}>
                                <code>
                                  {frame.module}.{frame.function}:{frame.line}
                                </code>
                              </li>
                            ))}
                          </ol>
                          {exception.frames_truncated && <p>{t('diagnostics.framesTruncated')}</p>}
                        </div>
                      ))}
                      {item.stack.chain_truncated && <p>{t('diagnostics.chainTruncated')}</p>}
                    </details>
                  )}
                </div>
                {item.trace_id && (
                  <button
                    aria-label={t('systemDiagnostics.viewRelatedLogsAria', {
                      traceId: item.trace_id,
                    })}
                    onClick={() => {
                      setTrace(item.trace_id!);
                      setPages([]);
                      setCursor('');
                      setQuery(
                        new URLSearchParams({ limit: '50', trace_id: item.trace_id! }).toString(),
                      );
                    }}
                  >
                    {t('systemDiagnostics.relatedLogs')}
                  </button>
                )}
              </article>
            ))}
            {!displayed.length && (
              <p className="workspace-empty">
                {logs.loading
                  ? t('systemDiagnostics.loadingLogs')
                  : t('systemDiagnostics.noEvents')}
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
                {t('systemDiagnostics.loadMoreEvents')}
              </button>
            )}
          </div>
          <details className="workspace-card">
            <summary>{t('systemDiagnostics.debugSummary')}</summary>
            <p className="muted">{t('systemDiagnostics.debugHint')}</p>
            <div className="workspace-inline">
              <label>
                {t('systemDiagnostics.scopeLabel')}
                <select
                  aria-label={t('systemDiagnostics.scopeAria')}
                  value={debugModule}
                  onChange={(e) => setDebugModule(e.target.value)}
                >
                  <option value="outbound">{t('systemDiagnostics.scopeOutbound')}</option>
                  <option value="agent">{t('systemDiagnostics.scopeAgent')}</option>
                  <option value="all">{t('systemDiagnostics.scopeAll')}</option>
                </select>
              </label>
              <label>
                {t('systemDiagnostics.minutesLabel')}
                <input
                  aria-label={t('systemDiagnostics.minutesAria')}
                  type="number"
                  min={1}
                  max={15}
                  value={minutes}
                  onChange={(e) => setMinutes(Number(e.target.value))}
                />
              </label>
              <button disabled={busy || minutes < 1 || minutes > 15} onClick={() => void debug()}>
                {t('systemDiagnostics.enableDebug')}
              </button>
              <button disabled={busy} onClick={() => void debug(true)}>
                {t('systemDiagnostics.disableDebug')}
              </button>
            </div>
            {status.value?.logging.debug_until && (
              <p className="muted">
                {t('systemDiagnostics.debugAutoEnds', {
                  time: localDate(status.value.logging.debug_until),
                })}
              </p>
            )}
          </details>
        </>
      )}
    </section>
  );
}
