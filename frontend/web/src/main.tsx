import { StrictMode, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import i18n, { applyLanguagePreference } from './i18n';
import { api, type User } from './api';
import { Brand } from './brand';
import { Library } from './library';
import { ThemeControl } from './theme';
import { DesktopHelpProvider } from './desktop-help';
import { clearOfflineAccount, offlineUser, setOfflineAccount } from './offline';
import './style.css';
import './completion.css';
import './browse.css';
import './podcasts.css';
import './podcast-player.css';

type AuthStatus = {
  configured: boolean;
  authenticated: boolean;
  user?: User;
  version?: string;
};

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
  const { t } = useTranslation();
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
      setError(reason instanceof Error ? reason.message : t('login.failed'));
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
          <p className="eyebrow">{t('login.eyebrow')}</p>
          <h1>
            {t('login.headlineLine1')}
            <br />
            {t('login.headlineLine2')}
            <span>{t('login.headlineAccent')}</span>
          </h1>
          <p>
            {t('login.introLine1')}
            <br />
            {t('login.introLine2')}
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
          <span className="eyebrow">{t('login.cardEyebrow')}</span>
          <h2 id="login-title">{configured ? t('login.welcomeBack') : t('login.setupTitle')}</h2>
          {configured ? (
            <form onSubmit={submit}>
              <p className="muted">{t('login.subtitle')}</p>
              {notice && <p role="status">{notice}</p>}
              <label>
                {t('login.username')}
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
                {t('login.password')}
                <input
                  name="password"
                  type="password"
                  required
                  maxLength={128}
                  autoComplete="current-password"
                  placeholder={t('login.passwordPlaceholder')}
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
                {busy ? t('login.submitting') : t('login.submit')}
              </button>
            </form>
          ) : (
            <>
              <p className="muted">{t('login.setupHint')}</p>
              <code>make docker-admin</code>
              <p className="muted">
                {t('login.setupLocalBefore')}
                <code>make admin</code>
                {t('login.setupLocalAfter')}
              </p>
              <button onClick={() => location.reload()}>{t('login.setupDone')}</button>
            </>
          )}
          <p className="private-note">{t('login.privateNote')}</p>
        </section>
      </div>
      <footer>{t('login.footer')}</footer>
    </main>
  );
}

function App() {
  const logoutPending = useRef(false);
  const [notice, setNotice] = useState('');
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const { t } = useTranslation();
  // The account setting wins once signed in; before that the browser language applies.
  useEffect(() => {
    applyLanguagePreference(auth?.authenticated ? auth.user?.language : 'auto');
  }, [auth?.authenticated, auth?.user?.language]);
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
      if (!useOffline()) setError(i18n.t('connection.timeout'));
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
          setError(i18n.t('connection.unreachable'));
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
          : i18n.t('session.expired'),
      );
      setAuth((value) => value && { ...value, authenticated: false });
      void clearOfflineAccount().catch(() => setNotice(i18n.t('session.cleanupFailed')));
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
            detail: i18n.t('session.changedElsewhere'),
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
          setNotice(i18n.t('session.statusChanged'));
          setAuth({ ...status, authenticated: false });
        } else applyLanguagePreference(status.user?.language);
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
        <h1>{t('connection.title')}</h1>
        <p role="alert">{error}</p>
        <button onClick={() => setRevision((value) => value + 1)}>{t('connection.retry')}</button>
      </main>
    );
  if (!auth)
    return (
      <main className="connection-page">
        <Brand />
        <p role="status">{t('connection.connecting')}</p>
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
          setNotice(revoked ? '' : i18n.t('session.localSignedOut'));
        } catch {
          setNotice(i18n.t('session.localSignedOutCleanupFailed'));
        } finally {
          logoutPending.current = false;
        }
      }}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DesktopHelpProvider>
      <App />
    </DesktopHelpProvider>
  </StrictMode>,
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
