import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, api } from './api';
import { Icon } from './icons';

export const localDate = (value: string | number | null | undefined) => {
  if (!value) return '—';
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString();
};
export const errorText = (reason: unknown) =>
  reason instanceof Error ? reason.message : '操作未完成，请重试。';

export function useWorkspaceResource<T>(path: string | null, pollMs = 0) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(!!path);
  const sequence = useRef(0);
  const unsupportedRef = useRef(false);
  const request = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    if (!path || document.hidden || !navigator.onLine) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const epoch = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const result = await api<T>(path, { signal: controller.signal });
      if (epoch === sequence.current && !controller.signal.aborted) {
        setValue(result);
        setUnsupported(false);
        unsupportedRef.current = false;
      }
    } catch (reason) {
      if (controller.signal.aborted || epoch !== sequence.current) return;
      if (reason instanceof ApiError && [404, 405, 501].includes(reason.status)) {
        setUnsupported(true);
        unsupportedRef.current = true;
      } else setError(errorText(reason));
    } finally {
      if (epoch === sequence.current && !controller.signal.aborted) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setValue(null);
    setUnsupported(false);
    unsupportedRef.current = false;
    setError('');
    void reload();
    const foreground = () => {
      if (!document.hidden) void reload();
      else request.current?.abort();
    };
    window.addEventListener('online', foreground);
    document.addEventListener('visibilitychange', foreground);
    const timer = pollMs
      ? setInterval(() => {
          if (!unsupportedRef.current) void reload();
        }, pollMs)
      : undefined;
    return () => {
      ++sequence.current;
      request.current?.abort();
      clearInterval(timer);
      window.removeEventListener('online', foreground);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [reload, pollMs]);
  return { value, setValue, error, unsupported, loading, reload };
}

export function WorkspaceHeader({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="workspace-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      <div className="workspace-actions">{children}</div>
    </header>
  );
}
export function WorkspaceNotice({
  error,
  notice,
  unavailable,
}: {
  error?: string;
  notice?: string;
  unavailable?: boolean;
}) {
  return (
    <>
      {unavailable && (
        <p className="workspace-empty" role="status">
          当前服务端尚未提供这项功能，请升级服务端后重试。
        </p>
      )}
      {error && (
        <p role="alert" className="error workspace-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="workspace-notice">
          {notice}
        </p>
      )}
    </>
  );
}
export function DiagnosticId({ id, label = '诊断编号' }: { id?: string | null; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!id) return null;
  return (
    <button
      className="trace-copy text-button"
      title="复制诊断编号"
      onClick={() =>
        void navigator.clipboard
          .writeText(id)
          .then(() => setCopied(true))
          .catch(() => setCopied(false))
      }
    >
      <code>
        {label} {id}
      </code>
      {copied ? ' 已复制' : ' 复制'}
    </button>
  );
}
export function RefreshWorkspace({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button className="workspace-refresh" disabled={busy} onClick={onClick}>
      <Icon name="refresh" />
      {busy ? '正在刷新…' : '刷新'}
    </button>
  );
}
export const stateNames: Record<string, string> = {
  draft: '待确认',
  approved: '已批准，待应用',
  applied: '已应用',
  stale: '依据已变化',
  rejected: '已拒绝',
  expired: '已过期',
  queued: '排队中',
  running: '执行中',
  retry_wait: '等待重试',
  paused_budget: '预算暂停',
  paused_auth: '授权暂停',
  paused_authorization: '授权暂停',
  disabled: '已关闭',
  revoked: '已撤销',
  cancel_requested: '正在停止',
  cancelled: '已取消',
  succeeded: '已完成',
  partial: '部分完成',
  partial_success: '部分完成',
  failed: '失败',
  interrupted: '已中断',
  sent: '接口已确认发送',
  unknown: '投递结果不明',
  sending: '发送中',
  pending: '待确认',
  ready: '可用',
  ok: '可用',
  unconfigured: '未配置',
  not_configured: '未配置',
  unverified: '未验证',
  unsupported: '不支持',
  error: '检测失败',
};
export function StateBadge({ state }: { state: string }) {
  return <span className={`workspace-badge state-${state}`}>{stateNames[state] || state}</span>;
}
