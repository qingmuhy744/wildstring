import { HelpLabel } from './desktop-help';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
interface Settings {
  version: number;
  retention_days: number;
  max_size_mb: number;
  max_concurrent: number;
  cache_bytes: number;
  cache_entries: number;
  active_jobs: number;
  ffmpeg_available: boolean;
}
export function TranscodingSettings() {
  const { t } = useTranslation();
  const [record, setRecord] = useState<Settings | null>(null);
  const [days, setDays] = useState('7'),
    [size, setSize] = useState('10240'),
    [jobs, setJobs] = useState('2');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  function populate(result: Settings) {
    setRecord(result);
    setDays(String(result.retention_days));
    setSize(String(result.max_size_mb));
    setJobs(String(result.max_concurrent));
  }
  async function refresh(signal?: AbortSignal) {
    try {
      const result = await api<Settings>('/manage/transcoding', { signal });
      if (!signal?.aborted) populate(result);
    } catch (reason) {
      if (!signal?.aborted) setError((reason as Error).message);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!record) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      populate(
        await api<Settings>('/manage/transcoding', {
          method: 'PUT',
          body: JSON.stringify({
            version: record.version,
            retention_days: Number(days),
            max_size_mb: Number(size),
            max_concurrent: Number(jobs),
          }),
        }),
      );
      setNotice(t('transcodingSettings.saved'));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ deferred: number; cache: Settings }>('/manage/transcoding/cache', {
        method: 'DELETE',
      });
      populate(result.cache);
      setNotice(
        result.deferred
          ? t('transcodingSettings.cacheClearedDeferred')
          : t('transcodingSettings.cacheCleared'),
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="management-card account-form"
      aria-label={t('transcodingSettings.ariaLabel')}
      onSubmit={save}
    >
      <h2>{t('transcodingSettings.title')}</h2>
      <p className="muted">{t('transcodingSettings.description')}</p>
      {record && (
        <p className="muted">
          {t('transcodingSettings.cacheStats', {
            size: (record.cache_bytes / 1048576).toFixed(1),
            entries: record.cache_entries,
            jobs: record.active_jobs,
          })}
        </p>
      )}
      {record && !record.ffmpeg_available && (
        <p className="error" role="alert">
          {t('transcodingSettings.ffmpegUnavailable')}
        </p>
      )}
      <div className="transcoding-fields">
        <label>
          <HelpLabel hint="cacheDays">{t('transcodingSettings.retentionDays')}</HelpLabel>
          <input
            type="number"
            disabled={!record || busy}
            min={1}
            max={365}
            required
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        </label>
        <label>
          <HelpLabel hint="cacheSize">{t('transcodingSettings.cacheLimit')}</HelpLabel>
          <input
            type="number"
            disabled={!record || busy}
            min={16}
            max={1048576}
            required
            value={size}
            onChange={(e) => setSize(e.target.value)}
          />
        </label>
        <label>
          <HelpLabel hint="transcodeJobs">{t('transcodingSettings.maxConcurrent')}</HelpLabel>
          <input
            type="number"
            disabled={!record || busy}
            min={1}
            max={8}
            required
            value={jobs}
            onChange={(e) => setJobs(e.target.value)}
          />
        </label>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="settings-actions">
        <button className="primary" disabled={!record || busy}>
          {t('transcodingSettings.save')}
        </button>
        <button type="button" disabled={!record || busy} onClick={() => void clear()}>
          {t('transcodingSettings.clearCache')}
        </button>
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          {t('transcodingSettings.refresh')}
        </button>
      </div>
    </form>
  );
}
