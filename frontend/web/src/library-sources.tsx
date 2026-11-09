import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { MusicUploader } from './music-uploader';

import { Icon } from './icons';
import {
  ImportFolderDialog,
  type ImportPreview,
  type ImportSelection,
  type ImportSource,
} from './import-folder-dialog';

type TrashEntry = {
  id: string;
  album_id: string;
  created_at: string;
  created_by: string;
  status: 'trashed' | 'restored' | 'purged';
  tracks: number;
};

export function LibrarySources({
  canImport,
  canDelete,
  canPurge,
  onChanged,
}: {
  canImport: boolean;
  canDelete: boolean;
  canPurge: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const displayPath = (path: string) =>
    path === '.' ? t('librarySources.importDirRoot') : t('librarySources.importDirSub', { path });
  const [sources, setSources] = useState<ImportSource[]>([]);
  const [selection, setSelection] = useState<ImportSelection | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [notice, setNotice] = useState('');

  async function loadTrash() {
    const removed = await api<{ items: TrashEntry[] }>('/manage/library/trash');
    setTrash(removed.items);
  }
  async function loadSources(signal?: AbortSignal) {
    setSourceError('');
    try {
      const value = await api<{ items: ImportSource[] }>('/manage/library/sources', { signal });
      if (signal?.aborted) return;
      setSources(value.items);
      setSelection(value.items[0] ? { source_id: value.items[0].id, path: '.' } : null);
    } catch (reason) {
      if (!signal?.aborted)
        setSourceError(
          reason instanceof Error ? reason.message : t('librarySources.sourceReadFailed'),
        );
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void loadSources(controller.signal);
    void api<{ items: TrashEntry[] }>('/manage/library/trash', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setTrash(value.items);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : t('librarySources.trashReadFailed'));
      });
    return () => controller.abort();
  }, []);
  const source = sources.find((item) => item.id === selection?.source_id);

  async function importFolder() {
    if (!canImport || !selection) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/manage/library/import', {
        method: 'POST',
        body: JSON.stringify(selection),
      });
      setNotice(t('librarySources.importTaskSubmitted'));
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('librarySources.importTaskFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function restore(id: string) {
    if (!canDelete) return;
    setBusy(true);
    setError('');
    try {
      await api(`/manage/library/trash/${id}/restore`, { method: 'POST' });
      setNotice(t('librarySources.restoredNotice'));
      await loadTrash();
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('librarySources.restoreFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function purge(id: string) {
    if (!canPurge || !confirm(t('librarySources.confirmPurge'))) return;
    setBusy(true);
    setError('');
    try {
      await api(`/manage/library/trash/${id}`, { method: 'DELETE' });
      setNotice(t('librarySources.purgedNotice'));
      await loadTrash();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('librarySources.purgeFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <MusicUploader canImport={canImport} onUploaded={onChanged} />
      <section className="management-card" aria-label={t('librarySources.workbenchAria')}>
        <span className="eyebrow">{t('librarySources.sourceEyebrow')}</span>
        <h2>{t('librarySources.title')}</h2>
        <p className="muted">{t('librarySources.description')}</p>
        <div className="source-folder-selection">
          <Icon name="folder" />
          <div>
            <strong>
              {selection
                ? selection.path === '.'
                  ? source?.name || t('librarySources.sourceRoot')
                  : selection.path.split('/').at(-1)
                : t('librarySources.noSourceSelected')}
            </strong>
            <small>
              {source?.path}
              {selection && selection.path !== '.' ? `/${selection.path}` : ''}
            </small>
          </div>
          <button type="button" disabled={busy || !selection} onClick={() => setPickerOpen(true)}>
            {t('librarySources.browseFolders')}
          </button>
        </div>
        {sourceError && (
          <p className="error" role="alert">
            {sourceError}{' '}
            <button type="button" onClick={() => void loadSources()}>
              {t('librarySources.reloadSources')}
            </button>
          </p>
        )}
        <p className="muted">{t('librarySources.readOnlyNotice')}</p>
        <div className="source-actions">
          <button
            type="button"
            className="primary"
            disabled={busy || !canImport || !selection}
            onClick={() => void importFolder()}
          >
            {busy ? t('librarySources.submitting') : t('librarySources.importSelectedFolder')}
          </button>
          <small className="muted">
            {selection ? displayPath(selection.path) : t('librarySources.pleaseSelectFolder')}
          </small>
        </div>
        {pickerOpen && selection && (
          <ImportFolderDialog
            sources={sources}
            initial={selection}
            onClose={() => setPickerOpen(false)}
            onSelect={(next, result) => {
              setSelection(next);
              setPreview(result);
              setNotice('');
              setPickerOpen(false);
            }}
          />
        )}
        {preview && (
          <div className="source-preview">
            <strong>{displayPath(preview.path)}</strong>
            <span>{t('librarySources.audioFilesWithSubdirs', { count: preview.count })}</span>
            {preview.pending_markers.length > 0 && (
              <span className="source-pending">
                {t('librarySources.pendingFilesCount', { count: preview.pending_markers.length })}
              </span>
            )}
            {preview.files.length > 0 && (
              <small>
                {preview.files.slice(0, 8).join('、')}
                {preview.files.length > 8 ? '…' : ''}
              </small>
            )}
          </div>
        )}
      </section>
      <section className="management-card" aria-label={t('librarySources.recycleBinAria')}>
        <span className="eyebrow">{t('librarySources.trashEyebrow')}</span>
        <h2>{t('librarySources.recycleBinTitle')}</h2>
        <p className="muted">{t('librarySources.recycleBinHint')}</p>
        {trash.filter((item) => item.status === 'trashed').length === 0 ? (
          <p className="muted">{t('librarySources.recycleBinEmpty')}</p>
        ) : (
          <div className="trash-list">
            {trash
              .filter((item) => item.status === 'trashed')
              .map((item) => (
                <div className="trash-row" key={item.id}>
                  <div>
                    <strong>{t('librarySources.albumItem', { albumId: item.album_id })}</strong>
                    <small>
                      {t('librarySources.tracksCount', { count: item.tracks })} ·{' '}
                      {new Date(item.created_at).toLocaleString()} · {item.created_by}
                    </small>
                  </div>
                  <div className="source-actions">
                    <button
                      type="button"
                      disabled={busy || !canDelete}
                      onClick={() => void restore(item.id)}
                    >
                      {t('librarySources.restoreBtn')}
                    </button>
                    {canPurge && (
                      <button type="button" disabled={busy} onClick={() => void purge(item.id)}>
                        {t('librarySources.purgeBtn')}
                      </button>
                    )}
                  </div>
                </div>
              ))}
          </div>
        )}
      </section>
      {(error || notice) && (
        <p className={error ? 'error' : 'ai-status'} role={error ? 'alert' : 'status'}>
          {error || notice}
        </p>
      )}
    </>
  );
}
