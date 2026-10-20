import { HelpLabel } from './desktop-help';
import { useEffect, useState } from 'react';
import { api } from './api';
import type { AgentPage } from './agent-api';
import { errorText, useWorkspaceResource, WorkspaceNotice } from './workspace-ui';

interface SearchSettings {
  provider: 'deepseek' | 'tavily';
  enabled: boolean;
  daily_budget: number;
  version: number;
  has_api_key: boolean;
  requests_today: number;
}
interface Memory {
  id: string;
  content: string;
  version: number;
}
interface Preferences {
  retention_days: number;
  context_summary: boolean;
  long_term_memory: boolean;
}

export function ResearchSettings() {
  const search = useWorkspaceResource<SearchSettings>('/agent/search-settings');
  const memories = useWorkspaceResource<AgentPage<Memory>>('/agent/memories');
  const prefs = useWorkspaceResource<Preferences>('/agent/assistant-preferences');
  const [provider, setProvider] = useState('deepseek'),
    [enabled, setEnabled] = useState(false);
  const [budget, setBudget] = useState(100),
    [key, setKey] = useState(''),
    [clearKey, setClearKey] = useState(false);
  const [content, setContent] = useState(''),
    [editing, setEditing] = useState<Memory | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    if (search.value) {
      setProvider(search.value.provider);
      setEnabled(search.value.enabled);
      setBudget(search.value.daily_budget);
    }
  }, [search.value]);
  async function act(work: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      setNotice(message);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function saveSearch() {
    await api('/agent/search-settings', {
      method: 'PUT',
      body: JSON.stringify({
        provider,
        enabled,
        daily_budget: budget,
        api_key: key || undefined,
        clear_api_key: clearKey,
        version: search.value?.version ?? 0,
      }),
    });
    setKey('');
    setClearKey(false);
    await search.reload();
  }
  async function saveMemory() {
    await api(`/agent/memories${editing ? `/${editing.id}` : ''}`, {
      method: editing ? 'PATCH' : 'POST',
      body: JSON.stringify({ content, ...(editing ? { version: editing.version } : {}) }),
    });
    setContent('');
    setEditing(null);
    await memories.reload();
  }
  async function preference(field: 'context_summary' | 'long_term_memory', value: boolean) {
    if (!prefs.value) return;
    const previous = prefs.value;
    const next = { ...previous, [field]: value };
    prefs.setValue(next);
    try {
      await api('/agent/assistant-preferences', { method: 'PUT', body: JSON.stringify(next) });
      await prefs.reload();
    } catch (reason) {
      prefs.setValue(previous);
      throw reason;
    }
  }
  return (
    <section className="workspace-card assistant-research" aria-label="联网与记忆设置">
      <h2>联网搜索</h2>
      <p className="muted">
        模型通过搜索和正文读取核对库外最新发行。需要独立搜索服务密钥，按服务商规则计费；不上传音频或整份曲库。关闭后仍可本地找歌。
      </p>
      <WorkspaceNotice
        error={error || search.error || memories.error || prefs.error}
        notice={notice}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(saveSearch, '联网搜索设置已保存。');
        }}
      >
        <div className="workspace-form">
          <label>
            <HelpLabel hint="searchService">搜索服务</HelpLabel>
            <select
              aria-label="搜索服务"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setKey('');
              }}
            >
              <option value="deepseek">DeepSeek 官方 Search / Fetch</option>
              <option value="tavily">Tavily Search / Extract</option>
            </select>
          </label>
          <label>
            <HelpLabel hint="savedSecret">搜索 API Key</HelpLabel>
            <input
              aria-label="搜索 API Key"
              type="password"
              autoComplete="new-password"
              value={key}
              placeholder={search.value?.has_api_key ? '已保存，留空保留' : '仅保存在服务端'}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <label>
            <HelpLabel hint="searchBudget">每日搜索与读取请求上限</HelpLabel>
            <input
              aria-label="每日搜索请求上限"
              type="number"
              min="0"
              max="10000"
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value))}
            />
          </label>
          <label className="workspace-check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            启用聊天联网搜索
          </label>
          <label className="workspace-check">
            <input
              type="checkbox"
              checked={clearKey}
              onChange={(e) => setClearKey(e.target.checked)}
            />
            清除已保存的搜索密钥
          </label>
        </div>
        <p className="muted">
          今日已请求 {search.value?.requests_today ?? 0} 次；每轮聊天最多 4
          次独立搜索或读取。失败请求也预留额度，避免超时后重复计费。
        </p>
        <button disabled={busy || !search.value}>保存搜索设置</button>{' '}
        <button
          type="button"
          disabled={busy || !search.value?.enabled}
          onClick={() =>
            void act(async () => {
              const result = await api<{ sources: unknown[] }>('/agent/search-settings/test', {
                method: 'POST',
                body: '{}',
              });
              await search.reload();
              if (!result.sources.length) throw new Error('服务已响应，但本次没有可用来源。');
            }, '搜索接口已返回可核对来源。')
          }
        >
          测试搜索（计入额度）
        </button>
      </form>
      <h2>上下文与长期记忆</h2>
      <p className="muted">
        长对话会压缩较早内容，摘要可能有遗漏，可在对话中查看或清除。摘要消耗一次模型调用，并计入本轮和每日预算。长期记忆只保存你明确提交的内容，最多
        50 条；删除对话不会删除记忆。
      </p>
      <label>
        <input
          type="checkbox"
          checked={prefs.value?.context_summary ?? true}
          disabled={busy || !prefs.value}
          onChange={(e) =>
            void act(() => preference('context_summary', e.target.checked), '上下文设置已保存。')
          }
        />
        <HelpLabel hint="summary">启用长对话摘要</HelpLabel>
      </label>{' '}
      <label>
        <input
          type="checkbox"
          checked={prefs.value?.long_term_memory ?? true}
          disabled={busy || !prefs.value}
          onChange={(e) =>
            void act(() => preference('long_term_memory', e.target.checked), '记忆使用设置已保存。')
          }
        />
        <HelpLabel hint="memory">在聊天中使用已保存的记忆</HelpLabel>
      </label>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(saveMemory, '长期记忆已保存。');
        }}
      >
        <label>
          {editing ? '编辑长期记忆' : '明确保存的音乐偏好'}
          <textarea
            aria-label="长期记忆内容"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={1000}
            required
            placeholder="例如：优先录音室版本，通常不听现场版。"
          />
        </label>
        <button disabled={busy || !content.trim()}>{editing ? '更新记忆' : '保存长期记忆'}</button>{' '}
        {editing && (
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setContent('');
            }}
          >
            取消编辑
          </button>
        )}
      </form>
      {memories.value?.items.map((memory) => (
        <article className="workspace-row" key={memory.id}>
          <p>{memory.content}</p>
          <div className="workspace-actions">
            <button
              disabled={busy}
              onClick={() => {
                setEditing(memory);
                setContent(memory.content);
              }}
            >
              编辑记忆
            </button>
            <button
              disabled={busy}
              onClick={() => {
                if (confirm('删除这条长期记忆？已有对话和草案会保留。'))
                  void act(async () => {
                    await api(`/agent/memories/${memory.id}`, { method: 'DELETE' });
                    if (editing?.id === memory.id) {
                      setEditing(null);
                      setContent('');
                    }
                    await memories.reload();
                  }, '记忆已删除。');
              }}
            >
              删除记忆
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
