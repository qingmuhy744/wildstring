import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from './api';
import { DialogCloseButton } from './dialog-close';
import type { PodcastSummary } from './podcasts';

export interface PodcastDownloadSettings {
  version: number;
  download_policy: 'none' | 'latest_3' | 'latest_5' | 'latest_10' | 'unplayed' | 'all';
  retention_policy: 'keep' | 'delete_after_played';
  active: boolean;
}
const POLICY_CHOICES: PodcastDownloadSettings['download_policy'][] = [
  'none',
  'latest_3',
  'latest_5',
  'latest_10',
  'unplayed',
  'all',
];
const POLICY_LABEL_KEYS: Record<PodcastDownloadSettings['download_policy'], string> = {
  none: 'policyNone',
  latest_3: 'policyLatest3',
  latest_5: 'policyLatest5',
  latest_10: 'policyLatest10',
  unplayed: 'policyUnplayed',
  all: 'policyAll',
};
export function PodcastDownloadDialog({
  podcast,
  onClose,
  onSaved,
}: {
  podcast: PodcastSummary;
  onClose: () => void;
  onSaved: (value: PodcastDownloadSettings) => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState<PodcastDownloadSettings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setValue(null);
    setError('');
    void api<PodcastDownloadSettings>(
      `/podcasts/${encodeURIComponent(podcast.id)}/download-settings`,
      {
        signal: controller.signal,
      },
    )
      .then(setValue)
      .catch((err: unknown) => {
        if (!controller.signal.aborted)
          setError(err instanceof Error ? err.message : t('podcastDownloadSettings.loadFailed'));
      });
    return () => controller.abort();
  }, [podcast.id, reload]);
  async function save() {
    if (!value) return;
    setBusy(true);
    setError('');
    try {
      const updated = await api<PodcastDownloadSettings>(
        `/podcasts/${encodeURIComponent(podcast.id)}/download-settings`,
        {
          method: 'PUT',
          body: JSON.stringify({
            version: value.version,
            download_policy: value.download_policy,
            retention_policy: value.retention_policy,
          }),
        },
      );
      onSaved(updated);
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? t('podcastDownloadSettings.conflictNotice')
          : err instanceof Error
            ? err.message
            : t('podcastDownloadSettings.saveFailed'),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="podcasts-modal podcast-storage-modal"
      aria-labelledby="personal-download-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <header className="podcasts-modal-header">
        <div>
          <p className="storage-podcast-name">{podcast.title}</p>
          <h3 id="personal-download-title">{t('podcastDownloadSettings.dialogTitle')}</h3>
        </div>
        <DialogCloseButton
          className="modal-close-btn"
          aria-label={t('podcastDownloadSettings.closeDialog')}
          disabled={busy}
          onClick={onClose}
        />
      </header>
      <form
        className="podcast-storage-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="podcast-storage-body">
          <p className="podcast-settings-desc">{t('podcastDownloadSettings.settingsDesc')}</p>
          {!value && !error && <p role="status">{t('podcastDownloadSettings.loading')}</p>}
          {value && (
            <>
              {!value.active && (
                <p role="status">{t('podcastDownloadSettings.unfollowedNotice')}</p>
              )}
              <fieldset className="storage-policy-group" disabled={busy || !value.active}>
                <legend>{t('podcastDownloadSettings.downloadScopeLegend')}</legend>
                <div className="storage-policy-options">
                  {POLICY_CHOICES.map((key) => (
                    <label className="storage-choice" key={key}>
                      <input
                        type="radio"
                        name="personal-download-policy"
                        value={key}
                        checked={value.download_policy === key}
                        onChange={() => setValue({ ...value, download_policy: key })}
                      />
                      <span>{t(`podcastDownloadSettings.${POLICY_LABEL_KEYS[key]}`)}</span>
                    </label>
                  ))}
                </div>
                <p className="podcast-settings-desc">
                  {t('podcastDownloadSettings.downloadScopeHelp')}
                </p>
              </fieldset>
              <fieldset className="storage-policy-group" disabled={busy || !value.active}>
                <legend>{t('podcastDownloadSettings.retentionLegend')}</legend>
                <div className="storage-policy-options">
                  {(
                    [
                      ['keep', t('podcastDownloadSettings.retentionKeep')],
                      ['delete_after_played', t('podcastDownloadSettings.retentionDelete')],
                    ] as const
                  ).map(([key, label]) => (
                    <label className="storage-choice" key={key}>
                      <input
                        type="radio"
                        name="personal-download-retention"
                        checked={value.retention_policy === key}
                        onChange={() => setValue({ ...value, retention_policy: key })}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
                <p className="podcast-settings-desc">
                  {t('podcastDownloadSettings.retentionHelp')}
                </p>
              </fieldset>
            </>
          )}
          {error && (
            <p className="podcast-settings-error" role="alert">
              {error}
            </p>
          )}
          {error && (
            <button
              type="button"
              className="modal-cancel-btn"
              disabled={busy}
              onClick={() => setReload((n) => n + 1)}
            >
              {t('podcastDownloadSettings.reloadSettings')}
            </button>
          )}
        </div>
        <footer className="storage-settings-footer">
          <button type="button" className="modal-cancel-btn" disabled={busy} onClick={onClose}>
            {t('podcastDownloadSettings.cancel')}
          </button>
          <button
            type="submit"
            className="modal-submit-btn primary"
            disabled={!value || busy || !value.active}
          >
            {busy ? t('podcastDownloadSettings.saving') : t('podcastDownloadSettings.saveButton')}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
