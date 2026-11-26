import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { FolderPicker } from './folder-picker';
import {
  createDriveLibrary,
  defaultDriveDraft,
  DriveFields,
  DriveLibraryControls,
  StorageBackendField,
  type DriveBinding,
} from './remote-storage';
import './music-libraries.css';

interface BookLibrarySource {
  id: string;
  root: string;
  watch_enabled?: number;
}

interface BookLibrary {
  id: string;
  name: string;
  storage_mode: 'copy' | 'hardlink';
  storage_backend?: 'local' | 'gdrive';
  remote?: DriveBinding;
  default_access: 'restricted' | 'all';
  auto_pair: boolean;
  version: number;
  managed_root?: string;
  sources?: BookLibrarySource[];
}

interface MemberUser {
  id: string;
  username: string;
  profile: string;
  enabled: boolean;
}

interface MetadataSource {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
}

interface MigrationJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  target_root: string;
  copied_files: number;
  total_files: number;
  copied_bytes: number;
  total_bytes: number;
  relinked_files: number;
  reclaimed_bytes: number;
  kept_standalone_files: number;
  sidecars_written: number;
  error?: string;
}

export function BookLibraryManager({ canOwner }: { canOwner: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const [libraries, setLibraries] = useState<BookLibrary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [defaultAccess, setDefaultAccess] = useState<'restricted' | 'all'>('restricted');
  const [autoPair, setAutoPair] = useState(true);
  const [folders, setFolders] = useState('');
  const [paused, setPaused] = useState<string[]>([]);
  const [managedRoot, setManagedRoot] = useState('');
  const [backend, setBackend] = useState<'local' | 'gdrive'>('local');
  const [drive, setDrive] = useState(defaultDriveDraft);
  const [storageMode, setStorageMode] = useState<'copy' | 'hardlink'>('copy');
  const [migrateMode, setMigrateMode] = useState<'copy' | 'hardlink'>('hardlink');
  const [migrateRoot, setMigrateRoot] = useState('');
  const [picker, setPicker] = useState<'source' | 'managed' | 'migrate' | null>(null);
  const [jobs, setJobs] = useState<MigrationJob[]>([]);
  const [members, setMembers] = useState<MemberUser[]>([]);
  const [grantedIds, setGrantedIds] = useState<Set<string>>(new Set());
  const [exported, setExported] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [migrationError, setMigrationError] = useState('');
  const [busy, setBusy] = useState(false);

  const selected = libraries.find((item) => item.id === selectedId) ?? null;
  const activeJob = jobs.find((job) => job.status === 'queued' || job.status === 'running') ?? null;

  const populateForm = useCallback((library: BookLibrary | null) => {
    setSelectedId(library?.id ?? null);
    setBackend(library?.storage_backend || 'local');
    setDrive(defaultDriveDraft);
    setName(library?.name || '');
    setDefaultAccess(library?.default_access || 'restricted');
    setAutoPair(library?.auto_pair ?? true);
    setFolders(library?.sources?.map((src) => src.root).join('\n') || '');
    setPaused(
      library?.sources?.filter((src) => src.watch_enabled === 0).map((src) => src.root) || [],
    );
    setManagedRoot('');
    setStorageMode(library?.storage_mode || 'copy');
    setMigrateMode(library?.storage_mode === 'copy' ? 'hardlink' : 'copy');
    setMigrateRoot('');
    setExported(null);
    setError('');
    setMigrationError('');
    setNotice('');
  }, []);

  const loadLibraries = useCallback(
    async (focusId?: string | null) => {
      const result = await api<{ items: BookLibrary[] }>('/book-libraries');
      setLibraries(result.items);
      const nextId = focusId === undefined ? selectedId : focusId;
      if (nextId) {
        const match = result.items.find((item) => item.id === nextId) ?? null;
        if (match) populateForm(match);
        else populateForm(null);
      }
      return result.items;
    },
    [populateForm, selectedId],
  );

  useEffect(() => {
    void api<{ items: BookLibrary[] }>('/book-libraries')
      .then((result) => setLibraries(result.items))
      .catch((cause: Error) => setError(cause.message));
  }, []);

  useEffect(() => {
    if (!canOwner || !selectedId) {
      setJobs([]);
      setMembers([]);
      setGrantedIds(new Set());
      return;
    }
    const controller = new AbortController();
    const loadMigrations = () =>
      void api<{ items: MigrationJob[] }>(`/book-libraries/${selectedId}/migrations`, {
        signal: controller.signal,
      })
        .then((result) => setJobs(result.items))
        .catch((cause: Error) => {
          if (!controller.signal.aborted) setError(cause.message);
        });
    void Promise.all([
      api<{ items: MemberUser[] }>('/manage/users', { signal: controller.signal }),
      api<{ user_ids: string[] }>(`/book-libraries/${selectedId}/access`, {
        signal: controller.signal,
      }),
    ])
      .then(([userList, grants]) => {
        setMembers(userList.items.filter((member) => member.profile !== 'owner'));
        setGrantedIds(new Set(grants.user_ids));
      })
      .catch(() => undefined);
    setJobs([]);
    if (selected?.storage_backend !== 'gdrive') loadMigrations();
    const timer =
      selected?.storage_backend === 'gdrive' ? undefined : window.setInterval(loadMigrations, 2500);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [canOwner, selectedId, selected?.storage_backend]);

  const parsedSources = folders
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  async function saveLibrary(event: FormEvent) {
    event.preventDefault();
    if (!canOwner) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved =
        !selected && backend === 'gdrive'
          ? await createDriveLibrary(drive, name, 'books', defaultAccess === 'all', autoPair)
          : await api<BookLibrary>(`/book-libraries${selected ? `/${selected.id}` : ''}`, {
              method: selected ? 'PUT' : 'POST',
              body: JSON.stringify({
                name,
                default_access: defaultAccess,
                auto_pair: autoPair,
                source_roots: parsedSources,
                paused_source_roots: paused.filter((root) => parsedSources.includes(root)),
                ...(!selected && managedRoot.trim() ? { managed_root: managedRoot.trim() } : {}),
                ...(selected ? { version: selected.version } : { storage_mode: storageMode }),
              }),
            });
      await loadLibraries(saved.id);
      setNotice(t('bookshelf.savedNotice'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('common.actionError'));
    } finally {
      setBusy(false);
    }
  }

  async function runScan() {
    if (!selected) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ status: string }>(`/book-libraries/${selected.id}/scan`, {
        method: 'POST',
        timeoutMs: 0,
      });
      setNotice(result.status === 'completed' ? t('bookshelf.scanned') : t('bookshelf.scanErrors'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('common.actionError'));
    } finally {
      setBusy(false);
    }
  }

  async function exportSidecars() {
    if (!selected) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ sidecars_written: number }>(
        `/book-libraries/${selected.id}/export-sidecars`,
        { method: 'POST', timeoutMs: 0 },
      );
      setExported(result.sidecars_written);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('common.actionError'));
    } finally {
      setBusy(false);
    }
  }

  async function toggleGrant(member: MemberUser, granted: boolean) {
    if (!selected) return;
    setGrantedIds((prev) => {
      const next = new Set(prev);
      if (granted) next.add(member.id);
      else next.delete(member.id);
      return next;
    });
    setError('');
    try {
      await api(`/book-libraries/${selected.id}/access/${member.id}`, {
        method: 'PUT',
        body: JSON.stringify({ granted }),
      });
    } catch (cause) {
      setGrantedIds((prev) => {
        const rollback = new Set(prev);
        if (granted) rollback.delete(member.id);
        else rollback.add(member.id);
        return rollback;
      });
      setError(cause instanceof Error ? cause.message : t('common.actionError'));
    }
  }

  async function startMigration(event: FormEvent) {
    event.preventDefault();
    if (!selected || !canOwner) return;
    setBusy(true);
    setMigrationError('');
    try {
      await api(`/book-libraries/${selected.id}/migrations`, {
        method: 'POST',
        body: JSON.stringify({
          version: selected.version,
          target_storage_mode: migrateMode,
          ...(migrateRoot.trim() ? { managed_root: migrateRoot.trim() } : {}),
        }),
      });
      setMigrateRoot('');
      const refreshed = await api<{ items: MigrationJob[] }>(
        `/book-libraries/${selected.id}/migrations`,
      );
      setJobs(refreshed.items);
      await loadLibraries(selected.id);
    } catch (cause) {
      setMigrationError(cause instanceof Error ? cause.message : t('common.actionError'));
    } finally {
      setBusy(false);
    }
  }

  async function retryMigration(jobId: string) {
    if (!selected) return;
    setBusy(true);
    setMigrationError('');
    try {
      await api(`/book-libraries/${selected.id}/migrations/${jobId}/retry`, { method: 'POST' });
      const refreshed = await api<{ items: MigrationJob[] }>(
        `/book-libraries/${selected.id}/migrations`,
      );
      setJobs(refreshed.items);
    } catch (cause) {
      setMigrationError(cause instanceof Error ? cause.message : t('common.actionError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="management-card music-library-manager"
      aria-label={t('bookshelf.configAria')}
    >
      <h2>{t('bookshelf.configAria')}</h2>
      <p className="muted">{t('bookshelf.configDescription')}</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="music-library-list">
        {libraries.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={selectedId === item.id}
            onClick={() => populateForm(item)}
            disabled={busy}
          >
            <strong>{item.name}</strong>
            <span>
              {item.storage_backend === 'gdrive'
                ? 'Google Drive'
                : t('bookshelf.librarySummary', {
                    count: item.sources?.length ?? 0,
                    mode: t(
                      item.storage_mode === 'hardlink' ? 'bookshelf.hardlink' : 'bookshelf.copy',
                    ),
                    access: t(
                      item.default_access === 'all' ? 'bookshelf.shared' : 'bookshelf.restricted',
                    ),
                  })}
            </span>
          </button>
        ))}
        {canOwner && (
          <button
            type="button"
            aria-pressed={selectedId === null}
            onClick={() => populateForm(null)}
            disabled={busy}
          >
            {t('bookshelf.newLibrary')}
          </button>
        )}
      </div>

      {canOwner && (
        <form onSubmit={(event) => void saveLibrary(event)}>
          <h3>
            {selected
              ? t('bookshelf.editLibraryTitle', { name: selected.name })
              : t('bookshelf.create')}
          </h3>
          <label htmlFor={`${id}-name`}>{t('bookshelf.name')}</label>
          <input
            id={`${id}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={100}
            disabled={busy}
          />
          <label htmlFor={`${id}-access`}>{t('bookshelf.access')}</label>
          <select
            id={`${id}-access`}
            value={defaultAccess}
            disabled={busy}
            onChange={(event) => setDefaultAccess(event.target.value as 'restricted' | 'all')}
          >
            <option value="restricted">{t('bookshelf.restricted')}</option>
            <option value="all">{t('bookshelf.shared')}</option>
          </select>
          <label className="music-library-grant-option">
            <input
              type="checkbox"
              checked={autoPair}
              disabled={busy}
              onChange={(event) => setAutoPair(event.target.checked)}
            />
            <span>{t('bookshelf.autoPairCheckbox')}</span>
          </label>
          {!selected && (
            <StorageBackendField value={backend} onChange={setBackend} disabled={busy} />
          )}
          {!selected && backend === 'gdrive' && (
            <DriveFields draft={drive} onChange={setDrive} disabled={busy} />
          )}
          {backend === 'local' && (
            <>
              <div className="library-folder-heading">
                <label htmlFor={`${id}-sources`}>{t('bookshelf.sources')}</label>
                <button type="button" disabled={busy} onClick={() => setPicker('source')}>
                  {t('musicLibraries.browseSourceFolders')}
                </button>
              </div>
              <textarea
                id={`${id}-sources`}
                value={folders}
                onChange={(event) => setFolders(event.target.value)}
                rows={3}
                disabled={busy}
              />
              {parsedSources.length > 0 && (
                <fieldset disabled={busy}>
                  <legend>{t('musicLibraries.watchFoldersLegend')}</legend>
                  {parsedSources.map((root, index) => (
                    <label className="music-library-grant-option" key={`${root}:${index}`}>
                      <input
                        type="checkbox"
                        checked={!paused.includes(root)}
                        onChange={(event) =>
                          setPaused(
                            event.target.checked
                              ? paused.filter((item) => item !== root)
                              : [...paused, root],
                          )
                        }
                      />
                      <span className="storage-path">{root}</span>
                    </label>
                  ))}
                  <p className="muted">{t('bookshelf.watchFoldersHint')}</p>
                </fieldset>
              )}
              {!selected && (
                <>
                  <label htmlFor={`${id}-mode`}>{t('bookshelf.storage')}</label>
                  <select
                    id={`${id}-mode`}
                    value={storageMode}
                    disabled={busy}
                    onChange={(event) => setStorageMode(event.target.value as 'copy' | 'hardlink')}
                  >
                    <option value="copy">{t('bookshelf.copy')}</option>
                    <option value="hardlink">{t('bookshelf.hardlink')}</option>
                  </select>
                  <label htmlFor={`${id}-managed`}>{t('bookshelf.managedRoot')}</label>
                  <input
                    id={`${id}-managed`}
                    value={managedRoot}
                    onChange={(event) => setManagedRoot(event.target.value)}
                    placeholder={t('musicLibraries.managedDirPlaceholder')}
                    disabled={busy}
                  />
                  <button type="button" disabled={busy} onClick={() => setPicker('managed')}>
                    {t('musicLibraries.browseManagedDir')}
                  </button>
                  <p className="muted">{t('bookshelf.managedDirHint')}</p>
                </>
              )}
            </>
          )}
          <div className="music-library-actions">
            <button type="submit" className="primary" disabled={busy}>
              {selected ? t('bookshelf.saveLibrary') : t('bookshelf.create')}
            </button>
            {selected && (
              <button type="button" disabled={busy} onClick={() => void loadLibraries(selected.id)}>
                {t('musicLibraries.reloadConfig')}
              </button>
            )}
          </div>
        </form>
      )}

      {selected && (
        <div className={selected.remote ? undefined : 'library-storage'}>
          {selected.remote && canOwner && (
            <DriveLibraryControls
              key={selected.id}
              binding={selected.remote}
              refresh={async () => {
                const result = await api<{ items: BookLibrary[] }>('/book-libraries');
                setLibraries(result.items);
              }}
            />
          )}
          {!canOwner && selected.storage_backend === 'gdrive' && (
            <p className="muted">{t('drive.ownerMaintenance')}</p>
          )}
          {selected.storage_backend !== 'gdrive' && (
            <>
              <h3>{t('bookshelf.maintenanceTitle')}</h3>
              <div className="music-library-actions">
                <button type="button" disabled={busy || !!activeJob} onClick={() => void runScan()}>
                  {t('bookshelf.scan')}
                </button>
                <button
                  type="button"
                  disabled={busy || !!activeJob}
                  onClick={() => void exportSidecars()}
                >
                  {t('bookshelf.export')}
                </button>
                {exported !== null && (
                  <span role="status">{t('bookshelf.exported', { count: exported })}</span>
                )}
              </div>
            </>
          )}
          {canOwner && (
            <>
              <h3>{t('bookshelf.memberAccess')}</h3>
              <p className="muted">
                {t(
                  selected.default_access === 'all'
                    ? 'bookshelf.memberAccessSharedHint'
                    : 'bookshelf.memberAccessRestrictedHint',
                )}
              </p>
              {members.length ? (
                <ul className="book-admin-access-list">
                  {members.map((member) => (
                    <li key={member.id}>
                      <label className="music-library-grant-option">
                        <input
                          type="checkbox"
                          checked={grantedIds.has(member.id)}
                          disabled={busy}
                          onChange={(event) =>
                            void toggleGrant(member, event.currentTarget.checked)
                          }
                        />
                        <span>{member.username}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">{t('bookshelf.noMembers')}</p>
              )}

              {selected.storage_backend !== 'gdrive' && (
                <>
                  <h3>{t('bookshelf.migrate')}</h3>
                  {selected.managed_root && <p className="storage-path">{selected.managed_root}</p>}
                  <form onSubmit={(event) => void startMigration(event)}>
                    <label htmlFor={`${id}-migrate-mode`}>{t('bookshelf.storage')}</label>
                    <select
                      id={`${id}-migrate-mode`}
                      value={migrateMode}
                      disabled={busy || !!activeJob}
                      onChange={(event) =>
                        setMigrateMode(event.target.value as 'copy' | 'hardlink')
                      }
                    >
                      <option value="copy">{t('bookshelf.copy')}</option>
                      <option value="hardlink">{t('bookshelf.hardlink')}</option>
                    </select>
                    <label htmlFor={`${id}-migrate-root`}>{t('bookshelf.managedRoot')}</label>
                    <input
                      id={`${id}-migrate-root`}
                      value={migrateRoot}
                      onChange={(event) => setMigrateRoot(event.target.value)}
                      placeholder={t('libraryStorage.newManagedDirPlaceholder')}
                      disabled={busy || !!activeJob}
                    />
                    <button
                      type="button"
                      disabled={busy || !!activeJob}
                      onClick={() => setPicker('migrate')}
                    >
                      {t('libraryStorage.browseMigrationTarget')}
                    </button>
                    {migrationError && (
                      <p role="alert" className="error">
                        {migrationError}
                      </p>
                    )}
                    <button type="submit" disabled={busy || !!activeJob}>
                      {t('bookshelf.migrate')}
                    </button>
                  </form>

                  {jobs.map((job) => (
                    <div key={job.id} className="library-migration-status" role="status">
                      <strong>{t(`bookshelf.job.${job.status}`)}</strong>
                      <p className="storage-path">{job.target_root}</p>
                      {(job.status === 'queued' || job.status === 'running') && (
                        <progress max={Math.max(job.total_bytes, 1)} value={job.copied_bytes} />
                      )}
                      <p>
                        {t('bookshelf.relinked', { count: job.relinked_files })} ·{' '}
                        {t('bookshelf.estimate', { bytes: job.reclaimed_bytes.toLocaleString() })} ·{' '}
                        {t('bookshelf.retained', { count: job.kept_standalone_files })} ·{' '}
                        {t('bookshelf.exported', { count: job.sidecars_written })}
                      </p>
                      {job.error && <p>{t(`errors.${job.error}`, { defaultValue: job.error })}</p>}
                      {job.status === 'failed' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void retryMigration(job.id)}
                        >
                          {t('bookshelf.retry')}
                        </button>
                      )}
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}

      {picker && (
        <FolderPicker
          title={
            picker === 'source'
              ? t('musicLibraries.pickerSourceTitle')
              : picker === 'managed'
                ? t('musicLibraries.pickerManagedTitle')
                : t('libraryStorage.selectTargetTitle')
          }
          onClose={() => setPicker(null)}
          onSelect={(path) => {
            if (picker === 'source') {
              setFolders((value) =>
                [
                  ...new Set([
                    ...value
                      .split('\n')
                      .map((item) => item.trim())
                      .filter(Boolean),
                    path,
                  ]),
                ].join('\n'),
              );
            } else if (picker === 'managed') {
              setManagedRoot(path);
            } else {
              setMigrateRoot(path);
            }
            setPicker(null);
          }}
        />
      )}
    </section>
  );
}

export function BookMetadataSourcesAdmin() {
  const { t } = useTranslation();
  const [sources, setSources] = useState<MetadataSource[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    void api<{ items: MetadataSource[]; all_sources?: MetadataSource[] }>('/books/metadata/sources')
      .then((result) => setSources(result.all_sources || result.items))
      .catch((cause: Error) => setError(cause.message));
  }, []);

  async function toggleSource(source: MetadataSource, enabled: boolean) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const updated = await api<{ items: MetadataSource[]; all_sources: MetadataSource[] }>(
        '/books/metadata/sources',
        {
          method: 'PUT',
          body: JSON.stringify({ [source.id]: enabled }),
        },
      );
      setSources(updated.all_sources);
      setNotice(t('bookshelf.metadataSourcesSaved'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('common.actionError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="management-card" aria-label={t('bookshelf.metadataSources')}>
      <h2>{t('bookshelf.metadataSources')}</h2>
      <p className="muted">{t('bookshelf.metadataSourcesHint')}</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <ul className="book-admin-access-list">
        {sources.map((source) => (
          <li key={source.id}>
            <label className="music-library-grant-option">
              <input
                type="checkbox"
                checked={source.enabled}
                disabled={busy}
                onChange={(event) => void toggleSource(source, event.currentTarget.checked)}
              />
              <span>{source.name}</span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
