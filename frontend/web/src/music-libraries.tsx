import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { selectLibrary, selectedLibrary } from './library-context';
import { LibraryStorage } from './library-storage';
import { FolderPicker } from './folder-picker';
import './music-libraries.css';

export interface MusicLibrary {
  id: string;
  name: string;
  enabled: boolean;
  is_default: boolean;
  version: number;
  default_access?: boolean;
  sources?: { id: string; root: string; watch_enabled?: number }[];
  managed_root?: string;
}

export function LibrarySwitcher({
  onChanged,
  management = false,
  visible = true,
}: {
  onChanged: () => void;
  management?: boolean;
  visible?: boolean;
}) {
  const { t } = useTranslation();
  const [libraries, setLibraries] = useState<MusicLibrary[]>([]);
  const [selected, setSelected] = useState(selectedLibrary());
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const items = await api<MusicLibrary[]>('/libraries');
        if (!active) return;
        setSupported(true);
        setLibraries(items);
        if (management && visible && selectedLibrary() === 'all' && items[0])
          selectLibrary(items.find((item) => item.is_default)?.id || items[0].id);
        if (selectedLibrary() !== 'all' && !items.some((item) => item.id === selectedLibrary()))
          selectLibrary('all');
        setSelected(selectedLibrary());
      } catch {
        /* Older servers keep their single-library interface. */
      }
    }
    const changed = () => {
      setSelected(selectedLibrary());
      onChanged();
    };
    void load();
    window.addEventListener('focus', load);
    window.addEventListener('wildstring:library-changed', changed);
    window.addEventListener('wildstring:library-access-changed', load);
    window.addEventListener('wildstring:libraries-updated', load);
    const interval = window.setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', load);
      window.removeEventListener('wildstring:library-changed', changed);
      window.removeEventListener('wildstring:library-access-changed', load);
      window.removeEventListener('wildstring:libraries-updated', load);
    };
  }, [onChanged, management, visible]);
  if (!supported || !visible || (!management && libraries.length === 1)) return null;
  if (!management && libraries.length === 0)
    return <small className="music-access-empty">{t('musicLibraries.noPlayableMusic')}</small>;
  if (management && libraries.length === 1)
    return (
      <div className="music-library-switcher music-library-switcher-management">
        <span>{t('musicLibraries.currentLibrary')}</span>
        <strong>{libraries[0].name}</strong>
      </div>
    );
  return (
    <label
      className={`music-library-switcher ${management ? 'music-library-switcher-management' : 'music-library-switcher-browse'}`}
    >
      {management ? t('musicLibraries.currentLibrary') : t('musicLibraries.browseScope')}
      <select
        aria-label={t('musicLibraries.selectLibraryAria')}
        value={selected}
        onChange={(event) => selectLibrary(event.target.value)}
      >
        {!management && <option value="all">{t('musicLibraries.allMusic')}</option>}
        {libraries.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      {libraries.length === 0 && <small>{t('musicLibraries.noAssignedLibraries')}</small>}
    </label>
  );
}

export function MusicLibraryManager() {
  const { t } = useTranslation();
  const id = useId();
  const [libraries, setLibraries] = useState<MusicLibrary[]>([]);
  const [editing, setEditing] = useState<MusicLibrary | null>(null);
  const [name, setName] = useState('');
  const [folders, setFolders] = useState('');
  const [paused, setPaused] = useState<string[]>([]);
  const [managedRoot, setManagedRoot] = useState('');
  const [defaultAccess, setDefaultAccess] = useState(false);
  const [picker, setPicker] = useState<'source' | 'managed' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function load() {
    const items = await api<MusicLibrary[]>('/libraries?include_disabled=true');
    setLibraries(items);
    return items;
  }
  useEffect(() => {
    void load().catch((reason: Error) => setError(reason.message));
  }, []);
  function edit(item: MusicLibrary | null) {
    setEditing(item);
    setName(item?.name || '');
    setDefaultAccess(item?.default_access ?? item?.is_default ?? false);
    setFolders(item?.sources?.map((s) => s.root).join('\n') || '');
    setPaused(item?.sources?.filter((s) => s.watch_enabled === 0).map((s) => s.root) || []);
    setManagedRoot('');
    setError('');
    setNotice('');
  }
  async function save(enabled = true) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(`/libraries${editing ? `/${editing.id}` : ''}`, {
        method: editing ? 'PUT' : 'POST',
        body: JSON.stringify({
          name,
          default_access: defaultAccess,
          source_roots: folders
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
          paused_source_roots: paused.filter((root) =>
            folders
              .split('\n')
              .map((s) => s.trim())
              .includes(root),
          ),
          ...(!editing && managedRoot.trim() ? { managed_root: managedRoot.trim() } : {}),
          ...(editing ? { version: editing.version, enabled } : {}),
        }),
      });
      edit(null);
      await load();
      setNotice(t('musicLibraries.savedNotice'));
      window.dispatchEvent(new Event('wildstring:libraries-updated'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('musicLibraries.saveFailed'));
    } finally {
      setBusy(false);
    }
  }
  async function reread() {
    const identity = editing?.id;
    if (!identity) return;
    setBusy(true);
    try {
      const items = await load();
      edit(items.find((item) => item.id === identity) || null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('musicLibraries.loadFailed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="management-card music-library-manager"
      aria-label={t('musicLibraries.configAria')}
    >
      <h2>{t('musicLibraries.configAria')}</h2>
      <p className="muted">{t('musicLibraries.configDescription')}</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="music-library-list">
        {libraries.map((item) => (
          <button type="button" key={item.id} onClick={() => edit(item)} disabled={busy}>
            <strong>{item.name}</strong>
            <span>
              {t('musicLibraries.sourcesCount', {
                count: item.sources?.length || 0,
                status: item.enabled
                  ? t('musicLibraries.statusEnabled')
                  : t('musicLibraries.statusDisabled'),
              })}
              {item.is_default ? t('musicLibraries.defaultTag') : ''}
            </span>
          </button>
        ))}
        <button type="button" onClick={() => edit(null)} disabled={busy}>
          {t('musicLibraries.newLibrary')}
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h3>
          {editing
            ? t('musicLibraries.editLibraryTitle', { name: editing.name })
            : t('musicLibraries.createLibraryTitle')}
        </h3>
        <label htmlFor={`${id}-name`}>{t('musicLibraries.libraryName')}</label>
        <input
          id={`${id}-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={100}
          disabled={busy}
        />
        <label className="music-library-grant-option">
          <input
            type="checkbox"
            checked={defaultAccess}
            disabled={busy}
            onChange={(event) => setDefaultAccess(event.target.checked)}
          />
          <span>{t('musicLibraries.defaultAccessCheckbox')}</span>
        </label>
        <p className="muted">{t('musicLibraries.defaultAccessHint')}</p>
        <div className="library-folder-heading">
          <label htmlFor={`${id}-folders`}>{t('musicLibraries.sourceFoldersLabel')}</label>
          <button type="button" disabled={busy} onClick={() => setPicker('source')}>
            {t('musicLibraries.browseSourceFolders')}
          </button>
        </div>
        <textarea
          id={`${id}-folders`}
          value={folders}
          onChange={(event) => setFolders(event.target.value)}
          required
          rows={4}
          disabled={busy}
        />
        <fieldset disabled={busy}>
          <legend>{t('musicLibraries.watchFoldersLegend')}</legend>
          {folders
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((root, index) => (
              <label className="music-library-grant-option" key={`${root}:${index}`}>
                <input
                  type="checkbox"
                  checked={!paused.includes(root)}
                  onChange={(e) =>
                    setPaused(
                      e.target.checked ? paused.filter((p) => p !== root) : [...paused, root],
                    )
                  }
                />
                <span className="storage-path">{root}</span>
              </label>
            ))}
          <p className="muted">{t('musicLibraries.watchFoldersHint')}</p>
        </fieldset>
        {!editing && (
          <>
            <label htmlFor={`${id}-managed`}>{t('musicLibraries.managedDirLabel')}</label>
            <input
              id={`${id}-managed`}
              value={managedRoot}
              onChange={(e) => setManagedRoot(e.target.value)}
              placeholder={t('musicLibraries.managedDirPlaceholder')}
              disabled={busy}
            />
            <button type="button" disabled={busy} onClick={() => setPicker('managed')}>
              {t('musicLibraries.browseManagedDir')}
            </button>
            <p className="muted">{t('musicLibraries.managedDirHint')}</p>
          </>
        )}
        <div className="music-library-actions">
          <button type="submit" disabled={busy}>
            {busy ? t('musicLibraries.saving') : t('musicLibraries.saveLibrary')}
          </button>
          {editing && !editing.is_default && (
            <button type="button" disabled={busy} onClick={() => void save(!editing.enabled)}>
              {editing.enabled
                ? t('musicLibraries.disableLibrary')
                : t('musicLibraries.enableLibrary')}
            </button>
          )}
          {editing && (
            <button type="button" disabled={busy} onClick={() => void reread()}>
              {t('musicLibraries.reloadConfig')}
            </button>
          )}
        </div>
      </form>
      {picker && (
        <FolderPicker
          title={
            picker === 'source'
              ? t('musicLibraries.pickerSourceTitle')
              : t('musicLibraries.pickerManagedTitle')
          }
          onClose={() => setPicker(null)}
          onSelect={(path) => {
            if (picker === 'source')
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
            else setManagedRoot(path);
            setPicker(null);
          }}
        />
      )}
      {editing && <LibraryStorage library={editing} onChanged={reread} />}
    </section>
  );
}
