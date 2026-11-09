import { HelpText } from './desktop-help';
import { useTranslation } from 'react-i18next';
import i18n from './i18n';
import { hints, stateHelp } from './help-content';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, api } from './api';
import { Icon } from './icons';

export const localDate = (value: string | number | null | undefined) => {
  if (!value) return '—';
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString();
};
export const errorText = (reason: unknown) =>
  reason instanceof Error ? reason.message : i18n.t('common.actionError');

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
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="workspace-heading">
      <div>
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
  const { t } = useTranslation();
  return (
    <>
      {unavailable && (
        <p className="workspace-empty" role="status">
          {t('common.unsupportedServer')}
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
export function DiagnosticId({ id, label }: { id?: string | null; label?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  if (!id) return null;
  return (
    <button
      className="trace-copy text-button"
      data-help={hints.diagnostic}
      onClick={() =>
        void navigator.clipboard
          .writeText(id)
          .then(() => setCopied(true))
          .catch(() => setCopied(false))
      }
    >
      <code>
        {label || t('common.diagnostic')} {id}
      </code>
      {copied ? ` ${t('common.copied')}` : ` ${t('common.copy')}`}
    </button>
  );
}
export function RefreshWorkspace({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button className="workspace-refresh" disabled={busy} onClick={onClick}>
      <Icon name="refresh" />
      {busy ? t('common.refreshing') : t('common.refresh')}
    </button>
  );
}
export const stateNames: Record<string, string> = {
  get draft() {
    return i18n.t('workspaceUi.states.draft');
  },
  get approved() {
    return i18n.t('workspaceUi.states.approved');
  },
  get applied() {
    return i18n.t('workspaceUi.states.applied');
  },
  get stale() {
    return i18n.t('workspaceUi.states.stale');
  },
  get rejected() {
    return i18n.t('workspaceUi.states.rejected');
  },
  get expired() {
    return i18n.t('workspaceUi.states.expired');
  },
  get queued() {
    return i18n.t('workspaceUi.states.queued');
  },
  get running() {
    return i18n.t('workspaceUi.states.running');
  },
  get retry_wait() {
    return i18n.t('workspaceUi.states.retry_wait');
  },
  get paused_budget() {
    return i18n.t('workspaceUi.states.paused_budget');
  },
  get paused_auth() {
    return i18n.t('workspaceUi.states.paused_auth');
  },
  get paused_authorization() {
    return i18n.t('workspaceUi.states.paused_authorization');
  },
  get disabled() {
    return i18n.t('workspaceUi.states.disabled');
  },
  get revoked() {
    return i18n.t('workspaceUi.states.revoked');
  },
  get cancel_requested() {
    return i18n.t('workspaceUi.states.cancel_requested');
  },
  get cancelled() {
    return i18n.t('workspaceUi.states.cancelled');
  },
  get succeeded() {
    return i18n.t('workspaceUi.states.succeeded');
  },
  get partial() {
    return i18n.t('workspaceUi.states.partial');
  },
  get partial_success() {
    return i18n.t('workspaceUi.states.partial_success');
  },
  get failed() {
    return i18n.t('workspaceUi.states.failed');
  },
  get interrupted() {
    return i18n.t('workspaceUi.states.interrupted');
  },
  get sent() {
    return i18n.t('workspaceUi.states.sent');
  },
  get unknown() {
    return i18n.t('workspaceUi.states.unknown');
  },
  get sending() {
    return i18n.t('workspaceUi.states.sending');
  },
  get pending() {
    return i18n.t('workspaceUi.states.pending');
  },
  get ready() {
    return i18n.t('workspaceUi.states.ready');
  },
  get ok() {
    return i18n.t('workspaceUi.states.ok');
  },
  get unconfigured() {
    return i18n.t('workspaceUi.states.unconfigured');
  },
  get not_configured() {
    return i18n.t('workspaceUi.states.not_configured');
  },
  get unverified() {
    return i18n.t('workspaceUi.states.unverified');
  },
  get unsupported() {
    return i18n.t('workspaceUi.states.unsupported');
  },
  get error() {
    return i18n.t('workspaceUi.states.error');
  },
};
export function StateBadge({ state }: { state: string }) {
  const { t } = useTranslation();
  return (
    <HelpText className={`workspace-badge state-${state}`} text={stateHelp[state]}>
      {t(`workspaceUi.states.${state}`, {
        defaultValue: t(`state.${state}`, { defaultValue: stateNames[state] || state }),
      })}
    </HelpText>
  );
}
