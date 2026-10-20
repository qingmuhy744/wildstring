import { HelpLabel } from './desktop-help';
import { useEffect, useRef, useState } from 'react';
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
        if (!c.signal.aborted) setMessage('无法读取联网设置。');
      });
    return () => c.abort();
  }, []);
  async function save() {
    if (!config || busy) return;
    setBusy(true);
    setMessage('正在保存…');
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
      setMessage('联网设置已保存。');
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : '设置未保存，请检查地址、密钥或重新打开设置。',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="management-card settings-section account-form">
      <h2>联网资料</h2>
      <p className="muted">
        MusicBrainz 与 Last.fm 提供资料建议；Cover Art Archive 提供封面候选，确认后才应用。
      </p>
      {config && (
        <fieldset disabled={busy}>
          {(
            [
              ['enabled', '启用联网资料'],
              ['auto_new', '新导入自动查询（旧库手动查询）'],
              ['musicbrainz', 'MusicBrainz'],
              ['lastfm', 'Last.fm 资料'],
              ['caa', '缺少封面时查询 Cover Art Archive'],
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
            AcoustID 音频指纹识别
          </label>
          <p className="muted">
            先识别录音，再由 MusicBrainz 补充资料；只发送指纹和时长。没有匹配时按现有标签查询。
          </p>
          {!config.fingerprint_available && (
            <p role="status">服务端缺少指纹工具，请更新 Docker 镜像或安装 Chromaprint。</p>
          )}
          <label>
            <HelpLabel hint="acoustid">AcoustID Application API Key</HelpLabel>
            <input
              type="password"
              autoComplete="new-password"
              value={acoustidKey}
              onChange={(e) => setAcoustidKey(e.target.value)}
              placeholder={config.acoustid_configured ? '已配置，留空保留' : 'Application API Key'}
            />
          </label>
          <p className="muted">
            请使用注册应用后获得的 Application API Key。账号页的 User API Key
            用于提交指纹，不能用于查询识别。
          </p>
          <ProviderPriority
            value={config.priority}
            onChange={(priority) => setConfig({ ...config, priority })}
          />
          <p className="muted">
            人工修改保留，已有本地封面优先。AcoustID 用于识别录音，封面由 CAA
            提供候选；它们不参与资料字段排序。
          </p>
          <label>
            <HelpLabel hint="proxy">联网代理</HelpLabel>
            <select
              aria-label="联网代理"
              value={config.proxy_mode}
              onChange={(e) =>
                setConfig({ ...config, proxy_mode: e.target.value as Config['proxy_mode'] })
              }
            >
              <option value="environment">跟随环境变量</option>
              <option value="custom">手动指定</option>
              <option value="direct">直接连接</option>
            </select>
          </label>
          <p className="muted">
            {config.environment_proxy_configured
              ? '服务端环境变量中已配置代理。'
              : '环境变量中未配置代理，将直接连接。'}
            支持 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY 和 NO_PROXY。
          </p>
          <label>
            <HelpLabel hint="proxy">HTTP 代理地址</HelpLabel>
            <input
              type="password"
              autoComplete="new-password"
              value={proxy}
              onChange={(e) => setProxy(e.target.value)}
              placeholder={config.proxy_configured ? '已配置，留空保留' : 'http://127.0.0.1:7890'}
            />
          </label>
          <p className="muted">
            HTTP/HTTPS 联网请求共用此代理，可包含用户名和密码。Docker 中请填写容器能访问的代理地址。
          </p>
          <ProviderNetworkTest mode={config.proxy_mode} proxy={proxy} disabled={busy} />
          <label>
            <HelpLabel hint="publicUrl">公开访问地址</HelpLabel>
            <input
              type="url"
              placeholder="https://music.example.com"
              value={config.public_url}
              onChange={(e) => setConfig({ ...config, public_url: e.target.value })}
            />
          </label>
          <p className="muted">Last.fm 授权回到此地址。请填写手机和浏览器都能访问的地址。</p>
          <label>
            <HelpLabel hint="savedSecret">Last.fm API Key</HelpLabel>
            <input
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={config.lastfm_configured ? '已配置，留空保留' : '32 位 API Key'}
            />
          </label>
          <label>
            <HelpLabel hint="savedSecret">Last.fm API Secret</HelpLabel>
            <input
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="留空保留"
            />
          </label>
          <button onClick={() => void save()}>保存联网设置</button>
        </fieldset>
      )}
      <p role="status">{message}</p>
      <p className="muted">
        <a href="https://musicbrainz.org" target="_blank" rel="noreferrer">
          MusicBrainz
        </a>{' '}
        ·{' '}
        <a href="https://acoustid.org/new-application" target="_blank" rel="noreferrer">
          注册 AcoustID 应用并获取密钥
        </a>{' '}
        ·{' '}
        <a href="https://www.last.fm/api/account/create" target="_blank" rel="noreferrer">
          申请 Last.fm API Key
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
  const [value, setValue] = useState<Binding | null>(null),
    [error, setError] = useState('');
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    api<Binding>('/lastfm', { signal: c.signal })
      .then(setValue)
      .catch(() => {
        if (!c.signal.aborted) setError('无法读取 Last.fm。');
      });
    return () => c.abort();
  }, []);
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
      setError('同步设置未保存，已恢复，请重新读取后重试。');
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
      setError('请先由管理员启用联网资料，配置 Last.fm 密钥和公开访问地址。');
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
      setError('断开失败，请重试。');
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
            已连接：{value.username}
            {value.needs_auth ? ' · 需要重新授权' : ''}
          </p>
          <label className="check-label">
            <input
              type="checkbox"
              checked={Boolean(value.scrobble)}
              disabled={busy}
              onChange={(e) => void change('scrobble', e.target.checked)}
            />
            同步已听记录
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={Boolean(value.now_playing)}
              disabled={busy}
              onChange={(e) => void change('now_playing', e.target.checked)}
            />
            同步正在播放
          </label>
          <p className="muted">
            仅同步启用后实际收听的歌曲。待同步 {value.queue.queued || 0} · 失败{' '}
            {value.queue.failed || 0}
          </p>
          <button disabled={busy} onClick={() => void disconnect()}>
            断开 Last.fm
          </button>
        </>
      ) : (
        <button disabled={busy || !value} onClick={() => void connect()}>
          连接 Last.fm
        </button>
      )}
      {value?.needs_auth && (
        <button disabled={busy} onClick={() => void connect()}>
          重新授权
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
