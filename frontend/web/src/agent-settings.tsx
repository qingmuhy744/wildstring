import { useEffect, useState, type FormEvent } from 'react';
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
  timeout: 30,
  shared: false,
  background_allowed: false,
  daily_call_budget: 100,
  enabled: true,
};
export function AgentConnections({ user }: { user: User }) {
  const list = useModelConnections(),
    policy = useWorkspaceResource<{ allowed_hosts: string[]; allow_private: boolean }>(
      user.role === 'admin' ? '/agent/endpoint-policy' : null,
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
      setNotice('模型连接已保存，密钥仅保存在服务端。');
      await list.reload();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function action(item: AgentConnection, kind: 'test' | 'delete') {
    if (busy) return;
    if (kind === 'delete' && !confirm(`撤销连接“${item.name}”？依赖此连接的任务将无法继续使用。`))
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
        setNotice('连接已撤销。');
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
      setNotice('个人连接的端点规则已保存。');
      await policy.reload();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workspace-card" aria-label="模型连接管理">
      <div className="workspace-card-head">
        <div>
          <h2>模型连接</h2>
          <p className="muted">
            个人连接归你所有；共享实例连接由管理员提供。不会自动切换付费连接。
          </p>
        </div>
        <button disabled={busy || list.loading} onClick={() => void list.reload()}>
          刷新连接
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
                    {item.scope === 'personal' ? '仅本人' : item.shared ? '实例共享' : '管理员专用'}
                    {item.id === 'legacy' ? ' · 原有实例配置' : item.read_only ? ' · 仅可使用' : ''}
                    <br />
                    {item.background_allowed ? '允许后台使用' : '仅交互使用'} · 每日最多{' '}
                    {item.daily_call_budget} 次
                    {item.daily_calls_remaining != null
                      ? ` · 今日剩余 ${item.daily_calls_remaining} 次`
                      : ''}
                    {item.my_usage?.calls != null ? ` · 我已用 ${item.my_usage.calls} 次` : ''}
                  </small>
                </div>
                <StateBadge state={item.enabled ? 'ready' : 'disabled'} />
                <div className="workspace-actions">
                  {!item.read_only && (
                    <>
                      <button disabled={busy} onClick={() => edit(item)}>
                        编辑连接
                      </button>
                      <button
                        disabled={busy || !item.enabled}
                        onClick={() => void action(item, 'test')}
                      >
                        检测能力
                      </button>
                      <button disabled={busy} onClick={() => void action(item, 'delete')}>
                        撤销
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
            <h3>{editing ? '编辑模型连接' : '添加模型连接'}</h3>
            <div className="workspace-form">
              <label>
                连接名称
                <input
                  aria-label="连接名称"
                  required
                  maxLength={100}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              {user.role === 'admin' && (
                <label>
                  连接归属
                  <select
                    aria-label="连接归属"
                    value={form.scope}
                    disabled={!!editing}
                    onChange={(e) => setForm({ ...form, scope: e.target.value, shared: false })}
                  >
                    <option value="personal">个人</option>
                    <option value="instance">实例</option>
                  </select>
                </label>
              )}
              <label>
                API 地址
                <input
                  aria-label="新连接 API 地址"
                  type="url"
                  required
                  maxLength={2048}
                  placeholder="https://api.example/v1"
                  value={form.base_url}
                  onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                />
              </label>
              <label>
                模型 ID
                <input
                  aria-label="新连接模型 ID"
                  required
                  maxLength={200}
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                />
              </label>
              <label>
                API Key
                <input
                  disabled={form.clear_api_key}
                  aria-label="新连接 API Key"
                  type="password"
                  autoComplete="new-password"
                  maxLength={4096}
                  placeholder={editing?.has_api_key ? '已保存；留空保留原密钥' : '可留空'}
                  value={form.api_key}
                  onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                />
              </label>
              <label>
                超时（秒）
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
                每日模型调用上限
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
                    清除已保存的密钥
                  </label>
                )}
                <label className="workspace-check">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  />
                  启用连接
                </label>
                <label className="workspace-check">
                  <input
                    type="checkbox"
                    checked={form.background_allowed}
                    onChange={(e) => setForm({ ...form, background_allowed: e.target.checked })}
                  />
                  允许后台巡检使用
                </label>
                {user.role === 'admin' && form.scope === 'instance' && (
                  <label className="workspace-check">
                    <input
                      type="checkbox"
                      checked={form.shared}
                      onChange={(e) => setForm({ ...form, shared: e.target.checked })}
                    />
                    供其他用户共享
                  </label>
                )}
              </div>
              <div className="span-all workspace-actions">
                <button className="primary" disabled={busy}>
                  {busy ? '处理中…' : editing ? '保存连接修改' : '添加连接'}
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
                    取消编辑
                  </button>
                )}
                <small className="muted">
                  检测能力最多发送 3 次合成请求，计入模型额度和每日预算；保存不会触发检测。
                </small>
              </div>
            </div>
          </form>
          {user.role === 'admin' && (
            <details className="legacy-ai-compatibility">
              <summary>原有实例连接（兼容配置）</summary>
              <p className="muted">
                这是连接列表中的 legacy
                实例连接，为旧客户端保留。推荐优先添加具备共享控制与统一额度的新连接；修改这里不会更改当前功能已选中的连接。
              </p>
              <AISettings />
            </details>
          )}
          {user.role === 'admin' && (
            <details>
              <summary>个人连接的端点规则</summary>
              <p className="muted">
                普通用户仅可使用允许的精确主机。私有网络需同时加入允许主机并开启下方选项。
              </p>
              <label>
                允许的域名或 IP（每行一个）
                <textarea
                  aria-label="允许的 AI 端点主机"
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
                允许列表中的私有网络地址
              </label>
              <button disabled={busy || !policy.value} onClick={() => void savePolicy()}>
                保存端点规则
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
  const names: Record<string, string> = {
    text: '文本响应',
    structured: '结构化选歌',
    tools: '工具调用',
    tool_calling: '工具调用',
    checked_at: '检测时间',
    tested_at: '检测时间',
    trace_id: '诊断编号',
  };
  return (
    <div className="connection-capabilities">
      <h4>能力检测</h4>
      {Object.entries(value).map(([key, item]) => (
        <div key={key}>
          <span>{names[key] || key}</span>
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
const scopes: Record<string, string> = {
  'library:read': '读取共享曲库',
  'personal:read': '读取我的歌单与历史',
  'drafts:write': '创建和修改草案',
  'drafts:apply': '应用已批准草案',
  'tasks:write': '提交和管理巡检',
  'diagnostics:read': '读取系统诊断（管理员）',
  'notifications:read': '读取我的通知',
};
export function ToolCredentials({ user }: { user: User }) {
  const list = useWorkspaceResource<AgentPage<ToolCredential>>('/agent/credentials?limit=100');
  const [name, setName] = useState(''),
    [days, setDays] = useState(30),
    [selected, setSelected] = useState<string[]>(['library:read']),
    [token, setToken] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
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
    if (!confirm(`撤销“${item.name}”的工具访问？`)) return;
    setBusy(true);
    setError('');
    try {
      await api(`/agent/credentials/${item.id}`, { method: 'DELETE' });
      setToken('');
      setNotice('凭据已撤销，后续请求立即失效。');
      await list.reload();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workspace-card" aria-label="MCP 工具凭据">
      <h2>MCP 与外部工具</h2>
      <p className="muted">
        为 Codex 等工具生成独立凭据，按需选择最小权限。工具不能批准草案，也不能读取模型密钥。
      </p>
      <WorkspaceNotice error={error || list.error} notice={notice} unavailable={list.unsupported} />
      {!list.unsupported && (
        <>
          {token && (
            <div className="workspace-secret" role="status">
              <strong>凭据只显示这一次，请保存到安全的位置。</strong>
              <code>{token}</code>
              <div className="workspace-actions">
                <button
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(token)
                      .then(() => setNotice('凭据已复制。'))
                      .catch(() => setError('无法写入剪贴板，请手动复制。'))
                  }
                >
                  复制凭据
                </button>
                <button onClick={() => setToken('')}>隐藏凭据</button>
              </div>
            </div>
          )}
          <form onSubmit={(e) => void create(e)}>
            <div className="workspace-form">
              <label>
                凭据名称
                <input
                  aria-label="工具凭据名称"
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                有效期（天）
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
                <legend>允许的操作</legend>
                <div className="workspace-check-grid">
                  {Object.entries(scopes)
                    .filter(([key]) => user.role === 'admin' || key !== 'diagnostics:read')
                    .map(([key, label]) => (
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
                        {label}
                      </label>
                    ))}
                </div>
              </fieldset>
              <div className="span-all">
                <button className="primary" disabled={busy || !selected.length}>
                  生成工具凭据
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
                    {item.scopes.map((s) => scopes[s] || s).join(' · ')}
                    <br />
                    到期 {localDate(item.expires_at)}
                  </small>
                </div>
                {item.revoked_at ? (
                  <StateBadge state="revoked" />
                ) : (
                  <button disabled={busy} onClick={() => void revoke(item)}>
                    撤销凭据
                  </button>
                )}
              </div>
            ))}
          </div>
          <details>
            <summary>Codex 接入说明</summary>
            <p className="muted">
              使用服务端提供的 stdio MCP
              桥接；通过环境变量提供服务器地址与上方凭据。配置示例见仓库的 MCP
              接入文档，不把令牌写进启动参数或提交到 Git。
            </p>
            <a
              href="https://github.com/qingmuhy744/wildstring"
              target="_blank"
              rel="noopener noreferrer"
            >
              查看 GitHub 文档 ↗
            </a>
          </details>
        </>
      )}
    </section>
  );
}
export function AssistantPreferences() {
  const prefs = useWorkspaceResource<{ retention_days: number }>('/agent/assistant-preferences');
  const [days, setDays] = useState(30),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    if (prefs.value) setDays(prefs.value.retention_days);
  }, [prefs.value]);
  async function act(clear = false) {
    if (clear && !confirm('清除所有助手对话？草案和已保存的歌单会保留。')) return;
    setBusy(true);
    setError('');
    try {
      await api(clear ? '/agent/conversations' : '/agent/assistant-preferences', {
        method: clear ? 'DELETE' : 'PUT',
        ...(clear ? {} : { body: JSON.stringify({ retention_days: days }) }),
      });
      setNotice(clear ? '助手对话已清除。' : '对话保留时间已保存。');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return prefs.unsupported ? null : (
    <section className="workspace-card" aria-label="助手历史设置">
      <h2>助手历史</h2>
      <WorkspaceNotice error={error || prefs.error} notice={notice} />
      <div className="workspace-inline">
        <label>
          对话保留（天）
          <input
            aria-label="助手历史保留天数"
            type="number"
            min={1}
            max={365}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          />
        </label>
        <button
          disabled={busy || !prefs.value || days < 1 || days > 365}
          onClick={() => void act()}
        >
          保存保留时间
        </button>
        <button disabled={busy} onClick={() => void act(true)}>
          清除全部对话
        </button>
      </div>
    </section>
  );
}
