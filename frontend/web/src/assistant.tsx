import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import type { AgentPage, Conversation } from './agent-api';
import { ModelConnectionChoice, useModelConnections } from './model-connection';
import { RowMenu } from './row-menu';
import { AssistantMarkdown } from './assistant-markdown';
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
  const { t, i18n } = useTranslation();
  const sessions = useWorkspaceResource<AgentPage<Conversation>>('/agent/conversations?limit=100'),
    connections = useModelConnections();
  const [selected, setSelected] = useState<string | null>(null),
    [conversation, setConversation] = useState<Conversation | null>(null),
    [content, setContent] = useState(''),
    [connection, setConnection] = useState('local'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [historyAction, setHistoryAction] = useState<{
    kind: 'rename' | 'delete';
    session: Conversation;
  } | null>(null);
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
    let cancelled = false;
    const sync = () => {
      if (!document.hidden && selected && !busy)
        void api<Conversation>(`/agent/conversations/${selected}`)
          .then((value) => {
            if (!cancelled) setConversation(value);
          })
          .catch((reason) => {
            if (!cancelled) setError(errorText(reason));
          });
    };
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('online', sync);
    return () => {
      cancelled = true;
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
  const running = conversation?.runs?.some((run) => run.status === 'running') || false;
  useEffect(() => {
    if (!selected || (!busy && !running)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let active: AbortController | null = null;
    const refresh = async () => {
      if (!document.hidden) {
        active = new AbortController();
        try {
          const value = await api<Conversation>(`/agent/conversations/${selected}`, {
            signal: active.signal,
          });
          if (!stopped)
            setConversation((current) => {
              if (current?.id !== value.id) return current;
              if ((value.messages?.length || 0) < (current.messages?.length || 0)) return current;
              const stale = value.runs?.some(
                (run) =>
                  run.status === 'running' &&
                  current.runs?.some((saved) => saved.id === run.id && saved.status !== 'running'),
              );
              return stale ? current : value;
            });
        } catch {
          /* Sending keeps its own diagnostic and can recover saved progress. */
        }
      }
      if (!stopped) timer = setTimeout(refresh, 650);
    };
    timer = setTimeout(refresh, 300);
    return () => {
      stopped = true;
      clearTimeout(timer);
      active?.abort();
    };
  }, [selected, busy, running]);
  async function send() {
    if (busy || running || !content.trim()) return;
    const text = content.trim(),
      epoch = ++sequence.current;
    setBusy(true);
    setError('');
    setNotice(t('assistant.searchingNotice'));
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
        body: JSON.stringify({
          content: text,
          connection_id: connection,
          locale: i18n.language.startsWith('zh') ? 'zh' : 'en',
        }),
      });
      if (epoch !== sequence.current) return;
      setConversation(result);
      setContent('');
      setNotice('');
      void sessions.reload();
    } catch (reason) {
      if (epoch === sequence.current) {
        setError(errorText(reason));
        setNotice(t('assistant.interruptedNotice'));
      }
    } finally {
      if (epoch === sequence.current) {
        setBusy(false);
        connections.reload();
      }
    }
  }
  async function changeHistory(title: string) {
    if (!historyAction || busy) return;
    const { session, kind } = historyAction;
    setBusy(true);
    setError('');
    try {
      if (kind === 'rename') {
        const changed = await api<Conversation>(`/agent/conversations/${session.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ title: title.trim() }),
        });
        setConversation((current) =>
          current?.id === session.id ? { ...current, title: changed.title } : current,
        );
        setNotice(t('assistant.renamed'));
      } else {
        await api(`/agent/conversations/${session.id}`, { method: 'DELETE' });
        if (selected === session.id) {
          setSelected(null);
          setConversation(null);
        }
        setNotice(t('assistant.deleted'));
      }
      setHistoryAction(null);
      await sessions.reload();
    } finally {
      setBusy(false);
    }
  }
  const activeConnection = connections.items.find((item) => item.id === connection);
  return (
    <section className="workspace-page" aria-label={t('assistant.aria')}>
      <WorkspaceHeader title={t('assistant.title')} description={t('assistant.description')}>
        <button
          disabled={busy}
          onClick={() => {
            setSelected(null);
            setConversation(null);
            setError('');
            setNotice('');
          }}
        >
          {t('assistant.newChat')}
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
              <h2>{t('assistant.recent')}</h2>
              <div className="workspace-session-list">
                {sessions.value?.items.map((session) => (
                  <RowMenu
                    className="workspace-session-entry"
                    key={session.id}
                    label={session.title}
                    disabled={busy}
                    actions={[
                      {
                        label: t('assistant.rename'),
                        icon: 'edit',
                        run: () => setHistoryAction({ kind: 'rename', session }),
                      },
                      {
                        label: t('assistant.delete'),
                        icon: 'remove',
                        danger: true,
                        run: () => setHistoryAction({ kind: 'delete', session }),
                      },
                    ]}
                  >
                    <button
                      className="workspace-session"
                      aria-pressed={selected === session.id}
                      disabled={busy}
                      onClick={() => setSelected(session.id)}
                    >
                      {session.title}
                    </button>
                  </RowMenu>
                ))}
                {!sessions.value?.items.length && (
                  <p className="muted">{t('assistant.emptySessions')}</p>
                )}
              </div>
            </aside>
          )}
          <div className="workspace-card">
            <div className="workspace-card-head">
              <div className="workspace-connection-strip">
                <ModelConnectionChoice
                  items={connections.items}
                  value={connection}
                  onChange={setConnection}
                  label={t('assistant.connection')}
                  disabled={busy || connections.loading}
                  onManage={onConnections}
                />
                <span className="connection-subtle-hint">
                  {activeConnection
                    ? t('assistant.connected', { model: activeConnection.model })
                    : connection === 'local'
                      ? t('assistant.localMode')
                      : t('assistant.connectionUnavailable')}
                </span>
              </div>
              {conversation && (
                <button
                  disabled={busy}
                  className="text-button"
                  onClick={() => setHistoryAction({ kind: 'delete', session: conversation })}
                >
                  {t('assistant.deleteConversation')}
                </button>
              )}
            </div>
            <div ref={messages} aria-busy={running}>
              {conversation?.context_summary && (
                <details className="workspace-notice">
                  <summary>{t('assistant.summaryOpen')}</summary>
                  <p>{conversation.context_summary.summary}</p>
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (confirm(t('assistant.clearSummaryConfirm')))
                        void api(`/agent/conversations/${conversation.id}/summary`, {
                          method: 'DELETE',
                        })
                          .then(() => setConversation({ ...conversation, context_summary: null }))
                          .catch((reason) => setError(errorText(reason)));
                    }}
                  >
                    {t('assistant.clearSummary')}
                  </button>
                </details>
              )}
              {!conversation?.messages?.length && (
                <div className="workspace-empty-guide">
                  <div className="workspace-empty-icon">✦</div>
                  <h3>{t('assistant.emptyTitle')}</h3>
                  <p className="muted">{t('assistant.emptyDescription')}</p>
                  <div className="workspace-prompts">
                    {[
                      t('assistant.prompt1'),
                      t('assistant.prompt2'),
                      t('assistant.prompt3'),
                      t('assistant.prompt4'),
                    ].map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        className="prompt-pill"
                        disabled={busy}
                        onClick={() => {
                          setContent(prompt);
                        }}
                      >
                        “{prompt}”
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {conversation?.messages?.map((message) => (
                <article className={`workspace-message ${message.role}`} key={message.id}>
                  <small>
                    {message.role === 'user' ? t('assistant.you') : t('assistant.brand')} ·{' '}
                    {localDate(message.created_at)}
                  </small>
                  {message.partial && (
                    <small className="assistant-generating">{t('assistant.generating')}</small>
                  )}
                  {message.role === 'assistant' ? (
                    <AssistantMarkdown content={message.content} />
                  ) : (
                    <p>{message.content}</p>
                  )}
                  {!!message.sources?.length && (
                    <ul aria-label={t('assistant.sourcesAria')}>
                      {message.sources.map((source) => (
                        <li key={source.id}>
                          <a href={source.url} target="_blank" rel="noopener noreferrer">
                            {source.title}
                          </a>
                          {source.published_at && (
                            <small>
                              {' '}
                              · {t('assistant.sourceDate', { date: source.published_at })}
                            </small>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              ))}
              {conversation?.runs?.map((run) => (
                <div className="workspace-run" key={run.id}>
                  {run.status === 'local_fallback' ? (
                    <p className="workspace-notice">{t('assistant.localFallback')}</p>
                  ) : (
                    <StateBadge state={run.status} />
                  )}
                  {(run.error_code || run.status === 'failed' || run.status === 'interrupted') && (
                    <DiagnosticId id={run.trace_id} />
                  )}
                  {run.error_code && <p className="muted">{run.error_code}</p>}
                  <div className="workspace-actions">
                    {run.draft_ids.map((id) => (
                      <button key={id} onClick={() => onDraft(id)}>
                        {t('assistant.viewDraft')}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {running && (
              <p className="assistant-live-status" role="status">
                {
                  (
                    {
                      model: t('assistant.stageModel'),
                      search: t('assistant.stageSearch'),
                      tools: t('assistant.stageTools'),
                      writing: t('assistant.stageWriting'),
                    } as Record<string, string>
                  )[conversation?.runs?.find((run) => run.status === 'running')?.stage || 'model']
                }
              </p>
            )}
            <form
              className="assistant-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label>
                <span className="sr-only">{t('assistant.messageLabel')}</span>
                <textarea
                  aria-label={t('assistant.messageLabel')}
                  placeholder={t('assistant.placeholder')}
                  required
                  maxLength={8000}
                  value={content}
                  disabled={busy || running}
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
              <button className="primary" disabled={busy || running || !content.trim()}>
                {busy ? t('assistant.processing') : t('assistant.send')}
              </button>
            </form>
            <p className="muted">{t('assistant.keyboardHint')}</p>
          </div>
        </div>
      )}
      {historyAction && (
        <ConversationActionDialog
          action={historyAction}
          onClose={() => setHistoryAction(null)}
          onSubmit={changeHistory}
        />
      )}
    </section>
  );
}

function ConversationActionDialog({
  action,
  onClose,
  onSubmit,
}: {
  action: { kind: 'rename' | 'delete'; session: Conversation };
  onClose: () => void;
  onSubmit: (title: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(action.session.title);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const rename = action.kind === 'rename';
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="playlist-editor"
      aria-label={rename ? t('assistant.dialogRename') : t('assistant.dialogDelete')}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2>{rename ? t('assistant.dialogRename') : t('assistant.dialogDeleteQuestion')}</h2>
      <form
        className="account-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || (rename && !title.trim())) return;
          setBusy(true);
          setError('');
          void onSubmit(title)
            .catch((reason) => setError(errorText(reason)))
            .finally(() => setBusy(false));
        }}
      >
        {rename ? (
          <label>
            {t('assistant.dialogName')}
            <input
              autoFocus
              required
              maxLength={200}
              value={title}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
        ) : (
          <p>{t('assistant.dialogDeleteBody', { title: action.session.title })}</p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="workspace-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            {t('assistant.cancel')}
          </button>
          <button className="primary" disabled={busy || (rename && !title.trim())}>
            {busy
              ? t('assistant.processing')
              : rename
                ? t('assistant.save')
                : t('assistant.delete')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
