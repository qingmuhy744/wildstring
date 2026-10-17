import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { AgentPage, Conversation } from './agent-api';
import { ModelConnectionChoice, useModelConnections } from './model-connection';
import {
  DiagnosticId,
  errorText,
  localDate,
  RefreshWorkspace,
  StateBadge,
  useWorkspaceResource,
  WorkspaceHeader,
  WorkspaceNotice,
} from './workspace-ui';

export function Assistant({
  onDraft,
  onConnections,
}: {
  onDraft: (id: string) => void;
  onConnections?: () => void;
}) {
  const sessions = useWorkspaceResource<AgentPage<Conversation>>('/agent/conversations?limit=100'),
    connections = useModelConnections();
  const [selected, setSelected] = useState<string | null>(null),
    [conversation, setConversation] = useState<Conversation | null>(null),
    [content, setContent] = useState(''),
    [connection, setConnection] = useState('local'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null),
    sequence = useRef(0),
    messages = useRef<HTMLDivElement>(null);
  useEffect(() => {
    request.current?.abort();
    setConversation(null);
    setError('');
    if (!selected) return;
    const controller = new AbortController();
    request.current = controller;
    void api<Conversation>(`/agent/conversations/${selected}`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) {
          setConversation(value);
          setConnection(value.connection_id || 'local');
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(errorText(reason));
      });
    return () => controller.abort();
  }, [selected]);
  useEffect(() => {
    const sync = () => {
      if (!document.hidden && selected && !busy)
        void api<Conversation>(`/agent/conversations/${selected}`)
          .then(setConversation)
          .catch((reason) => setError(errorText(reason)));
    };
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('online', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('online', sync);
    };
  }, [selected, busy]);
  useEffect(
    () => () => {
      ++sequence.current;
      request.current?.abort();
    },
    [],
  );
  async function send() {
    if (busy || !content.trim()) return;
    const text = content.trim(),
      epoch = ++sequence.current;
    setBusy(true);
    setError('');
    setNotice('正在查找依据，歌曲会继续播放。');
    const controller = new AbortController();
    request.current = controller;
    try {
      let session = conversation;
      if (!session) {
        session = await api<Conversation>('/agent/conversations', {
          method: 'POST',
          body: JSON.stringify({ title: text.slice(0, 80), connection_id: connection }),
          signal: controller.signal,
        });
        if (epoch !== sequence.current) return;
        setSelected(session.id);
        setConversation(session);
      }
      // A new conversation changes selection; use a separate controller for this run.
      const result = await api<Conversation>(`/agent/conversations/${session.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: text, connection_id: connection, max_calls: 4 }),
      });
      if (epoch !== sequence.current) return;
      setConversation(result);
      setContent('');
      setNotice('');
      void sessions.reload();
    } catch (reason) {
      if (epoch === sequence.current) {
        setError(errorText(reason));
        setNotice('连接中断时，服务端可能仍在处理。刷新对话可恢复已保存结果。');
      }
    } finally {
      if (epoch === sequence.current) {
        setBusy(false);
        connections.reload();
      }
    }
  }
  async function remove() {
    if (!selected || busy || !confirm('删除这段对话？已保存的草案和歌单会保留。')) return;
    setBusy(true);
    setError('');
    try {
      await api(`/agent/conversations/${selected}`, { method: 'DELETE' });
      setSelected(null);
      setConversation(null);
      await sessions.reload();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  const activeConnection = connections.items.find((item) => item.id === connection);
  return (
    <section className="workspace-page" aria-label="AI 音乐助手">
      <WorkspaceHeader
        eyebrow="A LITTLE HELP FINDING YOUR SOUND"
        title="聊聊，想听什么。"
        description="从真实曲库找歌、调整候选、生成草案。保存和修改前，你始终有最后一次确认。"
      >
        <button
          disabled={busy}
          onClick={() => {
            setSelected(null);
            setConversation(null);
            setError('');
            setNotice('');
          }}
        >
          新对话
        </button>
        <RefreshWorkspace
          busy={sessions.loading || busy}
          onClick={() => {
            void sessions.reload();
            if (selected)
              void api<Conversation>(`/agent/conversations/${selected}`)
                .then(setConversation)
                .catch((reason) => setError(errorText(reason)));
          }}
        />
      </WorkspaceHeader>
      <WorkspaceNotice
        error={error || sessions.error || connections.error}
        notice={notice}
        unavailable={sessions.unsupported}
      />
      {!sessions.unsupported && (
        <div
          className={`workspace-two-column ${sessions.value?.items.length ? '' : 'no-sessions'}`}
        >
          {!!sessions.value?.items.length && (
            <aside className="workspace-card">
              <h2>最近对话</h2>
              <div className="workspace-session-list">
                {sessions.value?.items.map((session) => (
                  <button
                    className="workspace-session"
                    key={session.id}
                    aria-pressed={selected === session.id}
                    disabled={busy}
                    onClick={() => setSelected(session.id)}
                  >
                    {session.title}
                  </button>
                ))}
                {!sessions.value?.items.length && <p className="muted">从一首歌、一种心情开始。</p>}
              </div>
            </aside>
          )}
          <div className="workspace-card">
            <div className="workspace-card-head">
              <ModelConnectionChoice
                items={connections.items}
                value={connection}
                onChange={setConnection}
                label="助手模型连接"
                disabled={busy || connections.loading}
                onManage={onConnections}
              />
              {selected && (
                <button disabled={busy} onClick={() => void remove()}>
                  删除对话
                </button>
              )}
            </div>
            <p className="muted">
              {activeConnection
                ? `使用 ${activeConnection.model}，每轮最多 4 次模型调用。`
                : connection === 'local'
                  ? '当前使用本地曲库检索，不会调用外部模型。'
                  : '之前选择的连接已不可用，请重新选择。'}
            </p>
            <div ref={messages} aria-live="polite">
              {!conversation?.messages?.length && (
                <div className="workspace-empty">试试“找出许嵩的歌，先给我一份歌单草案”。</div>
              )}
              {conversation?.messages?.map((message) => (
                <article className={`workspace-message ${message.role}`} key={message.id}>
                  <small>
                    {message.role === 'user' ? '你' : '野弦'} · {localDate(message.created_at)}
                  </small>
                  <p>{message.content}</p>
                </article>
              ))}
              {conversation?.runs?.map((run) => (
                <div className="workspace-run" key={run.id}>
                  {run.status === 'local_fallback' ? (
                    <p className="workspace-notice">本地关键词检索 · 未调用模型</p>
                  ) : (
                    <StateBadge state={run.status} />
                  )}
                  <DiagnosticId id={run.trace_id} />
                  {run.error_code && <p className="muted">{run.error_code}</p>}
                  <div className="workspace-actions">
                    {run.draft_ids.map((id) => (
                      <button key={id} onClick={() => onDraft(id)}>
                        查看待确认草案
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <form
              className="assistant-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label>
                <span className="sr-only">给助手的消息</span>
                <textarea
                  aria-label="给助手的消息"
                  placeholder="想听什么，或想如何整理候选？"
                  required
                  maxLength={8000}
                  value={content}
                  disabled={busy}
                  onChange={(e) => setContent(e.target.value)}
                  onFocus={(event) => {
                    if (matchMedia('(max-width: 600px)').matches)
                      event.currentTarget.scrollIntoView({ block: 'center' });
                  }}
                  onKeyDown={(e) => {
                    if (
                      e.key === 'Enter' &&
                      (e.ctrlKey || e.metaKey) &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
              </label>
              <button className="primary" disabled={busy || !content.trim()}>
                {busy ? '正在处理…' : '发送'}
              </button>
            </form>
            <p className="muted">Ctrl / ⌘ + Enter 发送。聊天不会自行启动定时巡检。</p>
          </div>
        </div>
      )}
    </section>
  );
}
