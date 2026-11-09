import { McpOnboarding } from './mcp-onboarding';
import { HelpLabel, HelpText } from './desktop-help';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type User } from './api';
import { AISettings } from './ai-settings';
import { useModelConnections } from './model-connection';
import type { AgentConnection, AgentPage, ToolCredential } from './agent-api';
import {
  DiagnosticId,
  errorText,
  localDate,
  StateBadge,
  useWorkspaceResource,
  WorkspaceNotice,
} from './workspace-ui';

const empty = {
  name: '',
  scope: 'personal',
  base_url: '',
  model: '',
  api_key: '',
  clear_api_key: false,
  timeout: 90,
  shared: false,
  background_allowed: false,
  daily_call_budget: 100,
  enabled: true,
  protocol: 'chat_completions',
  provider: 'generic',
  reasoning_effort: 'low',
  max_output_tokens: 8192,
  native_search: false,
  stream_output: true,
};
const isOwner = (user: User) => user.profile === 'owner';
export function AgentConnections({ user }: { user: User }) {
  const { t } = useTranslation();
  const list = useModelConnections(),
    policy = useWorkspaceResource<{ allowed_hosts: string[]; allow_private: boolean }>(
      isOwner(user) ? '/agent/endpoint-policy' : null,
    );
  const [form, setForm] = useState({ ...empty }),
    [editing, setEditing] = useState<AgentConnection | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [test, setTest] = useState<{ id: string; value: Record<string, unknown> } | null>(null),
    [hosts, setHosts] = useState(''),
    [privateHosts, setPrivateHosts] = useState(false);
  useEffect(() => {
    if (policy.value) {
      setHosts(policy.value.allowed_hosts.join('\n'));
      setPrivateHosts(policy.value.allow_private);
    }
  }, [policy.value]);
  function edit(item: AgentConnection) {
    setEditing(item);
    setForm({
      name: item.name,
      scope: item.scope,
      base_url: item.base_url,
      model: item.model,
      api_key: '',
      clear_api_key: false,
      timeout: item.timeout,
      shared: item.shared,
      background_allowed: item.background_allowed,
      daily_call_budget: item.daily_call_budget,
      enabled: item.enabled,
      protocol: item.protocol || 'chat_completions',
      provider: item.provider || 'generic',
      reasoning_effort: item.reasoning_effort || 'auto',
      max_output_tokens: item.max_output_tokens || 2048,
      native_search: item.native_search || false,
      stream_output: item.stream_output !== false,
    });
    setError('');
    setNotice('');
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(`/agent/connections${editing ? `/${editing.id}` : ''}`, {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify({
          ...form,
          api_key: form.api_key || undefined,
          ...(editing ? { version: editing.version } : {}),
        }),
      });
      setForm({ ...empty });
      setEditing(null);
      setNotice(t('agentSettings.saveSuccessNotice'));
      await list.reload();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function action(item: AgentConnection, kind: 'test' | 'delete') {
    if (busy) return;
    if (kind === 'delete' && !confirm(t('agentSettings.deleteConfirm', { name: item.name })))
      return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = await api<Record<string, unknown>>(
        `/agent/connections/${item.id}${kind === 'test' ? '/test' : ''}`,
        { method: kind === 'test' ? 'POST' : 'DELETE', ...(kind === 'test' ? { body: '{}' } : {}) },
      );
      if (kind === 'test') setTest({ id: item.id, value });
      else {
        if (editing?.id === item.id) {
          setEditing(null);
          setForm({ ...empty });
        }
        setNotice(t('agentSettings.deleteSuccessNotice'));
      }
      await list.reload();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function savePolicy() {
    setBusy(true);
    setError('');
    try {
      await api('/agent/endpoint-policy', {
        method: 'PUT',
        body: JSON.stringify({
          allowed_hosts: hosts
            .split(/[\n,]/)
            .map((h) => h.trim())
            .filter(Boolean),
          allow_private: privateHosts,
        }),
      });
      setNotice(t('agentSettings.policySavedNotice'));
      await policy.reload();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workspace-card" aria-label={t('agentSettings.ariaLabel')}>
      <div className="workspace-card-head">
        <div>
          <h2>{t('agentSettings.title')}</h2>
          <p className="muted">{t('agentSettings.subtitle')}</p>
        </div>
        <button disabled={busy || list.loading} onClick={() => void list.reload()}>
          {t('agentSettings.refresh')}
        </button>
      </div>
      <WorkspaceNotice error={error || list.error} notice={notice} unavailable={list.unsupported} />
      {!list.unsupported && (
        <>
          <div>
            {list.items.map((item) => (
              <article className="workspace-row" key={item.id}>
                <div className="workspace-row-main">
                  <strong>{item.name}</strong>
                  <small>
                    {item.model} ·{' '}
                    {item.scope === 'personal'
                      ? t('agentSettings.scopePersonal')
                      : item.shared
                        ? t('agentSettings.scopeShared')
                        : t('agentSettings.scopeAdmin')}
                    {item.id === 'legacy'
                      ? t('agentSettings.legacyBadge')
                      : item.read_only
                        ? t('agentSettings.readOnlyBadge')
                        : ''}
                    <br />
                    {item.background_allowed
                      ? t('agentSettings.backgroundAllowed')
                      : t('agentSettings.manualAllowed')}{' '}
                    · {t('agentSettings.dailyBudget', { count: item.daily_call_budget })}
                    {item.daily_calls_remaining != null
                      ? t('agentSettings.dailyRemaining', { count: item.daily_calls_remaining })
                      : ''}
                    {item.my_usage?.calls != null
                      ? t('agentSettings.myUsage', { count: item.my_usage.calls })
                      : ''}
                  </small>
                  {item.id === 'legacy' && <small>{t('agentSettings.legacyDescription')}</small>}
                </div>
                <StateBadge state={item.enabled ? 'ready' : 'disabled'} />
                <div className="workspace-actions">
                  {!item.read_only && (
                    <>
                      <button disabled={busy} onClick={() => edit(item)}>
                        {t('agentSettings.editConnection')}
                      </button>
                      <button
                        disabled={busy || !item.enabled}
                        onClick={() => void action(item, 'test')}
                      >
                        {t('agentSettings.testCapabilities')}
                      </button>
                      <button disabled={busy} onClick={() => void action(item, 'delete')}>
                        {t('agentSettings.revokeConnection')}
                      </button>
                    </>
                  )}
                </div>
                {(item.capabilities || test?.id === item.id) && (
                  <Capabilities value={test?.id === item.id ? test.value : item.capabilities!} />
                )}
              </article>
            ))}
          </div>
          <form onSubmit={(e) => void save(e)}>
            <h3>{editing ? t('agentSettings.editTitle') : t('agentSettings.addTitle')}</h3>
            <div className="workspace-form">
              <label>
                <HelpLabel hint="aiProtocol">{t('agentSettings.apiProtocol')}</HelpLabel>
                <select
                  aria-label={t('agentSettings.apiProtocol')}
                  value={form.protocol}
                  onChange={(e) =>
                    setForm({ ...form, protocol: e.target.value, native_search: false })
                  }
                >
                  <option value="chat_completions">
                    {t('agentSettings.protocolChatCompletions')}
                  </option>
                  <option value="responses">{t('agentSettings.protocolResponses')}</option>
                </select>
              </label>
              <label>
                <HelpLabel hint="aiProvider">{t('agentSettings.providerAdapter')}</HelpLabel>
                <select
                  aria-label={t('agentSettings.providerAdapter')}
                  value={form.provider}
                  onChange={(e) =>
                    setForm({ ...form, provider: e.target.value, native_search: false })
                  }
                >
                  {[
                    ['generic', t('agentSettings.providerGeneric')],
                    ['openai', t('agentSettings.providerOpenai')],
                    ['deepseek', t('agentSettings.providerDeepseek')],
                    ['qwen', t('agentSettings.providerQwen')],
                    ['gemini', t('agentSettings.providerGemini')],
                  ].map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <HelpLabel hint="reasoning">{t('agentSettings.reasoningEffort')}</HelpLabel>
                <select
                  aria-label={t('agentSettings.reasoningEffort')}
                  value={form.reasoning_effort}
                  onChange={(e) => setForm({ ...form, reasoning_effort: e.target.value })}
                >
                  {['auto', 'none', 'low', 'medium', 'high', 'max', 'xhigh'].map((value) => (
                    <option key={value} value={value}>
                      {value === 'auto' ? t('agentSettings.reasoningAuto') : value}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <HelpLabel hint="outputTokens">{t('agentSettings.outputTokens')}</HelpLabel>
                <input
                  aria-label={t('agentSettings.outputTokens')}
                  type="number"
                  min="128"
                  max="32768"
                  value={form.max_output_tokens}
                  onChange={(e) => setForm({ ...form, max_output_tokens: Number(e.target.value) })}
                />
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={form.stream_output}
                  onChange={(e) => setForm({ ...form, stream_output: e.target.checked })}
                />
                <HelpLabel hint="aiStream">{t('agentSettings.streamOutput')}</HelpLabel>
              </label>
              {form.protocol === 'responses' &&
                ['openai', 'deepseek', 'qwen'].includes(form.provider) && (
                  <label>
                    <input
                      type="checkbox"
                      checked={form.native_search}
                      onChange={(e) => setForm({ ...form, native_search: e.target.checked })}
                    />
                    <HelpLabel hint="nativeSearch">{t('agentSettings.nativeSearch')}</HelpLabel>
                  </label>
                )}
              <label>
                {t('agentSettings.nameLabel')}
                <input
                  aria-label={t('agentSettings.nameLabel')}
                  required
                  maxLength={100}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              {isOwner(user) && (
                <label>
                  {t('agentSettings.scopeLabel')}
                  <select
                    aria-label={t('agentSettings.scopeLabel')}
                    value={form.scope}
                    disabled={!!editing}
                    onChange={(e) => setForm({ ...form, scope: e.target.value, shared: false })}
                  >
                    <option value="personal">{t('agentSettings.scopeOptionPersonal')}</option>
                    <option value="instance">{t('agentSettings.scopeOptionInstance')}</option>
                  </select>
                </label>
              )}
              <label>
                {t('agentSettings.baseUrlLabel')}
                <input
                  aria-label={t('agentSettings.baseUrlAriaLabel')}
                  type="url"
                  required
                  maxLength={2048}
                  placeholder="https://api.example/v1"
                  value={form.base_url}
                  onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                />
              </label>
              <label>
                {t('agentSettings.modelLabel')}
                <input
                  aria-label={t('agentSettings.modelAriaLabel')}
                  required
                  maxLength={200}
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                />
              </label>
              <label>
                {t('agentSettings.keyLabel')}
                <input
                  disabled={form.clear_api_key}
                  aria-label={t('agentSettings.keyAriaLabel')}
                  type="password"
                  autoComplete="new-password"
                  maxLength={4096}
                  placeholder={
                    editing?.has_api_key
                      ? t('agentSettings.keyPlaceholderSaved')
                      : t('agentSettings.keyPlaceholderEmpty')
                  }
                  value={form.api_key}
                  onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                />
              </label>
              <label>
                <HelpLabel hint="aiTimeout">{t('agentSettings.timeoutLabel')}</HelpLabel>
                <input
                  type="number"
                  min={1}
                  max={120}
                  required
                  value={form.timeout}
                  onChange={(e) => setForm({ ...form, timeout: Number(e.target.value) })}
                />
              </label>
              <label>
                <HelpLabel hint="aiBudget">{t('agentSettings.dailyBudgetLabel')}</HelpLabel>
                <input
                  type="number"
                  min={1}
                  max={10000}
                  required
                  value={form.daily_call_budget}
                  onChange={(e) => setForm({ ...form, daily_call_budget: Number(e.target.value) })}
                />
              </label>
              <div className="span-all workspace-check-grid">
                {editing?.has_api_key && (
                  <label className="workspace-check">
                    <input
                      type="checkbox"
                      checked={form.clear_api_key}
                      onChange={(e) =>
                        setForm({ ...form, clear_api_key: e.target.checked, api_key: '' })
                      }
                    />
                    {t('agentSettings.clearKey')}
                  </label>
                )}
                <label className="workspace-check">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  />
                  {t('agentSettings.enableConnection')}
                </label>
                <label className="workspace-check">
                  <input
                    type="checkbox"
                    checked={form.background_allowed}
                    onChange={(e) => setForm({ ...form, background_allowed: e.target.checked })}
                  />
                  <HelpLabel hint="backgroundAI">{t('agentSettings.allowBackground')}</HelpLabel>
                </label>
                <p className="muted">{t('agentSettings.backgroundHelp')}</p>
                {isOwner(user) && form.scope === 'instance' && (
                  <label className="workspace-check">
                    <input
                      type="checkbox"
                      checked={form.shared}
                      onChange={(e) => setForm({ ...form, shared: e.target.checked })}
                    />
                    {t('agentSettings.shareWithOthers')}
                  </label>
                )}
              </div>
              <div className="span-all workspace-actions">
                <button className="primary" disabled={busy}>
                  {busy
                    ? t('agentSettings.saving')
                    : editing
                      ? t('agentSettings.saveChanges')
                      : t('agentSettings.addConnection')}
                </button>
                {editing && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditing(null);
                      setForm({ ...empty });
                    }}
                  >
                    {t('agentSettings.cancelEdit')}
                  </button>
                )}
                <small className="muted">{t('agentSettings.capabilitiesNotice')}</small>
              </div>
            </div>
          </form>
          {isOwner(user) && (
            <details className="legacy-ai-compatibility">
              <summary>{t('agentSettings.legacySummary')}</summary>
              <p className="muted">{t('agentSettings.legacyNotice')}</p>
              <AISettings />
            </details>
          )}
          {isOwner(user) && (
            <details>
              <summary>{t('agentSettings.policySummary')}</summary>
              <p className="muted">{t('agentSettings.policyNotice')}</p>
              <label>
                {t('agentSettings.policyHostsLabel')}
                <textarea
                  aria-label={t('agentSettings.policyHostsAriaLabel')}
                  value={hosts}
                  onChange={(e) => setHosts(e.target.value)}
                />
              </label>
              <label className="workspace-check">
                <input
                  type="checkbox"
                  checked={privateHosts}
                  onChange={(e) => setPrivateHosts(e.target.checked)}
                />
                {t('agentSettings.allowPrivateHosts')}
              </label>
              <button disabled={busy || !policy.value} onClick={() => void savePolicy()}>
                {t('agentSettings.savePolicy')}
              </button>
              <WorkspaceNotice error={policy.error} />
            </details>
          )}
        </>
      )}
    </section>
  );
}
function Capabilities({ value }: { value: Record<string, unknown> }) {
  const { t } = useTranslation();
  const capKeyMap: Record<string, string> = {
    text: 'agentSettings.capText',
    structured: 'agentSettings.capStructured',
    tools_roundtrip: 'agentSettings.capToolsRoundtrip',
    native_search: 'agentSettings.capNativeSearch',
    tools: 'agentSettings.capTools',
    tool_calling: 'agentSettings.capTools',
    checked_at: 'agentSettings.capCheckedAt',
    tested_at: 'agentSettings.capCheckedAt',
    trace_id: 'agentSettings.capTraceId',
  };
  return (
    <div className="connection-capabilities">
      <h4>{t('agentSettings.capabilitiesHeading')}</h4>
      {Object.entries(value).map(([key, item]) => (
        <div key={key}>
          <span>{capKeyMap[key] ? t(capKeyMap[key]) : key}</span>
          {typeof item === 'boolean' ? (
            <StateBadge state={item ? 'ok' : 'error'} />
          ) : typeof item === 'object' && item ? (
            <span>
              {Object.entries(item)
                .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                .join(' · ')}
            </span>
          ) : key.includes('_at') ? (
            <span>{localDate(String(item))}</span>
          ) : key === 'trace_id' ? (
            <DiagnosticId id={String(item)} />
          ) : (
            <span>{String(item)}</span>
          )}
        </div>
      ))}
    </div>
  );
}
const scopeKeys: Record<string, string> = {
  'library:read': 'agentSettings.scopeLibraryRead',
  'library:manage': 'agentSettings.scopeLibraryManage',
  'personal:write': 'agentSettings.scopePersonalWrite',
  'web:search': 'agentSettings.scopeWebSearch',
  'personal:read': 'agentSettings.scopePersonalRead',
  'drafts:write': 'agentSettings.scopeDraftsWrite',
  'drafts:apply': 'agentSettings.scopeDraftsApply',
  'tasks:write': 'agentSettings.scopeTasksWrite',
  'diagnostics:read': 'agentSettings.scopeDiagnosticsRead',
  'notifications:read': 'agentSettings.scopeNotificationsRead',
};
export function ToolCredentials({ user }: { user: User }) {
  const { t } = useTranslation();
  const list = useWorkspaceResource<AgentPage<ToolCredential>>('/agent/credentials?limit=100');
  const [name, setName] = useState(''),
    [days, setDays] = useState(30),
    [selected, setSelected] = useState<string[]>(['library:read']),
    [token, setToken] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  async function copyToken() {
    try {
      await navigator.clipboard.writeText(token);
      setNotice(t('agentSettings.tokenCopied'));
    } catch {
      setError(t('agentSettings.tokenCopyFailed'));
    }
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setToken('');
    setNotice('');
    try {
      const result = await api<ToolCredential>('/agent/credentials', {
        method: 'POST',
        body: JSON.stringify({ name, scopes: selected, expires_in_days: days }),
      });
      setToken(result.token || '');
      setName('');
      await list.reload();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function revoke(item: ToolCredential) {
    if (!confirm(t('agentSettings.tokenRevokeConfirm', { name: item.name }))) return;
    setBusy(true);
    setError('');
    try {
      await api(`/agent/credentials/${item.id}`, { method: 'DELETE' });
      setToken('');
      setNotice(t('agentSettings.tokenRevokedNotice'));
      await list.reload();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workspace-card" aria-label={t('agentSettings.credentialsAriaLabel')}>
      <h2>{t('agentSettings.credentialsTitle')}</h2>
      <p className="muted">{t('agentSettings.credentialsSubtitle')}</p>
      <WorkspaceNotice error={error || list.error} notice={notice} unavailable={list.unsupported} />
      {!list.unsupported && (
        <>
          <McpOnboarding />
          {token && (
            <div className="workspace-secret" role="status">
              <strong>{t('agentSettings.tokenSecretNotice')}</strong>
              <code>{token}</code>
              <div className="workspace-actions">
                <button onClick={() => void copyToken()}>{t('agentSettings.copyToken')}</button>
                <button onClick={() => setToken('')}>{t('agentSettings.hideToken')}</button>
              </div>
            </div>
          )}
          <form onSubmit={(e) => void create(e)}>
            <div className="workspace-form">
              <label>
                {t('agentSettings.credNameLabel')}
                <input
                  aria-label={t('agentSettings.credNameAriaLabel')}
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                {t('agentSettings.credExpiryLabel')}
                <input
                  type="number"
                  required
                  min={1}
                  max={365}
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                />
              </label>
              <fieldset className="span-all">
                <legend>
                  <HelpText hint="mcpScopes">{t('agentSettings.allowedScopesLegend')}</HelpText>
                </legend>
                <div className="workspace-check-grid">
                  {Object.keys(scopeKeys)
                    .filter(
                      (key) =>
                        isOwner(user) || !['diagnostics:read', 'library:manage'].includes(key),
                    )
                    .map((key) => (
                      <label className="workspace-check" key={key}>
                        <input
                          type="checkbox"
                          checked={selected.includes(key)}
                          onChange={(e) =>
                            setSelected((old) =>
                              e.target.checked ? [...old, key] : old.filter((s) => s !== key),
                            )
                          }
                        />
                        {t(scopeKeys[key])}
                      </label>
                    ))}
                </div>
              </fieldset>
              <div className="span-all">
                <button className="primary" disabled={busy || !selected.length}>
                  {t('agentSettings.generateCred')}
                </button>
              </div>
            </div>
          </form>
          <div>
            {list.value?.items.map((item) => (
              <div className="workspace-row" key={item.id}>
                <div className="workspace-row-main">
                  <strong>{item.name}</strong>
                  <small>
                    {item.scopes.map((s) => (scopeKeys[s] ? t(scopeKeys[s]) : s)).join(' · ')}
                    <br />
                    {t('agentSettings.expiresAt', { date: localDate(item.expires_at) })}
                  </small>
                </div>
                {item.revoked_at ? (
                  <StateBadge state="revoked" />
                ) : (
                  <button disabled={busy} onClick={() => void revoke(item)}>
                    {t('agentSettings.revokeCred')}
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
export function AssistantPreferences() {
  const { t } = useTranslation();
  const prefs = useWorkspaceResource<{ retention_days: number; chat_max_calls?: number }>(
    '/agent/assistant-preferences',
  );
  const edited = useRef(false);
  const [days, setDays] = useState(30),
    [chatMaxCalls, setChatMaxCalls] = useState(4),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    if (prefs.value && !edited.current) {
      setDays(prefs.value.retention_days);
      setChatMaxCalls(prefs.value.chat_max_calls ?? 4);
    }
  }, [prefs.value]);
  async function act(clear = false) {
    if (clear && !confirm(t('agentSettings.clearHistoryConfirm'))) return;
    setBusy(true);
    setError('');
    try {
      await api(clear ? '/agent/conversations' : '/agent/assistant-preferences', {
        method: clear ? 'DELETE' : 'PUT',
        ...(clear
          ? {}
          : { body: JSON.stringify({ retention_days: days, chat_max_calls: chatMaxCalls }) }),
      });
      if (!clear) {
        edited.current = false;
        void prefs.reload();
      }
      setNotice(
        clear ? t('agentSettings.clearHistoryNotice') : t('agentSettings.saveHistoryNotice'),
      );
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return prefs.unsupported ? null : (
    <section className="workspace-card" aria-label={t('agentSettings.historyAriaLabel')}>
      <h2>{t('agentSettings.historyTitle')}</h2>
      <p className="muted">{t('agentSettings.historySubtitle')}</p>
      <WorkspaceNotice error={error || prefs.error} notice={notice} />
      <div className="workspace-inline">
        <label>
          <HelpLabel hint="history">{t('agentSettings.retentionDaysLabel')}</HelpLabel>
          <input
            aria-label={t('agentSettings.retentionDaysAriaLabel')}
            type="number"
            min={1}
            max={365}
            value={days}
            disabled={busy}
            onChange={(e) => {
              edited.current = true;
              setDays(Number(e.target.value));
            }}
          />
        </label>
        <label>
          <span>{t('agentSettings.chatMaxCallsLabel')}</span>
          <input
            aria-label={t('agentSettings.chatMaxCallsAriaLabel')}
            type="number"
            min={1}
            max={20}
            value={chatMaxCalls}
            disabled={busy}
            onChange={(e) => {
              edited.current = true;
              setChatMaxCalls(Number(e.target.value));
            }}
          />
        </label>
        <button
          disabled={
            busy || !prefs.value || days < 1 || days > 365 || chatMaxCalls < 1 || chatMaxCalls > 20
          }
          onClick={() => void act()}
        >
          {t('agentSettings.saveRetention')}
        </button>
        <button disabled={busy} onClick={() => void act(true)}>
          {t('agentSettings.clearAllHistory')}
        </button>
      </div>
    </section>
  );
}
