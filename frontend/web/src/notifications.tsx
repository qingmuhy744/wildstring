import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from './api';
import type { AgentNotification, NotificationAction, NotificationPage } from './agent-api';
import {
  DiagnosticId,
  errorText,
  localDate,
  RefreshWorkspace,
  WorkspaceHeader,
  WorkspaceNotice,
} from './workspace-ui';

export function useNotifications(userId: string) {
  const { t } = useTranslation();
  const [items, setItems] = useState<AgentNotification[]>([]),
    [unread, setUnread] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [unsupported, setUnsupported] = useState(false),
    [watermark, setWatermark] = useState(0);
  const cursor = useRef<string | null>(null),
    request = useRef<AbortController | null>(null),
    mounted = useRef(true),
    account = useRef(userId),
    unsupportedRef = useRef(false),
    queued = useRef<boolean | null>(null);
  const refresh = useCallback(
    async function pull(full = false): Promise<void> {
      if (document.hidden || !navigator.onLine || (unsupportedRef.current && !full)) return;
      if (request.current) {
        // A reconnect/read can happen after the in-flight snapshot was taken.
        // Coalesce it into one follow-up instead of losing the newer signal.
        queued.current = full || queued.current === true;
        return;
      }
      const controller = new AbortController();
      request.current = controller;
      const owner = account.current;
      setBusy(true);
      setError('');
      try {
        let next = full ? null : cursor.current,
          reset = full || !cursor.current,
          remaining = true;
        const incoming = new Map<string, AgentNotification>();
        let latestUnread = 0,
          latestWatermark = 0,
          pages = 0;
        const absorb = (response: NotificationPage) => {
          for (const item of response.items) {
            const prior = incoming.get(item.id);
            if (!prior || item.version >= prior.version) incoming.set(item.id, item);
          }
          latestUnread = response.unread_count;
          latestWatermark = response.high_watermark;
        };
        if (reset) {
          let offset = 0,
            initialCursor: string | null = null;
          while (!controller.signal.aborted) {
            if (++pages > 1000) throw new Error(t('notificationsPage.tooManyNotifications'));
            const response = await api<NotificationPage>(
              `/agent/notifications?limit=100&offset=${offset}`,
              { signal: controller.signal },
            );
            absorb(response);
            if (offset === 0) initialCursor = response.next_cursor;
            offset += response.items.length;
            if (offset >= response.total || response.items.length < 100) break;
          }
          next = initialCursor;
        }
        while (remaining && next && !controller.signal.aborted) {
          if (++pages > 1000) throw new Error(t('notificationsPage.tooManyNotifications'));
          let response: NotificationPage;
          try {
            response = await api<NotificationPage>(
              `/agent/notifications?limit=100&cursor=${encodeURIComponent(next)}`,
              { signal: controller.signal },
            );
          } catch (reason) {
            throw reason;
          }
          absorb(response);
          const previous = next;
          next = response.next_cursor;
          remaining = response.items.length === 100 && !!next && next !== previous;
        }
        if (controller.signal.aborted || !mounted.current || owner !== account.current) return;
        cursor.current = next;
        setItems((old) => {
          const merged = reset
            ? new Map<string, AgentNotification>()
            : new Map(old.map((n) => [n.id, n]));
          for (const item of incoming.values()) {
            const prior = merged.get(item.id);
            if (!prior || item.version >= prior.version) merged.set(item.id, item);
          }
          return [...merged.values()].sort(
            (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
          );
        });
        setUnread(latestUnread);
        setWatermark(latestWatermark);
        unsupportedRef.current = false;
        setUnsupported(false);
      } catch (reason) {
        if (controller.signal.aborted || !mounted.current || owner !== account.current) return;
        if (reason instanceof ApiError && reason.status === 410 && !full) {
          cursor.current = null;
          if (request.current === controller) request.current = null;
          await pull(true);
          return;
        }
        if (reason instanceof ApiError && [404, 405, 501].includes(reason.status)) {
          unsupportedRef.current = true;
          setUnsupported(true);
          setItems([]);
          setUnread(0);
        } else setError(errorText(reason));
      } finally {
        if (request.current === controller) {
          request.current = null;
          const followUp = queued.current;
          queued.current = null;
          if (mounted.current) {
            setBusy(false);
            if (followUp !== null && owner === account.current) void pull(followUp);
          }
        }
      }
    },
    [t],
  );
  useEffect(() => {
    mounted.current = true;
    account.current = userId;
    cursor.current = null;
    queued.current = null;
    unsupportedRef.current = false;
    setItems([]);
    setUnread(0);
    setWatermark(0);
    setUnsupported(false);
    void refresh(true);
    const foreground = () => {
      if (document.hidden) {
        queued.current = null;
        request.current?.abort();
      } else void refresh();
    };
    document.addEventListener('visibilitychange', foreground);
    window.addEventListener('online', foreground);
    const timer = setInterval(() => void refresh(), 300000);
    return () => {
      mounted.current = false;
      queued.current = null;
      request.current?.abort();
      request.current = null;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', foreground);
      window.removeEventListener('online', foreground);
    };
  }, [userId, refresh]);
  async function read(ids?: string[]) {
    setError('');
    try {
      await api(`/agent/notifications/${ids ? 'read' : 'read-all'}`, {
        method: 'POST',
        body: JSON.stringify(ids ? { ids } : { high_watermark: watermark }),
      });
      await refresh();
    } catch (reason) {
      setError(errorText(reason));
    }
  }
  return { items, unread, busy, error, unsupported, refresh, read, watermark };
}
export type NotificationInbox = ReturnType<typeof useNotifications>;
export function Notifications({
  inbox,
  onOpen,
}: {
  inbox: NotificationInbox;
  onOpen: (action: NotificationAction) => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('unread');
  const visible = inbox.items.filter((item) =>
    filter === 'unread' ? !item.read_at : filter === 'read' ? !!item.read_at : true,
  );
  return (
    <section className="workspace-page" aria-label={t('notificationsPage.sectionAria')}>
      <WorkspaceHeader
        title={t('notificationsPage.title')}
        description={t('notificationsPage.description')}
      >
        <RefreshWorkspace busy={inbox.busy} onClick={() => void inbox.refresh(true)} />
      </WorkspaceHeader>
      <WorkspaceNotice error={inbox.error} unavailable={inbox.unsupported} />
      {!inbox.unsupported && (
        <>
          <div className="workspace-tabs">
            <button aria-pressed={filter === 'unread'} onClick={() => setFilter('unread')}>
              {t('notificationsPage.tabUnread', { count: inbox.unread })}
            </button>
            <button aria-pressed={filter === 'read'} onClick={() => setFilter('read')}>
              {t('notificationsPage.tabRead')}
            </button>
            <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              {t('notificationsPage.tabAll')}
            </button>
            <button
              data-help={t('notificationsPage.markAllReadHelp')}
              disabled={!inbox.unread || inbox.busy}
              onClick={() => void inbox.read()}
            >
              {t('notificationsPage.markAllRead')}
            </button>
          </div>
          <div className="workspace-card">
            {!visible.length && (
              <p className="workspace-empty" role="status">
                {inbox.busy
                  ? t('notificationsPage.loading')
                  : filter === 'unread'
                    ? t('notificationsPage.emptyUnread')
                    : filter === 'read'
                      ? t('notificationsPage.emptyRead')
                      : t('notificationsPage.emptyAll')}
              </p>
            )}
            {visible.map((item) => (
              <article className="notification-row" key={item.id}>
                <span
                  className={`notification-dot ${item.read_at ? '' : 'unread'}`}
                  aria-label={
                    item.read_at ? t('notificationsPage.dotRead') : t('notificationsPage.dotUnread')
                  }
                />
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.summary}</p>
                  <small>
                    {localDate(item.created_at)} ·{' '}
                    {item.severity === 'error'
                      ? t('notificationsPage.severityError')
                      : item.severity === 'warning'
                        ? t('notificationsPage.severityWarning')
                        : t('notificationsPage.severityInfo')}
                  </small>
                  <DiagnosticId id={item.trace_id} />
                </div>
                <div className="workspace-actions">
                  {(item.actions || []).map((action) => (
                    <button
                      key={action.id}
                      className={action.id === item.actions?.[0]?.id ? 'primary' : undefined}
                      onClick={() => onOpen(action)}
                    >
                      {action.label}
                      {typeof action.count === 'number' && action.count > 0
                        ? ` · ${action.count}`
                        : ''}
                    </button>
                  ))}
                  {!item.actions?.length && item.draft_id && (
                    <button
                      onClick={() =>
                        onOpen({
                          id: 'draft',
                          target: 'draft',
                          label: t('notificationsPage.viewDraft'),
                          params: { id: item.draft_id! },
                        })
                      }
                    >
                      {t('notificationsPage.viewDraft')}
                    </button>
                  )}
                  {!item.actions?.length && item.task_id && (
                    <button
                      onClick={() =>
                        onOpen({
                          id: 'task',
                          target: 'task',
                          label: t('notificationsPage.viewTask'),
                          params: { id: item.task_id! },
                        })
                      }
                    >
                      {t('notificationsPage.viewTask')}
                    </button>
                  )}
                  {!item.read_at && (
                    <button
                      aria-label={t('notificationsPage.markReadAria', { title: item.title })}
                      onClick={() => void inbox.read([item.id])}
                    >
                      {t('notificationsPage.markRead')}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
