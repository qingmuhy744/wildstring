import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type User } from './api';
import { applyLanguagePreference, languagePreferences, type LanguagePreference } from './i18n';
import { LastfmAccount } from './providers';
import { AvatarEditor } from './avatar';
import type { MusicLibrary } from './music-libraries';
import { UserLibraryAccessDialog } from './user-library-access';

type Profile = User['profile'];
/** Account-wide language; saved on the server so every device follows it. */
export function LanguageControl({
  user,
  disabled,
  onUserChange,
}: {
  user: User;
  disabled?: boolean;
  onUserChange?: (user: User) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<LanguagePreference>(user.language || 'auto');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function choose(next: LanguagePreference) {
    const previous = value;
    setValue(next);
    setError('');
    setSaving(true);
    applyLanguagePreference(next);
    try {
      const updated = await api<User>('/auth/preferences', {
        method: 'PUT',
        body: JSON.stringify({ language: next }),
      });
      onUserChange?.(updated);
    } catch (reason) {
      setValue(previous);
      applyLanguagePreference(previous);
      setError(reason instanceof Error ? reason.message : t('language.saveFailed'));
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <label className="theme-control language-control">
        <span>{t('language.label')}</span>
        <select
          aria-label={t('language.aria')}
          value={value}
          disabled={disabled || saving}
          onChange={(event) => void choose(event.target.value as LanguagePreference)}
        >
          {languagePreferences.map((option) => (
            <option key={option} value={option} lang={option === 'auto' ? undefined : option}>
              {t(`language.${option}`)}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
const userProfile = (user: User): Profile => user.profile;

export function AccountSettings({
  user,
  onUserChange,
}: {
  user: User;
  onUserChange?: (user: User) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState('profile');
  const [current, setCurrent] = useState(''),
    [password, setPassword] = useState(''),
    [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [username, setUsername] = useState(user.username);
  const [displayName, setDisplayName] = useState(user.display_name || '');
  const [email, setEmail] = useState(user.email || '');
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (password !== confirm) {
      setError(t('account.passwordMismatch'));
      return;
    }
    setBusy(true);
    try {
      await api('/auth/password', {
        method: 'POST',
        body: JSON.stringify({ current_password: current, new_password: password }),
      });
      setCurrent('');
      setPassword('');
      setConfirm('');
      window.dispatchEvent(
        new CustomEvent('wildstring:unauthorized', { detail: t('session.passwordChanged') }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('account.passwordFailed'));
    } finally {
      setBusy(false);
    }
  }
  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setProfileError('');
    setProfileSuccess('');
    setBusy(true);
    try {
      const updated = await api<User>('/auth/profile', {
        method: 'PUT',
        body: JSON.stringify({
          version: user.version,
          username,
          display_name: displayName,
          email,
        }),
      });
      setUsername(updated.username);
      setDisplayName(updated.display_name || '');
      setEmail(updated.email || '');
      setProfileSuccess(t('account.profileSaved'));
      onUserChange?.(updated);
    } catch (reason) {
      setProfileError(reason instanceof Error ? reason.message : t('account.profileFailed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="account-settings">
      <nav className="settings-tabs" aria-label={t('settings.account')}>
        {(['profile', 'security', 'lastfm'] as const).map((key) => (
          <button key={key} aria-pressed={tab === key} disabled={busy} onClick={() => setTab(key)}>
            {key === 'lastfm' ? 'Last.fm' : t(`settings.${key}`)}
          </button>
        ))}
      </nav>
      {tab === 'profile' && (
        <>
          <AvatarEditor user={user} disabled={busy} onBusy={setBusy} />
          <form className="account-form" onSubmit={saveProfile} aria-label={t('account.profile')}>
            <h3>{t('account.profile')}</h3>
            <label>
              {t('account.loginId')}
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,31}"
                maxLength={32}
                required
                autoComplete="username"
              />
            </label>
            <label>
              {t('account.displayName')}
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={80}
                placeholder={t('account.displayNamePlaceholder')}
              />
            </label>
            <label>
              {t('account.email')}
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                maxLength={254}
                placeholder={t('account.emailPlaceholder')}
                autoComplete="email"
              />
            </label>
            <p className="muted">{t('account.emailNote')}</p>
            {profileError && (
              <p className="error" role="alert">
                {profileError}
              </p>
            )}
            {profileSuccess && (
              <p className="notice" role="status">
                {profileSuccess}
              </p>
            )}
            <div className="editor-footer">
              <span />
              <button className="primary" disabled={busy}>
                {busy ? t('account.saving') : t('account.saveProfile')}
              </button>
            </div>
          </form>
        </>
      )}
      {tab === 'security' && (
        <>
          <form className="account-form" onSubmit={submit}>
            <label>
              {t('account.currentPassword')}
              <input
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </label>
            <label>
              {t('account.newPassword')}
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label>
              {t('account.confirmPassword')}
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
            <p className="muted">{t('account.passwordNote')}</p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="editor-footer">
              <button className="primary" disabled={busy}>
                {busy ? t('account.changing') : t('account.changePassword')}
              </button>
            </div>
          </form>
        </>
      )}
      {tab === 'lastfm' && <LastfmAccount />}
    </div>
  );
}

export function UsersPanel() {
  const { t } = useTranslation();
  const [libraries, setLibraries] = useState<MusicLibrary[]>([]);
  const [libraryIds, setLibraryIds] = useState<string[] | null>(null);
  const defaultLibraryIds = libraries
    .filter((library) => library.default_access ?? library.is_default)
    .map((library) => library.id);
  const [users, setUsers] = useState<User[]>([]),
    [self, setSelf] = useState<User | null>(null);
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [profile, setProfile] = useState<Profile>('listener');
  const [resetting, setResetting] = useState<User | null>(null),
    [resetPassword, setResetPassword] = useState(''),
    [resetConfirm, setResetConfirm] = useState('');
  const [granting, setGranting] = useState<User | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  async function load(signal?: AbortSignal) {
    const [list, auth] = await Promise.all([
      api<{ items: User[] }>('/manage/users', { signal }),
      api<{ user: User }>('/auth/status', { signal }),
    ]);
    if (signal?.aborted) return;
    setUsers(list.items);
    setSelf(auth.user);
    const available = await api<MusicLibrary[]>('/libraries', { signal }).catch(() => []);
    if (!signal?.aborted) setLibraries(available);
  }
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      void load(controller.signal).catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    };
    refresh();
    window.addEventListener('wildstring:libraries-updated', refresh);
    return () => {
      controller.abort();
      window.removeEventListener('wildstring:libraries-updated', refresh);
    };
  }, []);
  async function act(work: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      await load();
      window.dispatchEvent(new Event('wildstring:users-updated'));
      setNotice(message);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('accountsAdmin.operationIncomplete'));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (password !== confirmation) {
      setError(t('accountsAdmin.passwordMismatch'));
      return;
    }
    if (
      await act(
        () =>
          api('/manage/users', {
            method: 'POST',
            body: JSON.stringify({
              username,
              password,
              profile,
              library_ids: libraryIds ?? defaultLibraryIds,
            }),
          }),
        t('accountsAdmin.accountCreated'),
      )
    ) {
      setUsername('');
      setPassword('');
      setConfirmation('');
      setLibraryIds(null);
    }
  }
  function update(user: User, values: { profile?: Profile; enabled?: boolean }) {
    void act(
      () =>
        api(`/manage/users/${user.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            version: user.version,
            profile: values.profile ?? userProfile(user),
            enabled: values.enabled ?? user.enabled,
          }),
        }),
      t('accountsAdmin.accountUpdated'),
    );
  }
  async function reset(event: FormEvent) {
    event.preventDefault();
    if (!resetting) return;
    if (resetPassword !== resetConfirm) {
      setError(t('accountsAdmin.resetPasswordMismatch'));
      return;
    }
    if (
      await act(
        () =>
          api(`/manage/users/${resetting.id}/password`, {
            method: 'POST',
            body: JSON.stringify({ version: resetting.version, new_password: resetPassword }),
          }),
        t('accountsAdmin.passwordReset'),
      )
    ) {
      setResetting(null);
      setResetPassword('');
      setResetConfirm('');
    }
  }
  return (
    <section aria-label={t('accountsAdmin.title')} className="management-users">
      <div className="management-card">
        <h2>{t('accountsAdmin.title')}</h2>
        <p className="muted">{t('accountsAdmin.description')}</p>
        {error && (
          <p className="error" role="alert">
            {error}{' '}
            <button
              disabled={busy}
              onClick={() => {
                setResetting(null);
                void act(() => Promise.resolve(), t('accountsAdmin.accountsRefreshed'));
              }}
            >
              {t('accountsAdmin.reloadAccounts')}
            </button>
          </p>
        )}
        {notice && (
          <p role="status" className="ai-status">
            {notice}
          </p>
        )}
        <div className="account-list-heading" aria-hidden="true">
          <span>{t('accountsAdmin.colAccount')}</span>
          <span>{t('accountsAdmin.colRole')}</span>
          <span>{t('accountsAdmin.colLibraries')}</span>
          <span>{t('accountsAdmin.colActions')}</span>
        </div>
        <ul className="account-list" aria-label={t('accountsAdmin.accountList')}>
          {users.map((user) => (
            <li key={user.id}>
              <div className="account-row-identity">
                <strong>{user.username}</strong>
                <small>
                  {user.enabled
                    ? t('accountsAdmin.statusEnabled')
                    : t('accountsAdmin.statusDisabled')}
                  {self?.id === user.id ? t('accountsAdmin.currentAccount') : ''}
                </small>
              </div>
              <select
                className="account-row-role"
                aria-label={t('accountsAdmin.roleAria', { username: user.username })}
                disabled={busy || !self || self.id === user.id}
                value={userProfile(user)}
                onChange={(e) => update(user, { profile: e.target.value as Profile })}
              >
                <option value="listener">{t('accountsAdmin.roleListener')}</option>
                <option value="editor">{t('accountsAdmin.roleEditor')}</option>
                <option value="librarian">{t('accountsAdmin.roleLibrarian')}</option>
                <option value="owner">{t('accountsAdmin.roleOwner')}</option>
              </select>
              <button
                className="account-row-access"
                aria-label={t('accountsAdmin.libraryAccessAria', { username: user.username })}
                title={
                  user.profile === 'owner' ? t('accountsAdmin.ownerFullAccessHint') : undefined
                }
                disabled={busy || !self || user.profile === 'owner'}
                onClick={() => setGranting(user)}
              >
                {user.profile === 'owner'
                  ? t('accountsAdmin.allLibraries')
                  : t('accountsAdmin.libraryAccess')}
              </button>
              <div className="account-row-actions">
                <button
                  aria-label={
                    user.enabled
                      ? t('accountsAdmin.disableUserAria', { username: user.username })
                      : t('accountsAdmin.enableUserAria', { username: user.username })
                  }
                  disabled={busy || !self || self.id === user.id}
                  onClick={() => update(user, { enabled: !user.enabled })}
                >
                  {user.enabled ? t('accountsAdmin.disable') : t('accountsAdmin.enable')}
                </button>
                <button
                  aria-label={t('accountsAdmin.resetPasswordAria', { username: user.username })}
                  disabled={busy || !self || self.id === user.id}
                  onClick={() => {
                    setResetting(user);
                    setResetPassword('');
                    setResetConfirm('');
                    setError('');
                  }}
                >
                  {t('accountsAdmin.resetPassword')}
                </button>
              </div>
            </li>
          ))}
        </ul>
        {granting && (
          <UserLibraryAccessDialog
            user={granting}
            onClose={() => setGranting(null)}
            onSaved={() => {
              setNotice(t('accountsAdmin.userAccessSaved', { username: granting.username }));
              setGranting(null);
            }}
          />
        )}
        {resetting && (
          <form
            className="account-form reset-password-form"
            onSubmit={reset}
            aria-label={t('accountsAdmin.resetPasswordForAria', { username: resetting.username })}
          >
            <h3>{t('accountsAdmin.resetPasswordFor', { username: resetting.username })}</h3>
            <label>
              {t('accountsAdmin.newPassword')}
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
              />
            </label>
            <label>
              {t('accountsAdmin.confirmResetPassword')}
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={resetConfirm}
                onChange={(e) => setResetConfirm(e.target.value)}
              />
            </label>
            <div className="editor-footer">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setResetting(null);
                  setResetPassword('');
                  setResetConfirm('');
                }}
              >
                {t('accountsAdmin.cancelReset')}
              </button>
              <button className="primary" disabled={busy}>
                {t('accountsAdmin.confirmResetPassword')}
              </button>
            </div>
          </form>
        )}
      </div>
      <form
        className="management-card account-form"
        onSubmit={create}
        aria-label={t('accountsAdmin.createAccount')}
      >
        <h2>{t('accountsAdmin.createAccount')}</h2>
        <label>
          {t('accountsAdmin.username')}
          <input
            required
            minLength={1}
            maxLength={32}
            pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{0,31}"
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <span className="muted">{t('accountsAdmin.usernameHint')}</span>
        <label>
          {t('accountsAdmin.role')}
          <select value={profile} onChange={(e) => setProfile(e.target.value as Profile)}>
            <option value="listener">{t('accountsAdmin.roleListener')}</option>
            <option value="editor">{t('accountsAdmin.roleEditor')}</option>
            <option value="librarian">{t('accountsAdmin.roleLibrarian')}</option>
            <option value="owner">{t('accountsAdmin.roleOwner')}</option>
          </select>
        </label>
        {profile !== 'owner' && (
          <fieldset className="music-library-options">
            <legend>{t('accountsAdmin.accessibleLibraries')}</legend>
            {libraries.map((library) => (
              <label key={library.id} className="music-library-grant-option">
                <input
                  type="checkbox"
                  checked={(libraryIds ?? defaultLibraryIds).includes(library.id)}
                  onChange={(event) =>
                    setLibraryIds((values) =>
                      event.target.checked
                        ? [...(values ?? defaultLibraryIds), library.id]
                        : (values ?? defaultLibraryIds).filter((key) => key !== library.id),
                    )
                  }
                />
                <span>{library.name}</span>
              </label>
            ))}
            <small>{t('accountsAdmin.noLibrariesHint')}</small>
          </fieldset>
        )}
        <label>
          {t('accountsAdmin.initialPassword')}
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          {t('accountsAdmin.confirmInitialPassword')}
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? t('accountsAdmin.processing') : t('accountsAdmin.createAccount')}
        </button>
      </form>
    </section>
  );
}
