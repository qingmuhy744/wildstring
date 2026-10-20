import { useCallback, useEffect, useRef, useState } from 'react';
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
  onOpen: (action: NotificationAction) => void;
}) {
  const [filter, setFilter] = useState('unread');
  const visible = inbox.items.filter((item) =>
    filter === 'unread' ? !item.read_at : filter === 'read' ? !!item.read_at : true,
  );
  return (
    <section className="workspace-page" aria-label="通知中心">
      <WorkspaceHeader
        eyebrow="YOUR INBOX"
        title="每一件事，都有回音。"
        description="优先显示未读消息；已读通知收进记录，随时可查。打开列表不会自动标为已读。"
      >
        <RefreshWorkspace busy={inbox.busy} onClick={() => void inbox.refresh(true)} />
      </WorkspaceHeader>
      <WorkspaceNotice error={inbox.error} unavailable={inbox.unsupported} />
      {!inbox.unsupported && (
        <>
          <div className="workspace-tabs">
            <button aria-pressed={filter === 'unread'} onClick={() => setFilter('unread')}>
              未读 · {inbox.unread}
            </button>
            <button aria-pressed={filter === 'read'} onClick={() => setFilter('read')}>
              已读记录
            </button>
            <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              全部通知
            </button>
            <button
              data-help="只更新当前账号的已读状态，不删除通知，也不会接受草案或应用资料。"
              disabled={!inbox.unread || inbox.busy}
              onClick={() => void inbox.read()}
            >
              将当前通知标为已读
            </button>
          </div>
          <div className="workspace-card">
            {!visible.length && (
              <p className="workspace-empty" role="status">
                {inbox.busy
                  ? '正在读取通知…'
                  : filter === 'unread'
                    ? '没有未读通知，已处理的消息可在已读记录中查看。'
                    : filter === 'read'
                      ? '暂无已读记录。'
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
                          label: '查看草案',
                          params: { id: item.draft_id! },
                        })
                      }
                    >
                      查看草案
                    </button>
                  )}
                  {!item.actions?.length && item.task_id && (
                    <button
                      onClick={() =>
                        onOpen({
                          id: 'task',
                          target: 'task',
                          label: '查看任务',
                          params: { id: item.task_id! },
                        })
                      }
                    >
                      查看任务
                    </button>
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
