import { HelpLabel } from './desktop-help';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { artist, type Playlist } from './api';
import {
  allDownloadPlaylists,
  allowMeteredDownloads,
  followedPlaylists,
  followPlaylist,
  setAllowMeteredDownloads,
  syncOfflinePlaylists,
} from './offline-playlists';
import { Cover } from './cover';
import {
  offlineLimit,
  offlineTracks,
  pauseDownload,
  removeDownload,
  resumeDownload,
  setOfflineLimit,
  downloadBitrate,
  setDownloadBitrate,
  type OfflineTrack,
} from './offline';
import type { Player } from './player';
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const labels = {
  queued: 'offlinePanel.state_queued',
  downloading: 'offlinePanel.state_downloading',
  complete: 'offlinePanel.state_complete',
  paused: 'offlinePanel.state_paused',
  failed: 'offlinePanel.state_failed',
} as const;
export function OfflinePanel({
  player,
  onSettings,
  onBrowse,
}: {
  player: Player;
  onSettings: () => void;
  onBrowse: () => void;
}) {
  const { t } = useTranslation();
  const [records, setRecords] = useState<OfflineTrack[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    const reload = () => {
      void offlineTracks()
        .then((r) => {
          if (live) {
            setRecords(r);
            setError('');
            setLoading(false);
          }
        })
        .catch(() => {
          if (live) {
            setError(t('offlinePanel.loadFailed'));
            setLoading(false);
          }
        });
    };
    reload();
    window.addEventListener('wildstring:offline-updated', reload);
    return () => {
      live = false;
      window.removeEventListener('wildstring:offline-updated', reload);
    };
  }, [revision]);
  const ready = records.filter((r) => r.state === 'complete');
  async function action(fn: () => Promise<void>) {
    try {
      setError('');
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('offlinePanel.actionIncomplete'));
    }
  }
  return (
    <section className="completion-page offline-page" aria-label={t('offlinePanel.ariaLabel')}>
      <h1>{t('offlinePanel.title')}</h1>
      {!loading && (!error || records.length > 0) && (
        <p className="muted">
          {t('offlinePanel.storageUsage', {
            count: ready.length,
            used: size(records.reduce((s, r) => s + r.bytes, 0)),
            limit: offlineLimit() / 1024 / 1024,
          })}
        </p>
      )}
      <div className="toolbar-actions offline-page-actions">
        {ready.length > 0 && (
          <button
            className="primary"
            onClick={() =>
              player.start(
                ready.map((r) => r.track),
                0,
              )
            }
          >
            {t('offlinePanel.playOffline')}
          </button>
        )}
        <button onClick={onSettings}>{t('offlinePanel.downloadSettings')}</button>
      </div>
      {(!('serviceWorker' in navigator) || !isSecureContext) && (
        <p className="muted" role="status">
          {t('offlinePanel.serviceWorkerNotice')}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}{' '}
          <button
            className="text-button"
            onClick={() => {
              setLoading(true);
              setRevision((v) => v + 1);
            }}
          >
            {t('offlinePanel.retry')}
          </button>
        </p>
      )}
      {loading && <p role="status">{t('offlinePanel.loading')}</p>}
      {!loading && !error && !records.length && (
        <div className="empty">
          <h2>{t('offlinePanel.emptyTitle')}</h2>
          <p>{t('offlinePanel.emptyHint')}</p>
          <button className="primary" onClick={onBrowse}>
            {t('offlinePanel.browseMusic')}
          </button>
        </div>
      )}
      <div className="offline-list">
        {records.map((record) => (
          <article className="offline-track" key={record.track.id}>
            <Cover trackId={record.track.id} title={record.track.title} />
            <div>
              <button
                className="track-title"
                disabled={record.state !== 'complete'}
                aria-label={t('offlinePanel.playTrackAria', { title: record.track.title })}
                onClick={() =>
                  player.start(
                    ready.map((r) => r.track),
                    ready.findIndex((r) => r.track.id === record.track.id),
                  )
                }
              >
                <strong>{record.track.title}</strong>
                <small>{artist(record.track)}</small>
              </button>
              <p role="status">
                {t(labels[record.state])} · {size(record.bytes)}
                {record.total ? ` / ${size(record.total)}` : ''}
                {' · '}
                {record.bitrate && record.blob.type === 'audio/mp4'
                  ? `AAC ${record.bitrate} kbps`
                  : t('offlinePanel.originalQuality')}
              </p>
              {record.error && <p className="error">{record.error}</p>}
              {record.total > 0 && record.state !== 'complete' && (
                <progress
                  aria-label={t('offlinePanel.trackProgressAria', { title: record.track.title })}
                  max={record.total}
                  value={record.bytes}
                />
              )}
            </div>
            <div className="download-actions">
              {record.state === 'downloading' || record.state === 'queued' ? (
                <button onClick={() => pauseDownload(record.track.id)}>
                  {t('offlinePanel.pause')}
                </button>
              ) : (
                record.state !== 'complete' && (
                  <button onClick={() => void action(() => resumeDownload(record.track.id))}>
                    {record.state === 'failed'
                      ? t('offlinePanel.retryDownload')
                      : t('offlinePanel.resumeDownload')}
                  </button>
                )
              )}
              <button
                aria-label={t('offlinePanel.deleteAria', { title: record.track.title })}
                onClick={() => void action(() => removeDownload(record.track.id))}
              >
                {t('offlinePanel.delete')}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function OfflineSettings({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(offlineLimit() / 1024 / 1024);
  const [bitrate, setBitrate] = useState(downloadBitrate);
  const [metered, setMetered] = useState(allowMeteredDownloads);
  const [selected, setSelected] = useState(() => followedPlaylists(userId));
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);
  async function action(fn: () => Promise<void>) {
    try {
      setError('');
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('offlinePanel.actionIncomplete'));
    }
  }
  return (
    <>
      <section
        className="management-card offline-options"
        aria-label={t('offlinePanel.settingsAriaLabel')}
      >
        <p className="muted">{t('offlinePanel.settingsNotice')}</p>
        <label>
          <HelpLabel hint="offlineLimit">{t('offlinePanel.offlineLimit')}</HelpLabel>
          <input
            aria-label={t('offlinePanel.offlineLimitAria')}
            type="number"
            min="100"
            max="2048"
            value={limit}
            onChange={(e) => {
              const value = Number(e.target.value);
              setLimit(value);
            }}
            onBlur={() => {
              setOfflineLimit(limit);
              setLimit(offlineLimit() / 1024 / 1024);
            }}
          />
        </label>

        <label>
          <HelpLabel hint="offlineQuality">{t('offlinePanel.defaultQuality')}</HelpLabel>
          <select
            aria-label={t('offlinePanel.defaultQualityAria')}
            value={bitrate}
            onChange={(e) => {
              const value = Number(e.target.value);
              setBitrate(value);
              setDownloadBitrate(value);
            }}
          >
            {[0, 128, 192, 256, 320].map((rate) => (
              <option key={rate} value={rate}>
                {rate ? `AAC ${rate} kbps` : t('offlinePanel.originalQuality')}
              </option>
            ))}
          </select>
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={metered}
            onChange={(e) => {
              setMetered(e.target.checked);
              setAllowMeteredDownloads(e.target.checked);
            }}
          />
          {t('offlinePanel.allowMetered')}
        </label>
        <p className="muted">{t('offlinePanel.meteredDescription')}</p>
        <button onClick={() => void action(async () => setPlaylists(await allDownloadPlaylists()))}>
          {t('offlinePanel.selectPlaylists')}
        </button>
        {playlists?.map((playlist) => (
          <label className="check-label" key={playlist.id}>
            <input
              type="checkbox"
              checked={selected.includes(playlist.id)}
              onChange={(e) => {
                followPlaylist(userId, playlist.id, e.target.checked);
                setSelected(followedPlaylists(userId));
              }}
            />
            {playlist.name}
          </label>
        ))}
        <p className="muted">
          {t('offlinePanel.selectedPlaylistsNotice', { count: selected.length })}
        </p>
        <button
          disabled={!selected.length}
          onClick={() => void action(() => syncOfflinePlaylists(userId))}
        >
          {t('offlinePanel.checkPlaylistsNow')}
        </button>
      </section>{' '}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
