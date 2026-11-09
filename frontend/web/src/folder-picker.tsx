import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { Icon } from './icons';
import { DialogCloseButton } from './dialog-close';

type FolderListing = {
  path: string | null;
  parent: string | null;
  items: { name: string; path: string }[];
  truncated: boolean;
  can_create?: boolean;
  creation_blocked_reason?: 'read_only_source' | 'not_writable' | null;
};

export function FolderPicker({
  title,
  initialPath = '',
  onSelect,
  onClose,
}: {
  title: string;
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const pathRevision = useRef(0);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [path, setPath] = useState(initialPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(
    async (next?: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      const revision = pathRevision.current;
      setBusy(true);
      setError('');
      setShowCreate(false);
      setFolderName('');
      setCreateError('');
      setNotice('');
      try {
        const value = await api<FolderListing>(
          `/libraries/folders${next ? `?path=${encodeURIComponent(next)}` : ''}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setListing(value);
        if (pathRevision.current === revision) setPath(value.path || '');
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : t('folderPicker.readFailed'));
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [t],
  );
  useEffect(() => {
    dialog.current?.showModal();
    void load(initialPath || undefined);
    return () => {
      request.current?.abort();
    };
  }, [initialPath, load]);
  async function createFolder(event: FormEvent) {
    event.preventDefault();
    if (!listing?.path || !listing.can_create || creating || !folderName.trim()) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setCreating(true);
    setCreateError('');
    setNotice('');
    try {
      const value = await api<FolderListing>('/libraries/folders', {
        method: 'POST',
        body: JSON.stringify({ parent_path: listing.path, name: folderName.trim() }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setListing(value);
      setPath(value.path || '');
      setShowCreate(false);
      setFolderName('');
      setNotice(t('folderPicker.createdNotice'));
    } catch (reason) {
      if (!controller.signal.aborted)
        setCreateError(reason instanceof Error ? reason.message : t('folderPicker.createFailed'));
    } finally {
      if (!controller.signal.aborted) setCreating(false);
    }
  }
  const parts = listing?.path?.split('/').filter(Boolean) || [];
  return (
    <dialog
      ref={dialog}
      className="server-folder-picker"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (creating) return;
        if (showCreate) setShowCreate(false);
        else onClose();
      }}
      onClick={(event) => {
        if (!creating && event.target === event.currentTarget) onClose();
      }}
    >
      <header>
        <div>
          <span className="eyebrow">{t('folderPicker.eyebrow')}</span>
          <h2>{title}</h2>
        </div>
        <DialogCloseButton
          aria-label={t('folderPicker.closeAria')}
          disabled={creating}
          onClick={onClose}
        />
      </header>
      <div className="folder-picker-body">
        <p className="muted">{t('folderPicker.description')}</p>
        <div className="folder-path-entry">
          <input
            aria-label={t('folderPicker.pathAria')}
            value={path}
            disabled={creating}
            placeholder={t('folderPicker.pathPlaceholder')}
            onChange={(event) => {
              pathRevision.current += 1;
              setPath(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void load(path.trim());
              }
            }}
          />
          <button
            type="button"
            disabled={busy || creating || !path.trim()}
            onClick={() => void load(path.trim())}
          >
            {t('folderPicker.openPath')}
          </button>
          <button
            type="button"
            disabled={busy || creating || !!error || !listing?.can_create}
            onClick={() => {
              setShowCreate(true);
              setCreateError('');
              setNotice('');
            }}
          >
            <Icon name="add" /> {t('folderPicker.newFolder')}
          </button>
        </div>
        <nav aria-label={t('folderPicker.navAria')}>
          <button type="button" disabled={creating} onClick={() => void load()}>
            {t('folderPicker.commonLocations')}
          </button>
          {listing?.path && (
            <button type="button" disabled={creating} onClick={() => void load('/')}>
              /
            </button>
          )}
          {parts.map((part, index) => (
            <button
              type="button"
              key={index}
              disabled={creating}
              onClick={() => void load('/' + parts.slice(0, index + 1).join('/'))}
            >
              {part}
            </button>
          ))}
        </nav>
        {listing?.creation_blocked_reason && (
          <p className="folder-picker-hint">
            {listing?.creation_blocked_reason === 'read_only_source'
              ? t('folderPicker.sourceReadOnly')
              : t('folderPicker.dirNotWritable')}
          </p>
        )}
        {showCreate && (
          <form
            className="folder-create-form"
            aria-label={t('folderPicker.createFolderFormAria')}
            onSubmit={createFolder}
          >
            <label>
              {t('folderPicker.folderNameLabel')}
              <input
                autoFocus
                required
                maxLength={255}
                value={folderName}
                onChange={(event) => setFolderName(event.target.value)}
                placeholder={t('folderPicker.folderNamePlaceholder')}
                disabled={creating}
              />
            </label>
            <div className="folder-create-actions">
              <button type="button" disabled={creating} onClick={() => setShowCreate(false)}>
                {t('folderPicker.cancelCreate')}
              </button>
              <button className="primary" disabled={creating || !folderName.trim()}>
                {creating ? t('folderPicker.creating') : t('folderPicker.createFolderBtn')}
              </button>
            </div>
            {createError && (
              <p className="error" role="alert">
                {createError}
              </p>
            )}
          </form>
        )}
        {notice && (
          <p className="folder-picker-notice" role="status">
            {notice}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="folder-picker-list" aria-busy={busy || creating}>
          {busy || creating ? (
            <p role="status">
              {creating ? t('folderPicker.statusCreating') : t('folderPicker.statusReading')}
            </p>
          ) : (
            <>
              {listing?.parent && (
                <button type="button" onClick={() => void load(listing.parent!)}>
                  <Icon name="up" />
                  <span className="folder-entry-label">{t('folderPicker.parentFolder')}</span>
                </button>
              )}
              {listing?.items.map((item) => (
                <button type="button" key={item.path} onClick={() => void load(item.path)}>
                  <Icon name="folder" />
                  <span className="folder-entry-label">
                    <strong>
                      {item.name === '音乐来源（只读）'
                        ? t('folderPicker.rootMusicSource')
                        : item.name === '托管存储位置'
                          ? t('folderPicker.rootManagedStorage')
                          : item.name === '服务器根目录'
                            ? t('folderPicker.rootServerRoot')
                            : item.name}
                    </strong>
                    <small>{item.path}</small>
                  </span>
                  <Icon name="chevron" />
                </button>
              ))}
              {listing?.items.length === 0 && (
                <p className="muted">{t('folderPicker.noSubfolders')}</p>
              )}
              {listing?.truncated && <p className="muted">{t('folderPicker.limitHint')}</p>}
            </>
          )}
        </div>
      </div>
      <footer>
        <div className="folder-picker-current">
          <span>{t('folderPicker.currentDirLabel')}</span>
          <span className="storage-path">{listing?.path || t('folderPicker.pleaseSelectDir')}</span>
        </div>
        <div className="folder-picker-actions">
          <button type="button" disabled={creating} onClick={onClose}>
            {t('folderPicker.cancel')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || creating || !!error || !listing?.path}
            onClick={() => {
              if (listing?.path) onSelect(listing.path);
            }}
          >
            {t('folderPicker.selectThisFolder')}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
