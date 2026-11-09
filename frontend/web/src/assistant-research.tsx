import { HelpLabel } from './desktop-help';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
    <section
      className="workspace-card assistant-research"
      aria-label={t('assistantResearch.ariaLabel')}
    >
      <h2>{t('assistantResearch.searchTitle')}</h2>
      <p className="muted">{t('assistantResearch.searchDescription')}</p>
      <WorkspaceNotice
        error={error || search.error || memories.error || prefs.error}
        notice={notice}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(saveSearch, t('assistantResearch.searchSavedNotice'));
        }}
      >
        <div className="workspace-form">
          <label>
            <HelpLabel hint="searchService">{t('assistantResearch.searchService')}</HelpLabel>
            <select
              aria-label={t('assistantResearch.searchServiceAriaLabel')}
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setKey('');
              }}
            >
              <option value="deepseek">{t('assistantResearch.serviceDeepseek')}</option>
              <option value="tavily">{t('assistantResearch.serviceTavily')}</option>
            </select>
          </label>
          <label>
            <HelpLabel hint="savedSecret">{t('assistantResearch.searchApiKey')}</HelpLabel>
            <input
              aria-label={t('assistantResearch.searchApiKeyAriaLabel')}
              type="password"
              autoComplete="new-password"
              value={key}
              placeholder={
                search.value?.has_api_key
                  ? t('assistantResearch.placeholderSaved')
                  : t('assistantResearch.placeholderEmpty')
              }
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <label>
            <HelpLabel hint="searchBudget">{t('assistantResearch.dailyBudget')}</HelpLabel>
            <input
              aria-label={t('assistantResearch.dailyBudgetAriaLabel')}
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
            {t('assistantResearch.enableSearch')}
          </label>
          <label className="workspace-check">
            <input
              type="checkbox"
              checked={clearKey}
              onChange={(e) => setClearKey(e.target.checked)}
            />
            {t('assistantResearch.clearApiKey')}
          </label>
        </div>
        <p className="muted">
          {t('assistantResearch.requestsTodayInfo', { count: search.value?.requests_today ?? 0 })}
        </p>
        <button disabled={busy || !search.value}>
          {t('assistantResearch.saveSearchSettings')}
        </button>{' '}
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
              if (!result.sources.length) throw new Error(t('assistantResearch.testNoSources'));
            }, t('assistantResearch.testSearchSuccess'))
          }
        >
          {t('assistantResearch.testSearchButton')}
        </button>
      </form>
      <h2>{t('assistantResearch.memoryTitle')}</h2>
      <p className="muted">{t('assistantResearch.memoryDescription')}</p>
      <label>
        <input
          type="checkbox"
          checked={prefs.value?.context_summary ?? true}
          disabled={busy || !prefs.value}
          onChange={(e) =>
            void act(
              () => preference('context_summary', e.target.checked),
              t('assistantResearch.contextSavedNotice'),
            )
          }
        />
        <HelpLabel hint="summary">{t('assistantResearch.enableSummary')}</HelpLabel>
      </label>{' '}
      <label>
        <input
          type="checkbox"
          checked={prefs.value?.long_term_memory ?? true}
          disabled={busy || !prefs.value}
          onChange={(e) =>
            void act(
              () => preference('long_term_memory', e.target.checked),
              t('assistantResearch.memorySavedNotice'),
            )
          }
        />
        <HelpLabel hint="memory">{t('assistantResearch.useSavedMemories')}</HelpLabel>
      </label>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(saveMemory, t('assistantResearch.memorySavedSuccessNotice'));
        }}
      >
        <label>
          {editing ? t('assistantResearch.editingMemory') : t('assistantResearch.savedPreference')}
          <textarea
            aria-label={t('assistantResearch.memoryContentAriaLabel')}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={1000}
            required
            placeholder={t('assistantResearch.memoryPlaceholder')}
          />
        </label>
        <button disabled={busy || !content.trim()}>
          {editing ? t('assistantResearch.updateMemory') : t('assistantResearch.saveMemory')}
        </button>{' '}
        {editing && (
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setContent('');
            }}
          >
            {t('assistantResearch.cancelEdit')}
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
              {t('assistantResearch.editMemory')}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                if (confirm(t('assistantResearch.confirmDelete')))
                  void act(async () => {
                    await api(`/agent/memories/${memory.id}`, { method: 'DELETE' });
                    if (editing?.id === memory.id) {
                      setEditing(null);
                      setContent('');
                    }
                    await memories.reload();
                  }, t('assistantResearch.deleteSuccessNotice'));
              }}
            >
              {t('assistantResearch.deleteMemory')}
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
