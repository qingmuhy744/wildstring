import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { mcpClients, mcpSetup, type McpClient } from './mcp-setup';

export function McpOnboarding() {
  const { t } = useTranslation();
  const [client, setClient] = useState<McpClient>('codex');
  const [name, setName] = useState('wildstring');
  const [url, setUrl] = useState(() => new URL('mcp', document.baseURI).href);
  const [allowHttp, setAllowHttp] = useState(false);
  const [notice, setNotice] = useState('');
  let setup: ReturnType<typeof mcpSetup> | undefined;
  let error = '';
  try {
    setup = mcpSetup(client, name, url, allowHttp);
  } catch (reason) {
    error = reason instanceof Error ? reason.message : t('mcpOnboarding.configError');
  }
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(t('mcpOnboarding.copiedWithoutToken', { label }));
    } catch {
      setNotice(t('mcpOnboarding.clipboardFailed'));
    }
  }
  return (
    <section className="mcp-onboarding" aria-label={t('mcpOnboarding.ariaLabel')}>
      <h3>{t('mcpOnboarding.title')}</h3>
      <p className="muted">{t('mcpOnboarding.subtitle')}</p>
      <div className="workspace-form">
        <label>
          {t('mcpOnboarding.clientLabel')}
          <select
            aria-label={t('mcpOnboarding.clientLabel')}
            value={client}
            onChange={(e) => {
              setClient(e.target.value as McpClient);
              setNotice('');
            }}
          >
            {Object.entries(mcpClients).map(([key, label]) => (
              <option key={key} value={key}>
                {key === 'generic' ? t('mcpSetup.clientGeneric') : label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('mcpOnboarding.nameLabel')}
          <input
            value={name}
            maxLength={64}
            onChange={(e) => {
              setName(e.target.value);
              setNotice('');
            }}
          />
        </label>
        <label className="span-all">
          {t('mcpOnboarding.urlLabel')}
          <input
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setAllowHttp(false);
              setNotice('');
            }}
          />
        </label>
      </div>
      <p className="muted">{t('mcpOnboarding.urlHelp')}</p>
      {url.trim().toLowerCase().startsWith('http:') && (
        <label className="workspace-check">
          <input
            type="checkbox"
            checked={allowHttp}
            onChange={(e) => setAllowHttp(e.target.checked)}
          />
          {t('mcpOnboarding.allowHttp')}
        </label>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {setup && (
        <>
          <p className="muted">{setup.instructions}</p>
          <div className="workspace-actions">
            <button
              type="button"
              onClick={() => void copy(setup!.prompt, t('mcpOnboarding.labelPrompt'))}
            >
              {t('mcpOnboarding.copyPrompt')}
            </button>
            {setup.config && (
              <button
                type="button"
                onClick={() => void copy(setup!.config, t('mcpOnboarding.labelConfig'))}
              >
                {t('mcpOnboarding.copyConfig')}
              </button>
            )}
          </div>
          <details>
            <summary>{t('mcpOnboarding.viewConfigAndPrompt')}</summary>
            {setup.config && (
              <label>
                {t('mcpOnboarding.configSnippet')}
                <textarea
                  aria-label={t('mcpOnboarding.configSnippet')}
                  readOnly
                  rows={9}
                  value={setup.config}
                />
              </label>
            )}
            <label>
              {t('mcpOnboarding.aiPrompt')}
              <textarea
                aria-label={t('mcpOnboarding.aiPrompt')}
                readOnly
                rows={12}
                value={setup.prompt}
              />
            </label>
          </details>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      <p className="muted">{t('mcpOnboarding.successCriteria')}</p>
    </section>
  );
}
