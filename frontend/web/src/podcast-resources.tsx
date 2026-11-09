import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { DialogCloseButton } from './dialog-close';

type Resource = {
  id: string;
  podcast_title: string;
  title: string;
  reference_count: number;
  size_bytes: number;
  protected: boolean;
  active: boolean;
  version: number;
};
type ResourcePage = { items: Resource[]; total: number; total_bytes: number };
type Settings = { version: number; enabled: boolean; retention_days: number };
export type CleanupCandidate = {
  id: string;
  podcast_id: string;
  podcast_title: string;
  title: string;
  size_bytes: number;
  local_path: string;
};
export type Cleanup = {
  candidate_count: number;
  candidate_bytes: number;
  deleted_count: number;
  freed_bytes: number;
  failed_count: number;
  candidates?: CleanupCandidate[];
};
const size = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

export function PodcastCleanupCandidatesDialog({
  preview,
  busy,
  onClose,
  onConfirmCleanup,
}: {
  preview: Cleanup;
  busy: boolean;
  onClose: () => void;
  onConfirmCleanup: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      previous?.focus({ preventScroll: true });
    };
  }, []);

  const candidates = preview.candidates ?? [];

  return (
    <dialog
      ref={dialog}
      className="podcast-cleanup-dialog"
      aria-labelledby="podcast-cleanup-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) {
          const bounds = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < bounds.left ||
            e.clientX > bounds.right ||
            e.clientY < bounds.top ||
            e.clientY > bounds.bottom
          ) {
            onClose();
          }
        }
      }}
    >
      <header className="podcast-cleanup-dialog-header">
        <div className="podcast-cleanup-dialog-title-wrap">
          <h2 id="podcast-cleanup-dialog-title">{t('podcastResources.dialogTitle')}</h2>
          <span className="podcast-cleanup-dialog-badge">
            {t('podcastResources.dialogBadge', {
              count: preview.candidate_count,
              size: size(preview.candidate_bytes),
            })}
          </span>
        </div>
        <DialogCloseButton
          aria-label={t('podcastResources.closeDialog')}
          disabled={busy}
          onClick={onClose}
        />
      </header>

      <div className="podcast-cleanup-dialog-body">
        <p className="podcast-cleanup-dialog-desc">{t('podcastResources.dialogDesc')}</p>

        {candidates.length > 0 ? (
          <div className="podcast-cleanup-candidates-list" role="list">
            {candidates.map((item) => (
              <article key={item.id} className="podcast-cleanup-candidate-item" role="listitem">
                <div className="candidate-info">
                  <strong className="candidate-title">{item.title}</strong>
                  <span className="candidate-podcast">{item.podcast_title}</span>
                  {item.local_path && (
                    <span className="candidate-path" title={item.local_path}>
                      {item.local_path.split('/').pop()}
                    </span>
                  )}
                </div>
                <div className="candidate-meta">
                  <span className="candidate-size">{size(item.size_bytes)}</span>
                  <span className="candidate-pill">{t('podcastResources.zeroReferences')}</span>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="podcast-cleanup-empty-state">
            <p className="empty-title">{t('podcastResources.emptyTitle')}</p>
            <p className="empty-desc">{t('podcastResources.emptyDesc')}</p>
          </div>
        )}
      </div>

      <footer className="podcast-cleanup-dialog-footer">
        <span className="podcast-cleanup-dialog-hint">
          {candidates.length > 0 ? t('podcastResources.irreversibleHint') : ''}
        </span>
        <div className="podcast-cleanup-dialog-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>
            {t('podcastResources.close')}
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={busy || !preview.candidate_count}
            onClick={onConfirmCleanup}
          >
            {busy
              ? t('podcastResources.cleaningUp')
              : t('podcastResources.confirmCleanupCount', { count: preview.candidate_count })}
          </button>
        </div>
      </footer>
    </dialog>
  );
}

export function PodcastResourceManager() {
  const { t } = useTranslation();
  const [page, setPage] = useState<ResourcePage | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [offset, setOffset] = useState(0);
  const [preview, setPreview] = useState<Cleanup | null>(null);
  const [candidateDialogOpen, setCandidateDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function load(start = offset) {
    const [items, policy] = await Promise.all([
      api<ResourcePage>(`/podcasts/resources?offset=${start}&limit=50`),
      api<Settings>('/podcasts/resources/settings'),
    ]);
    setPage(items);
    setSettings(policy);
  }
  useEffect(() => {
    void load(offset).catch((error: Error) => setMessage(error.message));
  }, [offset]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('podcastResources.actionFailed'));
    } finally {
      setBusy(false);
    }
  }
  async function cleanup(dry_run: boolean) {
    const result = await api<Cleanup>('/podcasts/resources/cleanup', {
      method: 'POST',
      body: JSON.stringify({ dry_run }),
    });
    if (dry_run) {
      setPreview(result);
      return result;
    } else {
      setPreview(null);
      setCandidateDialogOpen(false);
      setMessage(
        t('podcastResources.cleanupResult', {
          deleted: result.deleted_count,
          freed: size(result.freed_bytes),
          failedNotice: result.failed_count
            ? t('podcastResources.cleanupFailedNotice', { count: result.failed_count })
            : '',
        }),
      );
      await load();
      return result;
    }
  }

  async function openCandidateDialog() {
    if (!preview) {
      await run(async () => {
        await cleanup(true);
      });
    }
    setCandidateDialogOpen(true);
  }

  return (
    <section aria-labelledby="podcast-resources-title">
      <div className="podcast-resource-manager">
        <div className="podcast-resource-heading">
          <h2 id="podcast-resources-title">{t('podcastResources.heading')}</h2>
        </div>
        <p>{t('podcastResources.summaryIntro')}</p>
        <p className="muted">{t('podcastResources.summaryAutoIntro')}</p>
        {message && <p role="status">{message}</p>}
        {settings && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                setSettings(
                  await api<Settings>('/podcasts/resources/settings', {
                    method: 'PUT',
                    body: JSON.stringify(settings),
                  }),
                );
                setPreview(null);
                setMessage(t('podcastResources.autoCleanupSaved'));
              });
            }}
          >
            <fieldset disabled={busy}>
              <legend>{t('podcastResources.autoCleanupLegend')}</legend>
              <label>
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
                />
                {t('podcastResources.enableAutoCleanup')}
              </label>
              <label>
                {t('podcastResources.retentionDaysLabel')}
                <input
                  type="number"
                  min={0}
                  max={3650}
                  value={settings.retention_days}
                  onChange={(e) =>
                    setSettings({ ...settings, retention_days: Number(e.target.value) })
                  }
                />
              </label>
              <button type="submit">{t('podcastResources.savePolicy')}</button>
            </fieldset>
          </form>
        )}
        <div className="podcast-resource-cleanup">
          <p>
            {page
              ? t('podcastResources.pageSummary', {
                  total: page.total,
                  size: size(page.total_bytes),
                })
              : t('podcastResources.loadingResources')}
          </p>
          <div className="podcast-cleanup-action-row">
            <button type="button" disabled={busy} onClick={() => void run(() => cleanup(true))}>
              {t('podcastResources.previewZeroRefCleanup')}
            </button>
            <button
              type="button"
              className="podcast-cleanup-view-btn"
              disabled={busy}
              onClick={() => void openCandidateDialog()}
            >
              {preview
                ? t('podcastResources.viewCandidateListWithCount', {
                    count: preview.candidate_count,
                  })
                : t('podcastResources.viewCandidateList')}
            </button>
          </div>
          {preview && (
            <div role="status" className="podcast-cleanup-preview-box">
              <p>
                {t('podcastResources.previewSummary', {
                  count: preview.candidate_count,
                  size: size(preview.candidate_bytes),
                })}
              </p>
              <div className="podcast-cleanup-preview-actions">
                <button
                  type="button"
                  disabled={busy || !preview.candidate_count}
                  onClick={() => void run(() => cleanup(false))}
                >
                  {t('podcastResources.confirmCleanupZeroRef')}
                </button>
                <button
                  type="button"
                  className="podcast-cleanup-view-btn"
                  disabled={busy}
                  onClick={() => setCandidateDialogOpen(true)}
                >
                  {t('podcastResources.viewCandidateListWithCount', {
                    count: preview.candidate_count,
                  })}
                </button>
              </div>
            </div>
          )}
        </div>
        {candidateDialogOpen && preview && (
          <PodcastCleanupCandidatesDialog
            preview={preview}
            busy={busy}
            onClose={() => setCandidateDialogOpen(false)}
            onConfirmCleanup={() => void run(() => cleanup(false))}
          />
        )}
        <div className="podcast-resource-list">
          {page?.items.map((item) => (
            <article key={item.id}>
              <div>
                <strong>{item.title}</strong>
                <p>{item.podcast_title}</p>
                <small>
                  {t('podcastResources.resourceMeta', {
                    references: item.reference_count,
                    size: size(item.size_bytes),
                    activeStatus: item.active ? t('podcastResources.inUse') : '',
                  })}
                </small>
              </div>
              <button
                type="button"
                disabled={busy}
                aria-label={t(
                  item.protected
                    ? 'podcastResources.unprotectAria'
                    : 'podcastResources.protectAria',
                  { title: item.title },
                )}
                onClick={() =>
                  void run(async () => {
                    await api(`/podcasts/resources/${encodeURIComponent(item.id)}/protection`, {
                      method: 'PUT',
                      body: JSON.stringify({ version: item.version, protected: !item.protected }),
                    });
                    setPreview(null);
                    await load();
                  })
                }
              >
                {item.protected
                  ? t('podcastResources.unprotect')
                  : t('podcastResources.protectAudio')}
              </button>
            </article>
          ))}
        </div>
        <div className="podcast-resource-pagination">
          <button
            type="button"
            disabled={busy || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            {t('podcastResources.previousPage')}
          </button>
          <button
            type="button"
            disabled={busy || !page || offset + 50 >= page.total}
            onClick={() => setOffset(offset + 50)}
          >
            {t('podcastResources.nextPage')}
          </button>
          <button type="button" disabled={busy} onClick={() => void run(() => load())}>
            {t('podcastResources.reload')}
          </button>
        </div>
      </div>
    </section>
  );
}
