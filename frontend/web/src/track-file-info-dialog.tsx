import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, artist, type Track } from './api';
import { DialogCloseButton } from './dialog-close';

interface TrackFileInfo {
  track_id: string;
  format: string;
  size_bytes: number;
  path: string;
  source_path?: string | null;
  source_filename?: string;
  absolute_path: string;
  suggested_path: string;
  in_sync: boolean;
  file_exists: boolean;
}

interface ReorganizeResult {
  status: string;
  changed: boolean;
  old_path?: string;
  new_path?: string;
  moved_sidecars?: string[];
  reason?: string;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function TrackFileInfoDialog({
  track,
  canManage = false,
  onClose,
  onReorganized,
}: {
  track: Track;
  canManage?: boolean;
  onClose: () => void;
  onReorganized?: () => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<TrackFileInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reorganizing, setReorganizing] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [actionStatus, setActionStatus] = useState<'success' | 'error' | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await api<TrackFileInfo>(`/tracks/${encodeURIComponent(track.id)}/file-info`);
      setInfo(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('trackFileInfoDialog.fetchError'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const node = dialogRef.current;
    node?.showModal();
    void load();
    return () => {
      node?.close();
    };
  }, [track.id]);

  async function copyText(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // ignore clipboard error
    }
  }

  async function handleReorganize() {
    setReorganizing(true);
    setActionMessage('');
    setActionStatus(null);
    try {
      const res = await api<ReorganizeResult>(
        `/manage/tracks/${encodeURIComponent(track.id)}/reorganize-file`,
        { method: 'POST' },
      );
      await load();
      if (res.changed) {
        const sidecars = res.moved_sidecars?.length
          ? t('trackFileInfoDialog.reorganizeSidecars', { count: res.moved_sidecars.length })
          : '';
        setActionMessage(t('trackFileInfoDialog.reorganizeSuccess', { sidecars }));
        setActionStatus('success');
      } else {
        setActionMessage(t('trackFileInfoDialog.reorganizeNoop'));
        setActionStatus('success');
      }
      onReorganized?.();
    } catch (err) {
      setActionMessage(
        err instanceof Error ? err.message : t('trackFileInfoDialog.reorganizeError'),
      );
      setActionStatus('error');
    } finally {
      setReorganizing(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="track-file-info-dialog modal-dialog"
      onClose={onClose}
      aria-labelledby="file-info-title"
    >
      <div className="file-info-content">
        <header className="file-info-header">
          <div className="file-info-title-group">
            <h3 id="file-info-title">{t('trackFileInfoDialog.title')}</h3>
            <p className="file-info-track-name ellipsis">
              {track.title} · {artist(track)}
            </p>
          </div>
          <DialogCloseButton aria-label={t('trackFileInfoDialog.close')} onClick={onClose} />
        </header>

        {loading ? (
          <div className="file-info-loading" role="status">
            {t('trackFileInfoDialog.loading')}
          </div>
        ) : error ? (
          <div className="file-info-error" role="alert">
            <p>{error}</p>
            <button type="button" className="text-button" onClick={load}>
              {t('trackFileInfoDialog.retry')}
            </button>
          </div>
        ) : info ? (
          <div className="file-info-body">
            <div className="file-info-meta-grid">
              <div className="meta-item">
                <span className="meta-label">{t('trackFileInfoDialog.audioFormat')}</span>
                <span className="meta-value format-badge">{info.format.toUpperCase()}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">{t('trackFileInfoDialog.fileSize')}</span>
                <span className="meta-value">{formatBytes(info.size_bytes)}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">{t('trackFileInfoDialog.fileStatus')}</span>
                <span className={`meta-value ${info.file_exists ? 'status-ok' : 'status-missing'}`}>
                  {info.file_exists
                    ? t('trackFileInfoDialog.statusExists')
                    : t('trackFileInfoDialog.statusMissing')}
                </span>
              </div>
              <div className="meta-item">
                <span className="meta-label">{t('trackFileInfoDialog.pathSync')}</span>
                <span
                  className={`meta-value sync-tag ${info.in_sync ? 'tag-synced' : 'tag-desynced'}`}
                >
                  {info.in_sync
                    ? t('trackFileInfoDialog.synced')
                    : t('trackFileInfoDialog.desynced')}
                </span>
              </div>
            </div>

            {info.source_filename && (
              <div className="file-info-section">
                <div className="section-label-row">
                  <span className="section-title">{t('trackFileInfoDialog.sourceFilename')}</span>
                  <button
                    type="button"
                    className="text-copy-button"
                    onClick={() => copyText(info.source_filename!, 'source')}
                  >
                    {copiedKey === 'source'
                      ? t('trackFileInfoDialog.copied')
                      : t('trackFileInfoDialog.copy')}
                  </button>
                </div>
                <div className="path-display-box">
                  <code>{info.source_filename}</code>
                </div>
              </div>
            )}

            <div className="file-info-section">
              <div className="section-label-row">
                <span className="section-title">
                  {t('trackFileInfoDialog.relativeLibraryPath')}
                </span>
                <button
                  type="button"
                  className="text-copy-button"
                  onClick={() => copyText(info.path, 'rel')}
                >
                  {copiedKey === 'rel'
                    ? t('trackFileInfoDialog.copied')
                    : t('trackFileInfoDialog.copy')}
                </button>
              </div>
              <div className="path-display-box">
                <code>{info.path}</code>
              </div>
            </div>

            <div className="file-info-section">
              <div className="section-label-row">
                <span className="section-title">{t('trackFileInfoDialog.serverAbsolutePath')}</span>
                <button
                  type="button"
                  className="text-copy-button"
                  onClick={() => copyText(info.absolute_path, 'abs')}
                >
                  {copiedKey === 'abs'
                    ? t('trackFileInfoDialog.copied')
                    : t('trackFileInfoDialog.copy')}
                </button>
              </div>
              <div className="path-display-box">
                <code>{info.absolute_path}</code>
              </div>
            </div>

            {!info.in_sync && (
              <div className="file-info-desync-box">
                <div className="desync-header">
                  <span className="desync-icon">⚠</span>
                  <strong>{t('trackFileInfoDialog.desyncTitle')}</strong>
                </div>
                <p className="desync-hint">{t('trackFileInfoDialog.desyncHint')}</p>
                <div className="section-label-row">
                  <span className="section-title">
                    {t('trackFileInfoDialog.canonicalTargetPath')}
                  </span>
                  <button
                    type="button"
                    className="text-copy-button"
                    onClick={() => copyText(info.suggested_path, 'suggested')}
                  >
                    {copiedKey === 'suggested'
                      ? t('trackFileInfoDialog.copied')
                      : t('trackFileInfoDialog.copy')}
                  </button>
                </div>
                <div className="path-display-box suggested">
                  <code>{info.suggested_path}</code>
                </div>

                {canManage ? (
                  <div className="reorganize-action-row">
                    <button
                      type="button"
                      className="primary reorganize-btn"
                      disabled={reorganizing}
                      onClick={handleReorganize}
                    >
                      {reorganizing
                        ? t('trackFileInfoDialog.reorganizing')
                        : t('trackFileInfoDialog.reorganizeButton')}
                    </button>
                  </div>
                ) : (
                  <p className="desync-note">{t('trackFileInfoDialog.adminOnlyNotice')}</p>
                )}
              </div>
            )}

            {actionMessage && (
              <p
                className={`action-message ${actionStatus === 'error' ? 'error' : 'success'}`}
                role="status"
              >
                {actionMessage}
              </p>
            )}
          </div>
        ) : null}

        <footer className="file-info-footer">
          <button type="button" onClick={onClose}>
            {t('trackFileInfoDialog.close')}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
