import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { AgentNotification, NotificationPage } from './agent-api';
import {
  DiagnosticId,
  errorText,
  localDate,
  RefreshWorkspace,
  WorkspaceHeader,
  WorkspaceNotice,
} from './workspace-ui';

export function useNotifications(userId: string) {
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
  const refresh = useCallback(async function pull(full = false): Promise<void> {
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
          if (++pages > 1000) throw new Error('通知较多，请稍后刷新继续补拉。');
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
        if (++pages > 1000) throw new Error('通知较多，请稍后刷新继续补拉。');
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
  }, []);
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
  onOpen: (kind: 'drafts' | 'tasks', id: string) => void;
}) {
  const [filter, setFilter] = useState('all');
  const visible = filter === 'unread' ? inbox.items.filter((item) => !item.read_at) : inbox.items;
  return (
    <section className="workspace-page" aria-label="通知中心">
      <WorkspaceHeader
        eyebrow="YOUR INBOX"
        title="每一件事，都有回音。"
        description="任务结果和待确认建议会保留在这里。打开列表不会自动标为已读。"
      >
        <RefreshWorkspace busy={inbox.busy} onClick={() => void inbox.refresh(true)} />
      </WorkspaceHeader>
      <WorkspaceNotice error={inbox.error} unavailable={inbox.unsupported} />
      {!inbox.unsupported && (
        <>
          <div className="workspace-tabs">
            <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              全部通知
            </button>
            <button aria-pressed={filter === 'unread'} onClick={() => setFilter('unread')}>
              未读 · {inbox.unread}
            </button>
            <button disabled={!inbox.unread || inbox.busy} onClick={() => void inbox.read()}>
              将当前通知标为已读
            </button>
          </div>
          <div className="workspace-card">
            {!visible.length && (
              <p className="workspace-empty" role="status">
                {inbox.busy
                  ? '正在读取通知…'
                  : filter === 'unread'
                    ? '没有未读通知。'
                    : '还没有通知，继续听歌吧。'}
              </p>
            )}
            {visible.map((item) => (
              <article className="notification-row" key={item.id}>
                <span
                  className={`notification-dot ${item.read_at ? '' : 'unread'}`}
                  aria-label={item.read_at ? '已读' : '未读'}
                />
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.summary}</p>
                  <small>
                    {localDate(item.created_at)} ·{' '}
                    {item.severity === 'error'
                      ? '需要处理'
                      : item.severity === 'warning'
                        ? '请留意'
                        : '结果通知'}
                  </small>
                  <DiagnosticId id={item.trace_id} />
                </div>
                <div className="workspace-actions">
                  {item.draft_id && (
                    <button onClick={() => onOpen('drafts', item.draft_id!)}>查看草案</button>
                  )}
                  {item.task_id && (
                    <button onClick={() => onOpen('tasks', item.task_id!)}>查看任务</button>
                  )}
                  {!item.read_at && (
                    <button
                      aria-label={`标为已读 ${item.title}`}
                      onClick={() => void inbox.read([item.id])}
                    >
                      标为已读
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
