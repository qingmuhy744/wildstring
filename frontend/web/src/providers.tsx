import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { MetadataRefreshDialog, ProviderPriority } from './metadata-refresh';
import { JobDiagnostics, ProviderNetworkTest } from './provider-diagnostics';
import { SourcePlugins } from './source-plugins';

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
            AcoustID API Key
            <input
              type="password"
              autoComplete="new-password"
              value={acoustidKey}
              onChange={(e) => setAcoustidKey(e.target.value)}
              placeholder={config.acoustid_configured ? '已配置，留空保留' : '应用 API Key'}
            />
          </label>
          <ProviderPriority
            value={config.priority}
            onChange={(priority) => setConfig({ ...config, priority })}
          />
          <p className="muted">
            人工修改保留，已有本地封面优先。AcoustID 用于识别录音，封面由 CAA
            提供候选；它们不参与资料字段排序。
          </p>
          <label>
            联网代理
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
            HTTP 代理地址
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
            公开访问地址
            <input
              type="url"
              placeholder="https://music.example.com"
              value={config.public_url}
              onChange={(e) => setConfig({ ...config, public_url: e.target.value })}
            />
          </label>
          <p className="muted">Last.fm 授权回到此地址。请填写手机和浏览器都能访问的地址。</p>
          <label>
            Last.fm API Key
            <input
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={config.lastfm_configured ? '已配置，留空保留' : '32 位 API Key'}
            />
          </label>
          <label>
            Last.fm API Secret
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
          申请 AcoustID API Key
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

type Suggestion = {
  id: string;
  metadata_version: number;
  provider: string;
  source_url: string;
  fields: Record<string, unknown>;
  cover_url: string | null;
  status: string;
  match: { method?: string; score?: number; acoustid_id?: string };
};
type Results = {
  suggestions: Suggestion[];
  provider_names?: Record<string, string>;
  jobs: { id: string; status: string; error: string | null; warnings: string }[];
};
const labels: Record<string, string> = {
  title: '歌名',
  artists: '歌曲艺人',
  artist_credit: '艺人署名',
  album: '专辑',
  album_artists: '专辑艺人',
  external_ids: 'MusicBrainz 标识',
  composers: '作曲',
  lyricists: '作词',
  arrangers: '编曲',
  vocalists: '演唱',
  release_date: '发行日期',
  tags: '标签',
  description: '简介',
};
const statuses: Record<string, string> = {
  queued: '排队中',
  running: '查询中…',
  completed: '查询完成',
  failed: '查询失败，请重试',
  no_match: '没有匹配结果',
  stale: '歌曲信息已变化，请重新查询',
};
function CandidateCover({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="candidate-cover-preview">
      {failed ? (
        <p role="status">
          封面预览暂不可用。<button onClick={() => setFailed(false)}>重新预览</button>
        </p>
      ) : (
        <img
          src={`/api/v1/manage/providers/suggestions/${encodeURIComponent(id)}/cover-preview`}
          alt="CAA 封面候选"
          loading="lazy"
          width="160"
          height="160"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
export function MetadataSuggestions({
  id,
  version,
  onApplied,
}: {
  id: string;
  version: number;
  onApplied: () => Promise<void>;
}) {
  const [result, setResult] = useState<Results | null>(null),
    [error, setError] = useState('');
  const [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0);
  const [selection, setSelection] = useState<Record<string, string[]>>({});
  const request = useRef(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    api<Results>(`/manage/providers/tracks/${id}`, { signal: c.signal })
      .then(setResult)
      .catch(() => {
        if (!c.signal.aborted) setError('无法读取建议。');
      });
    return () => c.abort();
  }, [id, tick]);
  useEffect(() => {
    if (!result?.jobs.some((j) => j.status === 'queued' || j.status === 'running')) return;
    const t = setTimeout(() => setTick((v) => v + 1), 2000);
    return () => clearTimeout(t);
  }, [result]);
  async function run(path: string, body: unknown) {
    if (request.current) return;
    request.current = true;
    setBusy(true);
    setError('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      if (path.endsWith('/cover')) window.dispatchEvent(new Event('wildstring:artwork-updated'));
      if (!path.endsWith('/query')) await onApplied();
      setTick((v) => v + 1);
    } catch {
      setError('操作未完成。请检查联网设置；歌曲已修改时，请重新查询后应用。');
    } finally {
      request.current = false;
      setBusy(false);
    }
  }
  return (
    <section>
      <p className="muted">选择需要的字段后应用。勾选已有人工值的字段，会替换该字段。</p>
      <button
        disabled={busy || result?.jobs.some((j) => ['queued', 'running'].includes(j.status))}
        onClick={() => setRefreshOpen(true)}
      >
        更新元数据
      </button>
      <p role="status">{result?.jobs[0] && statuses[result.jobs[0].status]}</p>
      {result?.jobs[0] && <JobDiagnostics job={result.jobs[0]} />}
      {result?.suggestions.map((s) => (
        <article className="suggestion-card" key={s.id}>
          {s.status === 'ignored' && <p className="muted">此建议已忽略。</p>}
          {s.status === 'applied' && <p className="muted">此建议已应用。</p>}
          <a href={s.source_url} target="_blank" rel="noreferrer">
            {result.provider_names?.[s.provider] ||
              (s.provider === 'musicbrainz'
                ? 'MusicBrainz'
                : s.provider === 'lastfm'
                  ? 'Last.fm'
                  : s.provider)}{' '}
            来源
          </a>
          {s.match?.method === 'acoustid' && (
            <p className="muted">
              AcoustID 指纹匹配 · 相似度 {Math.round((s.match.score || 0) * 100)}%{' '}
              <a
                href={`https://acoustid.org/track/${s.match.acoustid_id}`}
                target="_blank"
                rel="noreferrer"
              >
                查看识别来源
              </a>
            </p>
          )}
          {Object.entries(s.fields).map(([field, value]) => (
            <label className="check-label" key={field}>
              <input
                type="checkbox"
                checked={(selection[s.id] || []).includes(field)}
                disabled={busy || s.status !== 'pending' || s.metadata_version !== version}
                onChange={(e) =>
                  setSelection({
                    ...selection,
                    [s.id]: e.target.checked
                      ? [...(selection[s.id] || []), field]
                      : (selection[s.id] || []).filter((f) => f !== field),
                  })
                }
              />
              <span>
                <strong>{labels[field] || field}</strong>：
                {result.suggestions.find(
                  (candidate) => candidate.status === 'pending' && field in candidate.fields,
                )?.provider === s.provider && (
                  <small className="provider-recommended">优先来源</small>
                )}
                {Array.isArray(value)
                  ? value.join(' / ')
                  : typeof value === 'object'
                    ? JSON.stringify(value)
                    : String(value)}
              </span>
            </label>
          ))}
          <button
            disabled={
              busy ||
              !selection[s.id]?.length ||
              s.status !== 'pending' ||
              s.metadata_version !== version
            }
            onClick={() =>
              void run(`/manage/providers/suggestions/${s.id}/apply`, {
                version,
                fields: selection[s.id],
              })
            }
          >
            应用选中字段
          </button>
          {s.cover_url && (
            <div>
              <CandidateCover key={s.id} id={s.id} />
              <p>
                <a href={s.cover_url.replace(/^http:/, 'https:')} target="_blank" rel="noreferrer">
                  查看来源封面候选
                </a>{' '}
                <button
                  disabled={busy || s.status === 'ignored' || s.metadata_version !== version}
                  onClick={() =>
                    void run(`/manage/providers/suggestions/${s.id}/cover`, { version })
                  }
                >
                  使用此封面
                </button>
              </p>
            </div>
          )}
          {s.metadata_version !== version && (
            <p className="muted">歌曲已变化，此候选仅供查看，请重新查询。</p>
          )}
        </article>
      ))}
      {refreshOpen && (
        <MetadataRefreshDialog
          target={{ scope: 'track', id, label: '当前歌曲' }}
          onClose={() => setRefreshOpen(false)}
          onQueued={() => setTick((value) => value + 1)}
        />
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
