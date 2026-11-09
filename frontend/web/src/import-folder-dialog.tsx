import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { DialogCloseButton } from './dialog-close';
import { Icon } from './icons';
import './import-folder-dialog.css';

export type ImportSource = { id: string; name: string; path?: string };
export type ImportSelection = { source_id: string; path: string };
export type ImportPreview = ImportSelection & {
  files: string[];
  count: number;
  pending_markers: string[];
};
type SourceListing = ImportSelection & {
  items: {
    name: string;
    path: string;
    kind: 'folder' | 'file';
    importable?: boolean;
    pending?: boolean;
  }[];
};

export function ImportFolderDialog({
  sources,
  initial,
  onSelect,
  onClose,
}: {
  sources: ImportSource[];
  initial: ImportSelection;
  onSelect: (selection: ImportSelection, preview: ImportPreview | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [sourceId, setSourceId] = useState(initial.source_id);
  const [path, setPath] = useState(initial.path);
  const [listing, setListing] = useState<SourceListing | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const load = useCallback(
    async (source: string, folder: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setBusy(true);
      setError('');
      setListing(null);
      setPreview(null);
      setFilter('');
      setSourceId(source);
      setPath(folder);
      try {
        const current = await api<SourceListing>(
          `/manage/library/folders?source_id=${encodeURIComponent(source)}&path=${encodeURIComponent(folder)}`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setListing(current);
          setPath(current.path);
        }
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : t('importFolderDialog.dirReadFailed'),
          );
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [t],
  );
  useEffect(() => {
    dialog.current?.showModal();
    void load(initial.source_id, initial.path);
    return () => request.current?.abort();
  }, [initial.source_id, initial.path, load]);

  async function inspect() {
    if (!listing) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const value = await api<ImportPreview>('/manage/library/import/preview', {
        method: 'POST',
        body: JSON.stringify({ source_id: sourceId, path: listing.path }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setPreview(value);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : t('importFolderDialog.previewFailed'));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const source = sources.find((item) => item.id === sourceId);
  const parts = listing?.path === '.' ? [] : (listing?.path || '').split('/');
  const visible =
    listing?.items.filter((item) =>
      item.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
    ) || [];
  const folders = listing?.items.filter((item) => item.kind === 'folder').length || 0;
  const audio = listing?.items.filter((item) => item.importable).length || 0;
  return (
    <dialog
      ref={dialog}
      className="import-folder-dialog"
      aria-label={t('importFolderDialog.dialogAria')}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="import-folder-heading">
        <div>
          <span className="eyebrow">IMPORT FOLDER</span>
          <h2>{t('importFolderDialog.title')}</h2>
          <p>{t('importFolderDialog.description')}</p>
        </div>
        <DialogCloseButton aria-label={t('importFolderDialog.closeAria')} onClick={onClose} />
      </header>
      <div className="import-folder-location">
        <label>
          {t('importFolderDialog.sourceLabel')}
          <select value={sourceId} onChange={(event) => void load(event.target.value, '.')}>
            {sources.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void load(sourceId, path.trim() || '.');
          }}
        >
          <label>
            {t('importFolderDialog.pathLabel')}
            <input
              aria-label={t('importFolderDialog.pathLabel')}
              disabled={busy}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={t('importFolderDialog.pathPlaceholder')}
            />
          </label>
          <button type="submit" disabled={busy}>
            {t('importFolderDialog.openPath')}
          </button>
        </form>
      </div>
      <nav className="source-breadcrumbs" aria-label={t('importFolderDialog.navAria')}>
        <button type="button" disabled={busy} onClick={() => void load(sourceId, '.')}>
          {source?.name || t('importFolderDialog.sourceRoot')}
        </button>
        {parts.map((part, index) => (
          <span key={index}>
            <span aria-hidden="true"> / </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void load(sourceId, parts.slice(0, index + 1).join('/'))}
            >
              {part}
            </button>
          </span>
        ))}
      </nav>
      <div className="import-folder-workspace">
        <section
          className="import-folder-files"
          aria-label={t('importFolderDialog.fileListAria')}
          aria-busy={busy}
        >
          <div className="import-folder-tools">
            <button
              type="button"
              disabled={busy || !listing || listing.path === '.'}
              onClick={() => void load(sourceId, parts.slice(0, -1).join('/') || '.')}
            >
              <Icon name="up" />
              {t('importFolderDialog.parentFolder')}
            </button>
            <input
              type="search"
              aria-label={t('importFolderDialog.filterAria')}
              disabled={busy}
              placeholder={t('importFolderDialog.filterPlaceholder')}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <button
              type="button"
              aria-label={t('importFolderDialog.refreshAria')}
              disabled={busy}
              onClick={() => void load(sourceId, listing?.path || path)}
            >
              <Icon name="refresh" />
            </button>
          </div>
          <div className="import-folder-list">
            {busy && !listing ? (
              <p className="muted" role="status">
                {t('importFolderDialog.loadingDirectory')}
              </p>
            ) : (
              visible.map((item) =>
                item.kind === 'folder' ? (
                  <button
                    type="button"
                    className="import-folder-entry"
                    key={item.path}
                    disabled={busy}
                    onClick={() => void load(sourceId, item.path)}
                  >
                    <Icon name="folder" />
                    <strong>{item.name}</strong>
                    <span>{t('importFolderDialog.folderTag')}</span>
                    <Icon name="chevron" />
                  </button>
                ) : (
                  <div className="import-folder-entry" key={item.path}>
                    <Icon name="music" />
                    <span>{item.name}</span>
                    <small className={item.pending ? 'source-pending' : ''}>
                      {item.pending
                        ? t('importFolderDialog.tagPending')
                        : item.importable
                          ? t('importFolderDialog.tagAudio')
                          : t('importFolderDialog.tagAsset')}
                    </small>
                  </div>
                ),
              )
            )}
            {!busy && listing && !visible.length && (
              <p className="muted">
                {filter
                  ? t('importFolderDialog.noMatches')
                  : t('importFolderDialog.directoryEmpty')}
              </p>
            )}
            {!busy && !listing && <p className="muted">{t('importFolderDialog.readFailedHint')}</p>}
          </div>
        </section>
        <aside className="import-folder-summary" aria-label={t('importFolderDialog.summaryAria')}>
          <Icon name="folder" />
          <h3>{t('importFolderDialog.currentFolderTitle')}</h3>
          <strong>
            {listing ? parts.at(-1) || source?.name : t('importFolderDialog.notLoaded')}
          </strong>
          <code>
            {source?.path}
            {listing && listing.path !== '.' ? `/${listing.path}` : ''}
          </code>
          <p>{t('importFolderDialog.scopeHint')}</p>
          {listing && (
            <small>{t('importFolderDialog.currentLevelCount', { folders, audio })}</small>
          )}
          <button type="button" disabled={busy || !listing} onClick={() => void inspect()}>
            {busy && listing
              ? t('importFolderDialog.previewing')
              : t('importFolderDialog.previewButton')}
          </button>
          {preview && (
            <div className="import-folder-result" role="status">
              <strong>{t('importFolderDialog.audioFilesCount', { count: preview.count })}</strong>
              <span>{t('importFolderDialog.previewNote')}</span>
              {preview.pending_markers.length > 0 && (
                <small className="source-pending">
                  {t('importFolderDialog.pendingMarkersCount', {
                    count: preview.pending_markers.length,
                  })}
                </small>
              )}
            </div>
          )}
          <small>{t('importFolderDialog.sourceReadOnlyNotice')}</small>
        </aside>
      </div>
      {error && (
        <p className="error import-folder-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <span>
          {listing
            ? t('importFolderDialog.browsedPath', {
                path: listing.path === '.' ? t('importFolderDialog.sourceRoot') : listing.path,
              })
            : t('importFolderDialog.selectReadableFolder')}
        </span>
        <div>
          <button type="button" onClick={onClose}>
            {t('importFolderDialog.cancel')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !listing}
            onClick={() =>
              listing && onSelect({ source_id: sourceId, path: listing.path }, preview)
            }
          >
            {t('importFolderDialog.selectFolder')}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
