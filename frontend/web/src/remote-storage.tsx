import { useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, errorCodeMessage } from './api';
import './remote-storage.css';

type Scope = 'drive_file' | 'drive_readonly';
type Backend = 'local' | 'gdrive';

interface DriveAccount {
  id: string;
  name: string;
  scope_mode: Scope;
  account_email: string | null;
  status: 'connected' | 'auth_required';
  last_error: string | null;
}

export interface DriveBinding {
  collection: 'music' | 'books';
  library_id: string;
  account_id: string;
  root_folder_name: string;
  last_synced_at: string | null;
  cache_max_mb: number;
  cache_used_bytes: number;
  scope_mode: Scope;
  account_status: DriveAccount['status'];
  last_error: string | null;
}

const endpoints = {
  accounts: '/remote-storage/accounts',
  authorize: '/remote-storage/authorize',
  test: '/remote-storage/test',
  revoke: '/remote-storage/revoke',
  libraries: '/remote-storage/libraries',
  sync: '/remote-storage/sync',
  cache: '/remote-storage/cache',
  clear: '/remote-storage/cache/clear',
} as const;
const callbackKey = 'wildstring-drive-callback';
export const driveAccountChanged = 'wildstring:drive-account-changed';

function post<T>(path: (typeof endpoints)[keyof typeof endpoints], body: object) {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body), timeoutMs: 0 });
}

export function hasDriveCallback() {
  return Boolean(sessionStorage.getItem(callbackKey));
}

async function authorize(account_id: string) {
  const { authorization_url } = await post<{ authorization_url: string }>(endpoints.authorize, {
    account_id,
  });
  const url = new URL(authorization_url);
  if (
    url.origin !== 'https://accounts.google.com' ||
    url.pathname !== '/o/oauth2/v2/auth' ||
    url.username ||
    url.password
  )
    throw new Error(errorCodeMessage('remote_storage_credentials_invalid'));
  location.assign(url.href);
}

function useDriveAccounts() {
  const [accounts, setAccounts] = useState<DriveAccount[] | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((value) => value + 1);
  useEffect(() => {
    window.addEventListener(driveAccountChanged, refresh);
    return () => window.removeEventListener(driveAccountChanged, refresh);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    api<{ items: DriveAccount[] }>(endpoints.accounts, { signal: controller.signal })
      .then(({ items }) => {
        setAccounts(items);
        setError('');
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [revision]);
  return { accounts, error, refresh };
}

export function DriveAccounts() {
  const { t } = useTranslation();
  const id = useId();
  const { accounts, error: loadError, refresh } = useDriveAccounts();
  const [adding, setAdding] = useState(false);
  const [scope, setScope] = useState<Scope>('drive_file');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [callback] = useState(() => sessionStorage.getItem(callbackKey));
  const [notice, setNotice] = useState('');
  useEffect(() => sessionStorage.removeItem(callbackKey), []);

  async function perform(action: string, run: () => Promise<unknown>) {
    setBusy(action);
    setError('');
    setNotice('');
    try {
      await run();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy('');
    }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void perform('create', async () => {
      await post<DriveAccount>(endpoints.accounts, {
        name: data.get('name'),
        client_id: data.get('client_id'),
        client_secret: data.get('client_secret'),
        scope_mode: scope,
      });
      form.reset();
      setAdding(false);
      window.dispatchEvent(new Event(driveAccountChanged));
    });
  }

  return (
    <section className="management-card music-library-manager drive-accounts" aria-labelledby={id}>
      <h2 id={id}>{t('drive.accounts')}</h2>
      {(loadError || error || (callback && callback !== 'connected')) && (
        <p className="error" role="alert">
          {loadError ||
            error ||
            (callback && callback.startsWith('remote_storage_')
              ? errorCodeMessage(callback)
              : t('drive.callbackFailed'))}
        </p>
      )}
      {loadError && <button onClick={refresh}>{t('bookshelf.retry')}</button>}
      {(notice || callback === 'connected') && (
        <p role="status">{notice || t('drive.connected')}</p>
      )}
      {!loadError && accounts === null && (
        <p role="status" className="muted drive-account-row">
          {t('drive.loading')}
        </p>
      )}
      {accounts?.length === 0 && <p className="muted">{t('drive.empty')}</p>}
      {accounts?.map((account) => (
        <div className="drive-account-row" key={account.id}>
          <div>
            <strong>{account.name}</strong>
            <p className="muted">
              {t(`drive.${account.scope_mode}`)}
              {account.account_email ? ` · ${account.account_email}` : ''}
            </p>
            {account.status === 'auth_required' && (
              <p role="status" className="muted">
                {t('drive.authRequired')}
              </p>
            )}
          </div>
          <div className="music-library-actions">
            {account.status === 'auth_required' ? (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void perform(account.id, () => authorize(account.id))}
              >
                {t(account.account_email ? 'drive.reconnect' : 'drive.connect')}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void perform(account.id, async () => {
                      await post(endpoints.test, { account_id: account.id });
                      setNotice(t('drive.connectionOk'));
                    })
                  }
                >
                  {t('drive.test')}
                </button>
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void perform(account.id, () =>
                      post(endpoints.revoke, { account_id: account.id }),
                    ).finally(() => {
                      window.dispatchEvent(new Event(driveAccountChanged));
                      window.dispatchEvent(new Event('wildstring:libraries-updated'));
                    })
                  }
                >
                  {t('drive.revoke')}
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {adding ? (
        <form onSubmit={create}>
          <details open>
            <summary>{t('drive.setup')}</summary>
            <p className="muted">{t('drive.setupInstructions')}</p>
            <code className="storage-path">{location.origin}/api/v1/remote-storage/callback</code>
            {scope === 'drive_readonly' && <p className="muted">{t('drive.production')}</p>}
          </details>
          <label htmlFor={`${id}-name`}>{t('drive.accountName')}</label>
          <input id={`${id}-name`} name="name" required maxLength={100} disabled={Boolean(busy)} />
          <label htmlFor={`${id}-scope`}>{t('drive.accessMode')}</label>
          <select
            id={`${id}-scope`}
            value={scope}
            onChange={(event) => setScope(event.target.value as Scope)}
            disabled={Boolean(busy)}
          >
            <option value="drive_file">{t('drive.drive_file')}</option>
            <option value="drive_readonly">{t('drive.drive_readonly')}</option>
          </select>
          <label htmlFor={`${id}-client`}>Client ID</label>
          <input
            id={`${id}-client`}
            name="client_id"
            required
            maxLength={512}
            disabled={Boolean(busy)}
            autoComplete="off"
          />
          <label htmlFor={`${id}-secret`}>Client secret</label>
          <input
            id={`${id}-secret`}
            name="client_secret"
            type="password"
            required
            maxLength={512}
            disabled={Boolean(busy)}
            autoComplete="new-password"
          />
          <div className="music-library-actions">
            <button type="submit" className="primary" disabled={Boolean(busy)}>
              {t('drive.saveAccount')}
            </button>
            <button type="button" disabled={Boolean(busy)} onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => setAdding(true)}>
          {t('drive.addAccount')}
        </button>
      )}
    </section>
  );
}

export const defaultDriveDraft = { account_id: '', folder_id: '', cache_max_mb: '2048' };

export function StorageBackendField({
  value,
  onChange,
  disabled,
}: {
  value: Backend;
  onChange: (value: Backend) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <>
      <label htmlFor={id}>{t('drive.backend')}</label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as Backend)}
        disabled={disabled}
      >
        <option value="local">{t('drive.local')}</option>
        <option value="gdrive">Google Drive</option>
      </select>
    </>
  );
}

export function createDriveLibrary(
  draft: typeof defaultDriveDraft,
  name: string,
  collection: DriveBinding['collection'],
  default_access: boolean,
  auto_pair = true,
) {
  if (!draft.account_id) throw new Error(errorCodeMessage('remote_storage_auth_required'));
  return post<{ id: string }>(endpoints.libraries, {
    ...draft,
    name,
    collection,
    default_access,
    auto_pair,
    folder_id: draft.folder_id.trim() || null,
    cache_max_mb: Number(draft.cache_max_mb),
  });
}

export function DriveFields({
  draft,
  onChange,
  disabled,
}: {
  draft: typeof defaultDriveDraft;
  onChange: (draft: typeof defaultDriveDraft) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { accounts, error, refresh } = useDriveAccounts();
  const connected = accounts?.filter((account) => account.status === 'connected') ?? [];
  const readonly =
    connected.find((account) => account.id === draft.account_id)?.scope_mode === 'drive_readonly';
  return (
    <>
      {error && (
        <div role="alert" className="error">
          {error}{' '}
          <button type="button" onClick={refresh}>
            {t('bookshelf.retry')}
          </button>
        </div>
      )}
      {!error && accounts === null && (
        <p role="status" className="muted">
          {t('drive.loading')}
        </p>
      )}
      {accounts !== null && connected.length === 0 && (
        <p className="muted">{t('drive.connectFirst')}</p>
      )}
      <label htmlFor={`${id}-account`}>{t('drive.account')}</label>
      <select
        id={`${id}-account`}
        value={draft.account_id}
        onChange={(event) => onChange({ ...draft, account_id: event.target.value })}
        disabled={disabled}
        required
      >
        <option value="">{t('drive.choose')}</option>
        {connected.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-folder`}>{t('drive.folderId')}</label>
      <input
        id={`${id}-folder`}
        value={draft.folder_id}
        onChange={(event) => onChange({ ...draft, folder_id: event.target.value })}
        pattern="[A-Za-z0-9_\x2D]{1,256}"
        disabled={disabled}
        required={readonly}
      />
      <p className="muted">{t(readonly ? 'drive.folderRequired' : 'drive.folderOptional')}</p>
      <label htmlFor={`${id}-cache`}>{t('drive.cacheLimit')}</label>
      <input
        id={`${id}-cache`}
        type="number"
        min={0}
        max={1048576}
        value={draft.cache_max_mb}
        onChange={(event) => onChange({ ...draft, cache_max_mb: event.target.value })}
        disabled={disabled}
        required
      />
      <p className="muted">{t('drive.cacheHint')}</p>
    </>
  );
}

export function DriveLibraryControls({
  binding,
  refresh,
}: {
  binding: DriveBinding;
  refresh: () => Promise<unknown>;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [limit, setLimit] = useState(String(binding.cache_max_mb));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => setLimit(String(binding.cache_max_mb)), [binding.cache_max_mb]);
  const { collection, library_id, account_id } = binding;
  const needsAuth = binding.account_status === 'auth_required';

  async function act(action: 'sync' | 'clear' | 'cache' | 'authorize') {
    setBusy(action);
    setError('');
    setNotice('');
    try {
      if (action === 'authorize') {
        await authorize(account_id);
        return;
      }
      const result = await post<{ status?: string }>(endpoints[action], {
        collection,
        library_id,
        ...(action === 'cache' ? { cache_max_mb: Number(limit) } : {}),
      });
      await refresh();
      setNotice(
        t(
          action === 'sync' && result.status === 'completed_with_errors'
            ? 'drive.syncErrors'
            : `drive.${action}Done`,
        ),
      );
      if (action === 'sync') window.dispatchEvent(new Event('wildstring:libraries-updated'));
    } catch (cause) {
      setError((cause as Error).message);
      if (action === 'sync') await refresh().catch(() => undefined);
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="library-storage drive-library" aria-labelledby={id}>
      <h3 id={id}>Google Drive</h3>
      <p>
        <strong>{binding.root_folder_name}</strong>
      </p>
      <p className="muted drive-stats">
        {binding.last_synced_at
          ? t('drive.lastSync', { time: new Date(binding.last_synced_at).toLocaleString() })
          : t('drive.neverSynced')}
      </p>
      {!needsAuth && (error || binding.last_error) && (
        <p role="alert" className="error">
          {error || errorCodeMessage(binding.last_error!)}
        </p>
      )}
      {needsAuth && (
        <p role="alert" className="error">
          {t('drive.authRequired')}
        </p>
      )}
      {(notice || busy === 'sync') && (
        <p role="status">{busy === 'sync' ? t('drive.syncing') : notice}</p>
      )}
      <div className="music-library-actions">
        {needsAuth ? (
          <button type="button" disabled={Boolean(busy)} onClick={() => void act('authorize')}>
            {t('drive.reconnect')}
          </button>
        ) : (
          <button type="button" disabled={Boolean(busy)} onClick={() => void act('sync')}>
            {t('drive.sync')}
          </button>
        )}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void act('cache');
        }}
      >
        <label htmlFor={`${id}-cache`}>{t('drive.cacheLimit')}</label>
        <input
          id={`${id}-cache`}
          type="number"
          min={0}
          max={1048576}
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
          disabled={Boolean(busy)}
          required
        />
        <p className="muted drive-stats">
          {t('drive.cacheUsed', {
            used: new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }).format(
              binding.cache_used_bytes / 1048576,
            ),
          })}
        </p>
        <div className="music-library-actions">
          <button type="submit" disabled={Boolean(busy) || Number(limit) === binding.cache_max_mb}>
            {t('drive.saveLimit')}
          </button>
          <button
            type="button"
            disabled={Boolean(busy) || binding.cache_used_bytes === 0}
            onClick={() => void act('clear')}
          >
            {t('drive.clear')}
          </button>
        </div>
      </form>
    </section>
  );
}
