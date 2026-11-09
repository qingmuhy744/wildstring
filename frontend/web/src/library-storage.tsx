import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { FolderPicker } from './folder-picker';
import type { MusicLibrary } from './music-libraries';

type IntakePolicy = {
  version: number;
  enabled: boolean;
  interval_seconds: number;
  stable_seconds: number;
  download_policy: { wait_for_album: boolean; partial_suffixes: string[] };
};
type Migration = {
  id: string;
  status: string;
  target_root: string;
  copied_files: number;
  total_files: number;
  copied_bytes: number;
  total_bytes: number;
  error: string | null;
};
const statusKeys: Record<string, string> = {
  queued: 'libraryStorage.statusQueued',
  running: 'libraryStorage.statusRunning',
  completed: 'libraryStorage.statusCompleted',
  failed: 'libraryStorage.statusFailed',
};

export function LibraryStorage({
  library,
  onChanged,
}: {
  library: MusicLibrary;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [policy, setPolicy] = useState<IntakePolicy | null>(null);
  const [job, setJob] = useState<Migration | null>(null);
  const [target, setTarget] = useState('');
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const endpoint = `/libraries/${encodeURIComponent(library.id)}/migrations`;
  const intake = `/manage/intake/settings?library_id=${encodeURIComponent(library.id)}`;
  useEffect(() => {
    let active = true;
    setPolicy(null);
    setJob(null);
    setTarget('');
    setMessage('');
    void Promise.all([api<IntakePolicy>(intake), api<{ items: Migration[] }>(endpoint)])
      .then(([value, jobs]) => {
        if (active) {
          setPolicy(value);
          setJob(jobs.items[0] || null);
        }
      })
      .catch((error: Error) => {
        if (active) setMessage(error.message);
      });
    return () => {
      active = false;
    };
  }, [intake, endpoint]);
  const moving = job?.status === 'queued' || job?.status === 'running';
  useEffect(() => {
    if (!moving) return;
    let active = true;
    const timer = window.setInterval(() => {
      void api<{ items: Migration[] }>(endpoint)
        .then(async (value) => {
          if (!active) return;
          const latest = value.items[0];
          setJob(latest || null);
          if (latest && !['queued', 'running'].includes(latest.status)) await onChanged();
        })
        .catch((error: Error) => {
          if (active) setMessage(error.message);
        });
    }, 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [moving, endpoint, onChanged]);
  async function configure() {
    setBusy(true);
    setMessage('');
    try {
      setPolicy(
        await api<IntakePolicy>(intake, {
          method: 'PUT',
          body: JSON.stringify(
            policy && {
              ...policy,
              download_policy: {
                ...policy.download_policy,
                partial_suffixes: policy.download_policy.partial_suffixes.filter(Boolean),
              },
            },
          ),
        }),
      );
      setMessage(t('libraryStorage.settingsSaved'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('libraryStorage.settingsSaveFailed'));
    } finally {
      setBusy(false);
    }
  }
  async function migrate(retry = false) {
    setBusy(true);
    setMessage('');
    try {
      setJob(
        await api<Migration>(retry ? `${endpoint}/${job?.id}/retry` : endpoint, {
          method: 'POST',
          ...(retry
            ? {}
            : { body: JSON.stringify({ version: library.version, managed_root: target.trim() }) }),
        }),
      );
      if (!retry) setTarget('');
      await onChanged();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : t('libraryStorage.migrationSubmitFailed'),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="library-storage"
      aria-label={t('libraryStorage.storageSettingsAria', { name: library.name })}
    >
      <h3>{t('libraryStorage.watchTitle')}</h3>
      {policy && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void configure();
          }}
        >
          <fieldset disabled={busy || moving}>
            <legend>{t('libraryStorage.policyLegend')}</legend>
            <label className="music-library-grant-option">
              <input
                type="checkbox"
                checked={policy.enabled}
                onChange={(e) => setPolicy({ ...policy, enabled: e.target.checked })}
              />
              {t('libraryStorage.periodicCheck')}
            </label>
            <label htmlFor={`${id}-interval`}>{t('libraryStorage.checkInterval')}</label>
            <input
              id={`${id}-interval`}
              type="number"
              min={15}
              max={86400}
              value={policy.interval_seconds}
              onChange={(e) => setPolicy({ ...policy, interval_seconds: Number(e.target.value) })}
            />
            <label htmlFor={`${id}-stable`}>{t('libraryStorage.stableWait')}</label>
            <input
              id={`${id}-stable`}
              type="number"
              min={5}
              max={86400}
              value={policy.stable_seconds}
              onChange={(e) => setPolicy({ ...policy, stable_seconds: Number(e.target.value) })}
            />
            <label className="music-library-grant-option">
              <input
                type="checkbox"
                checked={policy.download_policy.wait_for_album}
                onChange={(e) =>
                  setPolicy({
                    ...policy,
                    download_policy: {
                      ...policy.download_policy,
                      wait_for_album: e.target.checked,
                    },
                  })
                }
              />
              {t('libraryStorage.waitForAlbum')}
            </label>
            <label htmlFor={`${id}-partial`}>{t('libraryStorage.partialExtensions')}</label>
            <input
              id={`${id}-partial`}
              value={policy.download_policy.partial_suffixes.join(', ')}
              onChange={(e) =>
                setPolicy({
                  ...policy,
                  download_policy: {
                    ...policy.download_policy,
                    partial_suffixes: e.target.value.split(',').map((value) => value.trim()),
                  },
                })
              }
            />
            <p className="muted">{t('libraryStorage.policyHint')}</p>
            <button type="submit">{t('libraryStorage.savePolicy')}</button>
          </fieldset>
        </form>
      )}
      <h3>{t('libraryStorage.managedDirTitle')}</h3>
      <p className="storage-path">{library.managed_root}</p>
      <p className="muted">{t('libraryStorage.managedDirHint')}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void migrate();
        }}
      >
        <label htmlFor={`${id}-target`}>{t('libraryStorage.newManagedDirLabel')}</label>
        <input
          id={`${id}-target`}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          required
          disabled={busy || moving}
          placeholder={t('libraryStorage.newManagedDirPlaceholder')}
        />
        <button type="button" disabled={busy || moving} onClick={() => setPicking(true)}>
          {t('libraryStorage.browseMigrationTarget')}
        </button>
        <button type="submit" disabled={busy || moving || !target.trim()}>
          {t('libraryStorage.migrateBtn')}
        </button>
      </form>
      {picking && (
        <FolderPicker
          title={t('libraryStorage.selectTargetTitle')}
          onClose={() => setPicking(false)}
          onSelect={(path) => {
            setTarget(path);
            setPicking(false);
          }}
        />
      )}
      {job && (
        <div role="status" className="library-migration-status">
          <strong>{statusKeys[job.status] ? t(statusKeys[job.status]) : job.status}</strong>
          <p className="storage-path">{job.target_root}</p>
          {moving && (
            <>
              <progress max={Math.max(job.total_bytes, 1)} value={job.copied_bytes} />
              <p>
                {t('libraryStorage.copiedFilesCount', {
                  copied: job.copied_files,
                  total: job.total_files,
                })}
              </p>
            </>
          )}
          {job.status === 'failed' && (
            <>
              <p>{t('libraryStorage.retryHint')}</p>
              <button type="button" disabled={busy} onClick={() => void migrate(true)}>
                {t('libraryStorage.retryMigration')}
              </button>
            </>
          )}
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
