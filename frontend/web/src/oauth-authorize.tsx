import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type User } from './api';
import type { OAuthAuthorizeContext } from './agent-api';
import { scopeKeys } from './agent-settings';
import { Brand } from './brand';
import { ThemeControl } from './theme';
import { errorText } from './workspace-ui';
import './workspace.css';

export function OAuthAuthorize({
  user,
  onSwitchAccount,
}: {
  user: User;
  onSwitchAccount: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [context, setContext] = useState<OAuthAuthorizeContext | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const search = window.location.search;
  const query = new URLSearchParams(search);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(search);
    setLoading(true);
    setError('');
    api<OAuthAuthorizeContext>('/oauth/authorize/context', {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({
        client_id: params.get('client_id') || '',
        redirect_uri: params.get('redirect_uri') || '',
        response_type: params.get('response_type') || '',
        code_challenge: params.get('code_challenge') || '',
        code_challenge_method: params.get('code_challenge_method') || '',
        scope: params.get('scope'),
        state: params.get('state'),
        resource: params.get('resource'),
      }),
    })
      .then((data) => {
        if (controller.signal.aborted) return;
        setContext(data);
        setSelected(data.default_scopes);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setContext(null);
          setError(errorText(reason));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [search, user.id]);

  async function decide(decision: 'approve' | 'deny') {
    if (!context || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ redirect_to: string }>('/oauth/authorize/decision', {
        method: 'POST',
        body: JSON.stringify({
          decision,
          client_id: context.client.client_id,
          redirect_uri: context.redirect_uri,
          code_challenge: query.get('code_challenge') || '',
          code_challenge_method: 'S256',
          scopes: decision === 'approve' ? selected : [],
          state: context.state,
          resource: context.resource,
        }),
      });
      window.location.assign(result.redirect_to);
    } catch (reason) {
      setError(errorText(reason));
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void decide('approve');
  }

  return (
    <main className="login-page oauth-authorize-page">
      <div className="login-topbar">
        <Brand />
        <ThemeControl />
      </div>
      <div className="oauth-authorize-layout">
        <section className="login-card oauth-consent-card" aria-labelledby="oauth-title">
          <span className="eyebrow">{t('oauth.eyebrow')}</span>
          {loading ? (
            <>
              <h1 id="oauth-title">{t('oauth.loadingTitle')}</h1>
              <p role="status" className="muted">
                {t('oauth.loading')}
              </p>
            </>
          ) : !context ? (
            <>
              <h1 id="oauth-title">{t('oauth.invalidTitle')}</h1>
              <p role="alert" className="error">
                {error || t('oauth.invalidFallback')}
              </p>
              <div className="oauth-actions">
                <a className="oauth-return-link" href="/">
                  {t('oauth.returnHome')}
                </a>
              </div>
            </>
          ) : (
            <form onSubmit={submit}>
              <h1 id="oauth-title">{t('oauth.consentTitle', { name: context.client.name })}</h1>
              <dl className="oauth-meta">
                <div>
                  <dt>{t('oauth.accountLabel')}</dt>
                  <dd className="oauth-account-row">
                    <span>{user.username}</span>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => void onSwitchAccount()}
                    >
                      {t('oauth.switchAccount')}
                    </button>
                  </dd>
                </div>
                <div>
                  <dt>{t('oauth.sourceLabel')}</dt>
                  <dd>
                    {context.client.registration_source === 'dynamic'
                      ? t('oauth.sourceDynamic')
                      : t('oauth.sourceManual')}
                  </dd>
                </div>
                <div>
                  <dt>{t('oauth.redirectHostLabel')}</dt>
                  <dd>
                    <code className="oauth-host">{context.redirect_host}</code>
                  </dd>
                </div>
              </dl>

              <fieldset className="oauth-scope-fieldset">
                <legend>{t('oauth.scopesLegend')}</legend>
                <div className="workspace-check-grid">
                  {context.allowed_scopes.map((scope) => (
                    <label className="workspace-check" key={scope}>
                      <input
                        type="checkbox"
                        checked={selected.includes(scope)}
                        disabled={busy}
                        onChange={(event) =>
                          setSelected((old) =>
                            event.target.checked
                              ? [...old, scope]
                              : old.filter((item) => item !== scope),
                          )
                        }
                      />
                      {scopeKeys[scope] ? t(scopeKeys[scope]) : scope}
                    </label>
                  ))}
                </div>
              </fieldset>

              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}

              <div className="oauth-actions">
                <button type="submit" className="primary" disabled={busy || selected.length === 0}>
                  {busy ? t('oauth.submitting') : t('oauth.approve')}
                </button>
                <button type="button" disabled={busy} onClick={() => void decide('deny')}>
                  {t('oauth.deny')}
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}
