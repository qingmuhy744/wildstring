import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, artist, time, type TrackPage } from './api';
import { PlayerBar, usePlayer } from './player';
import './style.css';

type AuthStatus = { configured: boolean; authenticated: boolean };

function Brand() {
  return (
    <a className="brand" href="/" aria-label="野弦首页">
      <span className="mark" aria-hidden="true">
        ≋
      </span>
      <span>
        野弦<small>WILDSTRING</small>
      </span>
    </a>
  );
}

function Login({ configured, onLogin }: { configured: boolean; onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: 'admin', password }),
      });
      setPassword('');
      onLogin();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <Brand />
      <div className="login-layout">
        <section className="login-intro">
          <p className="eyebrow">YOUR MUSIC. YOUR SPACE.</p>
          <h1>
            你的收藏，
            <br />
            新的<span>回响。</span>
          </h1>
          <p>
            音乐不设限，自由有回响。
            <br />
            回到自己的曲库，听一首喜欢的歌。
          </p>
          <div className="grooves" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <span>W</span>
          </div>
        </section>
        <section className="login-card" aria-labelledby="login-title">
          <span className="eyebrow">PRIVATE LIBRARY</span>
          <h2 id="login-title">{configured ? '欢迎回来' : '让音乐就位'}</h2>
          {configured ? (
            <form onSubmit={submit}>
              <p className="muted">登录你的私人音乐空间。</p>
              <label>
                账号
                <input name="username" value="admin" readOnly autoComplete="username" />
              </label>
              <label>
                密码
                <input
                  name="password"
                  type="password"
                  required
                  maxLength={128}
                  autoComplete="current-password"
                  placeholder="输入管理员密码"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <button className="primary" disabled={busy}>
                {busy ? '正在登录…' : '进入曲库 →'}
              </button>
            </form>
          ) : (
            <>
              <p className="muted">首次使用，请先在服务器终端设置管理员密码：</p>
              <code>make docker-admin</code>
              <p className="muted">
                本地开发使用 <code>make admin</code>，完成后刷新此页。账号为 admin。
              </p>
              <button onClick={() => location.reload()}>已设置，刷新</button>
            </>
          )}
          <p className="private-note">曲库保留在你的服务端。</p>
        </section>
      </div>
      <footer>野弦 · 从自己的音乐开始</footer>
    </main>
  );
}

function Library({ onLogout }: { onLogout: () => Promise<void> }) {
  const [page, setPage] = useState<TrackPage | null>(null);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [queueOpen, setQueueOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const player = usePlayer();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<TrackPage>(
      `/tracks?${new URLSearchParams({ q: query, limit: '50', offset: String(offset) })}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setPage(result);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof ApiError ? reason.message : '无法连接音乐服务，请检查连接。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [query, offset, revision]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  function search(event: FormEvent) {
    event.preventDefault();
    setOffset(0);
    setQuery(draft.trim());
    setRevision((value) => value + 1);
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <p className="sidebar-label">你的音乐空间</p>
        <div className="nav-current">
          <span>▤</span> 全部歌曲 <small>{page?.total ?? '—'}</small>
        </div>
        <button
          className={`nav-button ${queueOpen ? 'selected' : ''}`}
          onClick={() => setQueueOpen(!queueOpen)}
          aria-expanded={queueOpen}
        >
          <span>☷</span> 播放队列 <small>{player.queue.length}</small>
        </button>
        <div className="sidebar-bottom">
          <span className="local-dot" /> 私人曲库 · 原音直放
          <p>
            音乐不设限，
            <br />
            自由有回响。
          </p>
          <button
            className="text-button"
            onClick={() => {
              void onLogout().catch(() => setError('退出失败，请重试。'));
            }}
          >
            退出登录 ↗
          </button>
        </div>
      </aside>
      <main className="library">
        <header className="topbar">
          <div>
            <span className="eyebrow">YOUR OWN COLLECTION</span>
            <span className="mobile-brand">野弦 / WILDSTRING</span>
            <button
              className="mobile-logout text-button"
              onClick={() => {
                void onLogout().catch(() => setError('退出失败，请重试。'));
              }}
            >
              退出登录
            </button>
          </div>
          <form className="search" onSubmit={search} role="search">
            <label className="sr-only" htmlFor="search">
              搜索曲库
            </label>
            <span aria-hidden="true">⌕</span>
            <input
              id="search"
              placeholder="搜索歌曲、艺人、专辑"
              maxLength={256}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" aria-label="搜索">
              ↵
            </button>
          </form>
        </header>
        <section className="collection-heading">
          <div>
            <p className="eyebrow">LIBRARY / {query ? 'SEARCH' : 'ALL TRACKS'}</p>
            <h1>{query ? '找到了，那首歌。' : '收藏的声音。'}</h1>
            <p className="muted">
              {query ? `“${query}” 的搜索结果` : '熟悉的旋律，值得再听一遍。'}
            </p>
          </div>
          <div className="collection-stat">
            <strong>{page?.total ?? '—'}</strong>
            <span>{query ? '首匹配歌曲' : '首曲库收藏'}</span>
          </div>
        </section>
        <div className="library-toolbar">
          <div className="toolbar-actions">
            <button
              className="primary"
              disabled={loading || !!error || !page?.items.length}
              onClick={() => page && player.start(page.items, 0)}
            >
              <span aria-hidden="true">▶ </span>
              {page && page.total > page.items.length ? '播放本页' : '播放全部'}
            </button>
            {query && (
              <button
                onClick={() => {
                  setDraft('');
                  setQuery('');
                  setOffset(0);
                }}
              >
                清除搜索
              </button>
            )}
            <span className="subtle">MP3 / FLAC / M4A</span>
          </div>
          <button
            className="text-button"
            onClick={() => setRevision((value) => value + 1)}
            disabled={loading}
          >
            {loading ? '读取中…' : '刷新曲库 ↻'}
          </button>
        </div>
        {error ? (
          <div className="empty" role="alert">
            <h2>暂时无法读取曲库</h2>
            <p>{error}</p>
            <button onClick={() => setRevision((value) => value + 1)}>重新连接</button>
          </div>
        ) : loading ? (
          <div className="empty" role="status">
            正在读取你的音乐…
          </div>
        ) : !page?.items.length ? (
          <div className="empty">
            <span className="empty-symbol">≋</span>
            <h2>{query ? '没有找到匹配的歌曲' : '曲库还很安静'}</h2>
            <p>
              {query
                ? '试试其他标题、艺人或专辑关键词。'
                : '把音乐目录挂载到服务端，运行 make docker-scan，完成后刷新曲库。'}
            </p>
          </div>
        ) : (
          <>
            <div className="track-list" role="table" aria-label="歌曲列表">
              <div className="track-header" role="row">
                <span role="columnheader">#</span>
                <span role="columnheader">歌曲 / 艺人</span>
                <span className="album-column" role="columnheader">
                  专辑
                </span>
                <span className="quality-column" role="columnheader">
                  格式
                </span>
                <span role="columnheader">时长</span>
                <span role="columnheader">
                  <span className="sr-only">操作</span>
                </span>
              </div>
              {page.items.map((track, i) => {
                const selected = player.current?.id === track.id;
                return (
                  <div
                    className={`track-row ${selected ? 'current' : ''}`}
                    role="row"
                    key={track.id}
                  >
                    <span role="cell" className="track-number">
                      {selected && player.playing ? '♫' : String(offset + i + 1).padStart(2, '0')}
                    </span>
                    <div role="cell" className="track-identity">
                      <span className={`album-placeholder color-${i % 4}`} aria-hidden="true">
                        {track.album?.slice(0, 1) || '≋'}
                      </span>
                      <button
                        className="track-title"
                        onClick={() => player.start(page.items, i)}
                        aria-label={`播放 ${track.title}`}
                      >
                        <strong>{track.title}</strong>
                        <small>{artist(track)}</small>
                      </button>
                    </div>
                    <span className="album-column ellipsis" role="cell" title={track.album || ''}>
                      {track.album || '未知专辑'}
                    </span>
                    <span className="quality-column" role="cell">
                      <span className="format">{track.format.toUpperCase()}</span>
                    </span>
                    <time role="cell">{time(track.duration_ms / 1000)}</time>
                    <span role="cell">
                      <button
                        className="add-button"
                        aria-label={`将 ${track.title} 加入队列`}
                        onClick={() => {
                          player.enqueue(track);
                          setNotice(`已加入队列：${track.title}`);
                        }}
                      >
                        ＋
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="pagination">
              <span>
                第 {offset + 1}–{offset + page.items.length} 首 / 共 {page.total} 首
              </span>
              <div>
                <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
                  上一页
                </button>
                <button
                  disabled={offset + page.items.length >= page.total}
                  onClick={() => setOffset(offset + 50)}
                >
                  下一页
                </button>
              </div>
            </div>
          </>
        )}
        <p className="library-note">原文件串流 · 音乐目录保持只读</p>
      </main>
      {queueOpen && (
        <aside className="queue-panel" aria-label="播放队列">
          <div className="queue-heading">
            <div>
              <span className="eyebrow">UP NEXT</span>
              <h2>
                播放队列 <small>{player.queue.length}</small>
              </h2>
            </div>
            <button
              className="icon-button"
              onClick={() => setQueueOpen(false)}
              aria-label="关闭队列"
            >
              ×
            </button>
          </div>
          {player.queue.length ? (
            <ol>
              {player.queue.map((track, i) => (
                <li key={`${track.id}-${i}`} className={i === player.index ? 'selected' : ''}>
                  <span>{i === player.index ? '♫' : i + 1}</span>
                  <button className="track-title" onClick={() => player.start(player.queue, i)}>
                    <strong>{track.title}</strong>
                    <small>{artist(track)}</small>
                  </button>
                  <button
                    className="icon-button"
                    disabled={i === player.index}
                    onClick={() => player.remove(i)}
                    aria-label={`移除队列第 ${i + 1} 首`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">点击歌曲旁的 ＋ 加入队列，或直接播放曲库。</p>
          )}
        </aside>
      )}
      <PlayerBar player={player} queueOpen={queueOpen} onQueue={() => setQueueOpen(!queueOpen)} />
      {notice && (
        <p className="toast" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}

function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      setError('连接超时，请检查音乐服务。');
    }, 8000);
    setError('');
    api<AuthStatus>('/auth/status', { signal: controller.signal })
      .then((status) => {
        if (!controller.signal.aborted) setAuth(status);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('无法连接音乐服务。');
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [revision]);
  useEffect(() => {
    const expired = () => setAuth((value) => value && { ...value, authenticated: false });
    window.addEventListener('wildstring:unauthorized', expired);
    return () => window.removeEventListener('wildstring:unauthorized', expired);
  }, []);
  if (error)
    return (
      <main className="connection-page">
        <Brand />
        <h1>稍等，连接一下。</h1>
        <p role="alert">{error}</p>
        <button onClick={() => setRevision((value) => value + 1)}>重新连接</button>
      </main>
    );
  if (!auth)
    return (
      <main className="connection-page">
        <Brand />
        <p role="status">正在连接你的音乐空间…</p>
      </main>
    );
  if (!auth.authenticated)
    return (
      <Login
        configured={auth.configured}
        onLogin={() => setAuth({ configured: true, authenticated: true })}
      />
    );
  return (
    <Library
      onLogout={async () => {
        await api('/auth/logout', { method: 'POST' });
        setAuth({ ...auth, authenticated: false });
      }}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
