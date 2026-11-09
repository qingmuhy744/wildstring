import { HelpLabel } from './desktop-help';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { ProviderPriority } from './metadata-refresh';
import { ProviderNetworkTest } from './provider-diagnostics';
import { SourcePlugins } from './source-plugins';
import { MetadataReviewWorkbench } from './metadata-review';

type Config = {
  version: number;
  enabled: boolean;
  auto_new: boolean;
  musicbrainz: boolean;
  lastfm: boolean;
  caa: boolean;
  acoustid: boolean;
  priority: string[];
  acoustid_configured: boolean;
  fingerprint_available: boolean;
  public_url: string;
  lastfm_configured: boolean;
  proxy_mode: 'environment' | 'custom' | 'direct';
  environment_proxy_configured: boolean;
  proxy_configured: boolean;
};
export function ProviderSettings() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<Config | null>(null);
  const [key, setKey] = useState(''),
    [acoustidKey, setAcoustidKey] = useState(''),
    [secret, setSecret] = useState(''),
    [proxy, setProxy] = useState('');
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    const c = new AbortController();
    api<Config>('/manage/providers', { signal: c.signal })
      .then(setConfig)
      .catch(() => {
        if (!c.signal.aborted) setMessage(t('providersPage.loadSettingsError'));
      });
    return () => c.abort();
  }, [t]);
  async function save() {
    if (!config || busy) return;
    setBusy(true);
    setMessage(t('providersPage.saving'));
    try {
      const {
        lastfm_configured: _configured,
        proxy_configured: _proxyConfigured,
        environment_proxy_configured: _envConfigured,
        acoustid_configured: _acoustidConfigured,
        fingerprint_available: _fingerprintAvailable,
        ...body
      } = config;
      setConfig(
        await api<Config>('/manage/providers', {
          method: 'PUT',
          body: JSON.stringify({
            ...body,
            ...(key ? { api_key: key } : {}),
            ...(secret ? { api_secret: secret } : {}),
            ...(acoustidKey ? { acoustid_api_key: acoustidKey } : {}),
            ...(proxy ? { proxy_url: proxy } : {}),
          }),
        }),
      );
      setKey('');
      setSecret('');
      setAcoustidKey('');
      setProxy('');
      setMessage(t('providersPage.savedNotice'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('providersPage.saveSettingsError'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="management-card settings-section account-form">
      <h2>{t('providersPage.title')}</h2>
      <p className="muted">{t('providersPage.description')}</p>
      {config && (
        <fieldset disabled={busy}>
          {(
            [
              ['enabled', t('providersPage.enableOnlineMetadata')],
              ['auto_new', t('providersPage.autoQueryNew')],
              ['musicbrainz', t('providersPage.musicbrainz')],
              ['lastfm', t('providersPage.lastfmData')],
              ['caa', t('providersPage.caaWhenMissingCover')],
            ] as const
          ).map(([field, label]) => (
            <label className="check-label" key={field}>
              <input
                type="checkbox"
                checked={Boolean(config[field])}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    [field]: e.target.checked,
                    ...(field === 'musicbrainz' && !e.target.checked ? { acoustid: false } : {}),
                  })
                }
              />
              {label}
            </label>
          ))}
          <label className="check-label">
            <input
              type="checkbox"
              checked={config.acoustid}
              disabled={!config.fingerprint_available}
              onChange={(e) =>
                setConfig({
                  ...config,
                  acoustid: e.target.checked,
                  ...(e.target.checked ? { musicbrainz: true } : {}),
                })
              }
            />
            {t('providersPage.acoustidRecognition')}
          </label>
          <p className="muted">{t('providersPage.acoustidDescription')}</p>
          {!config.fingerprint_available && (
            <p role="status">{t('providersPage.missingChromaprint')}</p>
          )}
          <label>
            <HelpLabel hint="acoustid">{t('providersPage.acoustidKeyLabel')}</HelpLabel>
            <input
              type="password"
              autoComplete="new-password"
              value={acoustidKey}
              onChange={(e) => setAcoustidKey(e.target.value)}
              placeholder={
                config.acoustid_configured
                  ? t('providersPage.configuredPlaceholder')
                  : t('providersPage.acoustidPlaceholder')
              }
            />
          </label>
          <p className="muted">{t('providersPage.acoustidKeyHint')}</p>
          <ProviderPriority
            value={config.priority}
            onChange={(priority) => setConfig({ ...config, priority })}
          />
          <p className="muted">{t('providersPage.priorityHint')}</p>
          <label>
            <HelpLabel hint="proxy">{t('providersPage.proxyLabel')}</HelpLabel>
            <select
              aria-label={t('providersPage.proxyAria')}
              value={config.proxy_mode}
              onChange={(e) =>
                setConfig({ ...config, proxy_mode: e.target.value as Config['proxy_mode'] })
              }
            >
              <option value="environment">{t('providersPage.proxyEnv')}</option>
              <option value="custom">{t('providersPage.proxyCustom')}</option>
              <option value="direct">{t('providersPage.proxyDirect')}</option>
            </select>
          </label>
          <p className="muted">
            {config.environment_proxy_configured
              ? t('providersPage.proxyEnvConfigured')
              : t('providersPage.proxyEnvNotConfigured')}
          </p>
          <label>
            <HelpLabel hint="proxy">{t('providersPage.proxyUrlLabel')}</HelpLabel>
            <input
              type="password"
              autoComplete="new-password"
              value={proxy}
              onChange={(e) => setProxy(e.target.value)}
              placeholder={
                config.proxy_configured
                  ? t('providersPage.configuredPlaceholder')
                  : 'http://127.0.0.1:7890'
              }
            />
          </label>
          <p className="muted">{t('providersPage.proxyHint')}</p>
          <ProviderNetworkTest mode={config.proxy_mode} proxy={proxy} disabled={busy} />
          <label>
            <HelpLabel hint="publicUrl">{t('providersPage.publicUrlLabel')}</HelpLabel>
            <input
              type="url"
              placeholder="https://music.example.com"
              value={config.public_url}
              onChange={(e) => setConfig({ ...config, public_url: e.target.value })}
            />
          </label>
          <p className="muted">{t('providersPage.publicUrlHint')}</p>
          <label>
            <HelpLabel hint="savedSecret">{t('providersPage.lastfmKeyLabel')}</HelpLabel>
            <input
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={
                config.lastfm_configured
                  ? t('providersPage.configuredPlaceholder')
                  : t('providersPage.lastfmKeyPlaceholder')
              }
            />
          </label>
          <label>
            <HelpLabel hint="savedSecret">{t('providersPage.lastfmSecretLabel')}</HelpLabel>
            <input
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={t('providersPage.leaveEmptyPlaceholder')}
            />
          </label>
          <button onClick={() => void save()}>{t('providersPage.saveSettings')}</button>
        </fieldset>
      )}
      <p role="status">{message}</p>
      <p className="muted">
        <a href="https://musicbrainz.org" target="_blank" rel="noreferrer">
          MusicBrainz
        </a>{' '}
        ·{' '}
        <a href="https://acoustid.org/new-application" target="_blank" rel="noreferrer">
          {t('providersPage.registerAcoustid')}
        </a>{' '}
        ·{' '}
        <a href="https://www.last.fm/api/account/create" target="_blank" rel="noreferrer">
          {t('providersPage.applyLastfmKey')}
        </a>{' '}
        ·{' '}
        <a href="https://coverartarchive.org" target="_blank" rel="noreferrer">
          Cover Art Archive
        </a>
      </p>
      <SourcePlugins />
    </section>
  );
}

type Binding = {
  configured: boolean;
  connected: boolean;
  username?: string;
  scrobble: boolean;
  now_playing: boolean;
  needs_auth?: boolean;
  version: number;
  queue: Record<string, number>;
};
export function LastfmAccount() {
  const { t } = useTranslation();
  const [value, setValue] = useState<Binding | null>(null),
    [error, setError] = useState('');
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    api<Binding>('/lastfm', { signal: c.signal })
      .then(setValue)
      .catch(() => {
        if (!c.signal.aborted) setError(t('providersPage.loadLastfmError'));
      });
    return () => c.abort();
  }, [t]);
  async function change(field: 'scrobble' | 'now_playing', checked: boolean) {
    if (!value || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    const before = value,
      next = { ...value, [field]: checked };
    setValue(next);
    try {
      setValue(
        await api<Binding>('/lastfm', {
          method: 'PUT',
          body: JSON.stringify({
            version: before.version,
            scrobble: next.scrobble,
            now_playing: next.now_playing,
          }),
        }),
      );
    } catch {
      setValue(before);
      setError(t('providersPage.syncSettingsError'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function connect() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ url: string }>('/lastfm/authorize', { method: 'POST' });
      location.assign(result.url);
    } catch {
      setError(t('providersPage.connectPrerequisiteError'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function disconnect() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await api('/lastfm', { method: 'DELETE' });
      setValue(await api<Binding>('/lastfm'));
    } catch {
      setError(t('providersPage.disconnectError'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <h3>Last.fm</h3>
      {value?.connected ? (
        <>
          <p>
            {t('providersPage.connectedStatus', { username: value.username })}
            {value.needs_auth ? t('providersPage.needsReauth') : ''}
          </p>
          <label className="check-label">
            <input
              type="checkbox"
              checked={Boolean(value.scrobble)}
              disabled={busy}
              onChange={(e) => void change('scrobble', e.target.checked)}
            />
            {t('providersPage.syncScrobble')}
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={Boolean(value.now_playing)}
              disabled={busy}
              onChange={(e) => void change('now_playing', e.target.checked)}
            />
            {t('providersPage.syncNowPlaying')}
          </label>
          <p className="muted">
            {t('providersPage.syncQueueInfo', {
              queued: value.queue.queued || 0,
              failed: value.queue.failed || 0,
            })}
          </p>
          <button disabled={busy} onClick={() => void disconnect()}>
            {t('providersPage.disconnectLastfm')}
          </button>
        </>
      ) : (
        <button disabled={busy || !value} onClick={() => void connect()}>
          {t('providersPage.connectLastfm')}
        </button>
      )}
      {value?.needs_auth && (
        <button disabled={busy} onClick={() => void connect()}>
          {t('providersPage.reauthorizeLastfm')}
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

export function MetadataSuggestions({
  id,
  onApplied,
}: {
  id: string;
  version: number;
  onApplied: () => Promise<void>;
}) {
  return <MetadataReviewWorkbench initialTrackId={id} onApplied={onApplied} />;
}
