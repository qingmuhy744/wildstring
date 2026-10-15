import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { api, type User } from './api';
import { Brand } from './brand';
import { Library } from './library';
import { ThemeControl } from './theme';
import './style.css';

type AuthStatus = { configured: boolean; authenticated: boolean; user?: User };

function Login({
  configured,
  onLogin,
  notice,
}: {
  configured: boolean;
  onLogin: (user: User) => void;
  notice: string;
}) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = await api<User>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setPassword('');
      onLogin(user);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <div className="login-topbar">
        <Brand />
        <ThemeControl />
      </div>
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
              {notice && <p role="status">{notice}</p>}
              <label>
                账号
                <input
                  name="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  maxLength={32}
                  autoComplete="username"
                />
              </label>
              <label>
                密码
                <input
                  name="password"
                  type="password"
                  required
                  maxLength={128}
                  autoComplete="current-password"
                  placeholder="输入密码"
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

function App() {
  const [notice, setNotice] = useState('');
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
    const expired = (event: Event) => {
      setNotice(
        event instanceof CustomEvent && typeof event.detail === 'string'
          ? event.detail
          : '登录已过期，请重新登录。',
      );
      setAuth((value) => value && { ...value, authenticated: false });
    };
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
        notice={notice}
        onLogin={(user) => {
          setNotice('');
          setAuth({ configured: true, authenticated: true, user });
        }}
      />
    );
  return (
    <Library
      user={auth.user!}
      onLogout={async () => {
        await api('/auth/logout', { method: 'POST' });
        setNotice('');
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
