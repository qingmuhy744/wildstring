import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
interface AIConfig {
  version: number;
  base_url: string;
  model: string;
  timeout: number;
  has_api_key: boolean;
  configured: boolean;
}
export function AISettings() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<AIConfig | null>(null),
    [url, setUrl] = useState(''),
    [model, setModel] = useState(''),
    [key, setKey] = useState(''),
    [timeout, setTimeoutValue] = useState(30),
    [clearKey, setClearKey] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  function apply(value: AIConfig) {
    setConfig(value);
    setUrl(value.base_url);
    setModel(value.model);
    setTimeoutValue(value.timeout);
    setKey('');
    setClearKey(false);
  }
  useEffect(() => {
    const controller = new AbortController();
    api<AIConfig>('/manage/ai', { signal: controller.signal })
      .then(apply)
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, []);
  const dirty =
    !!config &&
    (url !== config.base_url ||
      model !== config.model ||
      timeout !== config.timeout ||
      !!key ||
      clearKey);
  async function save() {
    if (!config) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      apply(
        await api<AIConfig>('/manage/ai', {
          method: 'PUT',
          body: JSON.stringify({
            version: config.version,
            base_url: url,
            model,
            timeout,
            api_key: key || null,
            clear_api_key: clearKey,
          }),
        }),
      );
      setNotice(t('aiSettings.savedNotice'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('aiSettings.saveFailed'));
    } finally {
      setBusy(false);
    }
  }
  async function probe() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/manage/ai/test', { method: 'POST' });
      setNotice(t('aiSettings.probeSuccess'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('aiSettings.probeFailed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="management-card ai-settings" aria-label={t('aiSettings.ariaLabel')}>
      <div className="management-section-heading">
        <div>
          <h2>{t('aiSettings.title')}</h2>
          <p className="muted">{t('aiSettings.subtitle')}</p>
        </div>
        <span className="job-status">
          {config?.configured
            ? t('aiSettings.statusConfigured')
            : t('aiSettings.statusUnconfigured')}
        </span>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={!config || busy}>
          <div className="metadata-fields">
            <label className="metadata-field">
              {t('aiSettings.urlLabel')}
              <input
                required
                type="url"
                aria-label={t('aiSettings.urlAriaLabel')}
                placeholder="https://your-api.example/v1"
                maxLength={2048}
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setNotice('');
                }}
              />
            </label>
            <label className="metadata-field">
              {t('aiSettings.modelLabel')}
              <input
                required
                aria-label={t('aiSettings.modelAriaLabel')}
                placeholder={t('aiSettings.modelPlaceholder')}
                maxLength={200}
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setNotice('');
                }}
              />
            </label>
            <div className="metadata-field">
              <label htmlFor="ai-api-key">API Key</label>
              <input
                id="ai-api-key"
                type="password"
                aria-label={t('aiSettings.keyAriaLabel')}
                autoComplete="new-password"
                maxLength={4096}
                placeholder={
                  config?.has_api_key
                    ? t('aiSettings.keyPlaceholderSaved')
                    : t('aiSettings.keyPlaceholderEmpty')
                }
                disabled={clearKey}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setNotice('');
                }}
              />
              {config?.has_api_key && (
                <label className="management-checkbox">
                  <input
                    type="checkbox"
                    checked={clearKey}
                    onChange={(e) => setClearKey(e.target.checked)}
                  />
                  {t('aiSettings.clearKey')}
                </label>
              )}
            </div>
            <label className="metadata-field">
              {t('aiSettings.timeoutLabel')}
              <input
                aria-label={t('aiSettings.timeoutAriaLabel')}
                type="number"
                min={1}
                max={120}
                required
                value={timeout}
                onChange={(e) => setTimeoutValue(Number(e.target.value))}
              />
            </label>
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="ai-status">
              {notice}
            </p>
          )}
          <div className="ai-settings-actions">
            <button className="primary" disabled={busy || !config || !dirty}>
              {busy ? t('aiSettings.saving') : t('aiSettings.saveButton')}
            </button>
            <button
              type="button"
              disabled={busy || !config?.configured || dirty}
              onClick={() => void probe()}
            >
              {t('aiSettings.probeButton')}
            </button>
            <span className="muted">{t('aiSettings.probeNotice')}</span>
          </div>
        </fieldset>
      </form>
      <p className="muted">{t('aiSettings.legacyNotice')}</p>
    </section>
  );
}
