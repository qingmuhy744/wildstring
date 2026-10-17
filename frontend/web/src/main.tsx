import { StrictMode, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { api, type User } from './api';
import { Brand } from './brand';
import { Library } from './library';
import { ThemeControl } from './theme';
import { clearOfflineAccount, offlineUser, setOfflineAccount } from './offline';
import './style.css';
import './completion.css';
import './browse.css';

type AuthStatus = { configured: boolean; authenticated: boolean; user?: User };

function Login({
  configured,
  onLogin,
  notice,
}: {
  configured: boolean;
  onLogin: (user: User) => void | Promise<void>;
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
      await onLogin(user);
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
  const logoutPending = useRef(false);
  const [notice, setNotice] = useState('');
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const useOffline = () => {
      const user = !localStorage.getItem('wildstring:offline-signed-out') ? offlineUser() : null;
      if (!user) return false;
      setOfflineAccount(user, false);
      setAuth({ configured: true, authenticated: true, user });
      setError('');
      return true;
    };
    const timer = setTimeout(() => {
      controller.abort();
      if (!useOffline()) setError('连接超时，请检查音乐服务。');
    }, 8000);
    setError('');
    api<AuthStatus>('/auth/status', { signal: controller.signal })
      .then(async (status) => {
        if (controller.signal.aborted) return;
        if (localStorage.getItem('wildstring:offline-signed-out')) {
          if (status.authenticated)
            await api('/auth/logout', { method: 'POST', signal: controller.signal });
          if (!controller.signal.aborted)
            setAuth({ configured: status.configured, authenticated: false });
          return;
        }
        if (status.authenticated && status.user) {
          if (offlineUser() && offlineUser()?.id !== status.user.id) await clearOfflineAccount();
          setOfflineAccount(status.user);
        } else await clearOfflineAccount();
        if (!controller.signal.aborted) setAuth(status);
      })
      .catch((reason) => {
        if (!controller.signal.aborted && !(reason instanceof TypeError && useOffline()))
          setError('无法连接音乐服务。');
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
      void clearOfflineAccount().catch(() =>
        setNotice('已退出，浏览器未能清理部分离线存储，可在浏览器设置中清除本站数据。'),
      );
    };
    window.addEventListener('wildstring:unauthorized', expired);
    return () => window.removeEventListener('wildstring:unauthorized', expired);
  }, []);
  useEffect(() => {
    if (!auth?.authenticated) return;
    const changed = (event: StorageEvent) => {
      if (event.key !== 'wildstring:offline-account') return;
      if (offlineUser()?.id !== auth.user?.id)
        window.dispatchEvent(
          new CustomEvent('wildstring:unauthorized', {
            detail: '账号已在其他页面变化，请重新登录。',
          }),
        );
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [auth?.authenticated, auth?.user?.id]);
  useEffect(() => {
    if (!auth?.authenticated) return;
    const verify = async () => {
      if (!navigator.onLine) return;
      try {
        const status = await api<AuthStatus>('/auth/status');
        if (!status.authenticated || status.user?.id !== auth.user?.id) {
          await clearOfflineAccount();
          setNotice('账号状态已变化，请重新登录。');
          setAuth({ ...status, authenticated: false });
        }
      } catch {
        /* network outages do not revoke offline access */
      }
    };
    window.addEventListener('online', verify);
    const timer = setInterval(verify, 60000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', verify);
    };
  }, [auth?.authenticated, auth?.user?.id]);
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
        onLogin={async (user) => {
          setNotice('');
          if (offlineUser() && offlineUser()?.id !== user.id) await clearOfflineAccount();
          localStorage.removeItem('wildstring:offline-signed-out');
          setOfflineAccount(user);
          setAuth({ configured: true, authenticated: true, user });
        }}
      />
    );
  return (
    <Library
      key={auth.user!.id}
      user={auth.user!}
      onLogout={async () => {
        if (logoutPending.current) return;
        logoutPending.current = true;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        let revoked = false;
        try {
          if (navigator.onLine) {
            await api('/auth/logout', { method: 'POST', signal: controller.signal });
            revoked = true;
          }
        } catch {
          /* Local sign-out must remain available when the server is unreachable. */
        } finally {
          clearTimeout(timer);
        }
        localStorage.setItem('wildstring:offline-signed-out', '1');
        setAuth({ ...auth, authenticated: false });
        try {
          await clearOfflineAccount();
          setNotice(revoked ? '' : '本机已退出，服务端会话将在下次连接时注销。');
        } catch {
          setNotice('本机已退出；浏览器未能清理部分离线存储，可在浏览器设置中清除本站数据。');
        } finally {
          logoutPending.current = false;
        }
      }}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
