import { useEffect, useState } from 'react';
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
  queued: '等待下载',
  downloading: '下载中',
  complete: '已离线保存',
  paused: '已暂停',
  failed: '下载失败',
};
export function OfflinePanel({ player, userId }: { player: Player; userId: string }) {
  const [records, setRecords] = useState<OfflineTrack[]>([]),
    [error, setError] = useState('');
  const [limit, setLimit] = useState(offlineLimit() / 1024 / 1024);
  const [bitrate, setBitrate] = useState(downloadBitrate);
  const [metered, setMetered] = useState(allowMeteredDownloads);
  const [selected, setSelected] = useState(() => followedPlaylists(userId));
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);
  useEffect(() => {
    let live = true;
    const reload = () => {
      void offlineTracks()
        .then((r) => {
          if (live) setRecords(r);
        })
        .catch(() => {
          if (live) setError('无法读取离线存储。');
        });
    };
    reload();
    window.addEventListener('wildstring:offline-updated', reload);
    return () => {
      live = false;
      window.removeEventListener('wildstring:offline-updated', reload);
    };
  }, []);
  const ready = records.filter((r) => r.state === 'complete');
  async function action(fn: () => Promise<void>) {
    try {
      setError('');
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未完成。');
    }
  }
  return (
    <section className="completion-page" aria-label="离线音乐">
      <p className="eyebrow">YOUR MUSIC, OFF THE GRID</p>
      <h1>没网，也有回响。</h1>
      <p className="muted">
        {ready.length} 首完整保存 · 已用 {size(records.reduce((s, r) => s + r.bytes, 0))} / {limit}{' '}
        MB
      </p>
      <p className="muted">
        从歌曲操作、专辑或歌单保存音乐。退出登录会清除本机离线音乐。离线访问有效期 7
        天，浏览器空间不足时可能回收内容。
      </p>
      <div className="toolbar-actions">
        <button
          className="primary"
          disabled={!ready.length}
          onClick={() =>
            player.start(
              ready.map((r) => r.track),
              0,
            )
          }
        >
          播放离线音乐
        </button>
        <label>
          容量上限（MB）
          <input
            aria-label="离线容量上限"
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
      </div>
      <details className="management-card offline-options">
        <summary>下载设置与自动下载歌单</summary>
        <label>
          默认下载音质
          <select
            aria-label="默认下载音质"
            value={bitrate}
            onChange={(e) => {
              const value = Number(e.target.value);
              setBitrate(value);
              setDownloadBitrate(value);
            }}
          >
            {[0, 128, 192, 256, 320].map((rate) => (
              <option key={rate} value={rate}>
                {rate ? `AAC ${rate} kbps` : '原音'}
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
          允许在移动数据或未知网络自动下载
        </label>
        <p className="muted">
          未开启时仅在能识别的
          Wi-Fi／有线网络自动下载。浏览器无法识别网络时可手动保存。音质仅影响新下载，有损音频保持原音。
        </p>
        <button onClick={() => void action(async () => setPlaylists(await allDownloadPlaylists()))}>
          选择自动下载歌单
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
          已选 {selected.length}{' '}
          个歌单。网页打开时自动检查，新歌曲会保存到本机；移出歌单的已下载文件保留。
        </p>
        <button
          disabled={!selected.length}
          onClick={() => void action(() => syncOfflinePlaylists(userId))}
        >
          立即检查歌单
        </button>
      </details>
      {(!('serviceWorker' in navigator) || !isSecureContext) && (
        <p className="muted" role="status">
          断网后重新打开网页需要 HTTPS 或 localhost。当前地址可以下载音频，离线页面壳暂不可用。
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!records.length && (
        <div className="empty">
          <h2>把喜欢的声音带走。</h2>
          <p>在歌曲操作中选择“保存离线”，或保存整个专辑、歌单。</p>
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
                aria-label={`离线播放 ${record.track.title}`}
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
                {labels[record.state]} · {size(record.bytes)}
                {record.total ? ` / ${size(record.total)}` : ''}
                {' · '}
                {record.bitrate && record.blob.type === 'audio/mp4'
                  ? `AAC ${record.bitrate} kbps`
                  : '原音'}
              </p>
              {record.error && <p className="error">{record.error}</p>}
              {record.total > 0 && (
                <progress
                  aria-label={`${record.track.title} 下载进度`}
                  max={record.total}
                  value={record.bytes}
                />
              )}
            </div>
            <div className="download-actions">
              {record.state === 'downloading' || record.state === 'queued' ? (
                <button onClick={() => pauseDownload(record.track.id)}>暂停</button>
              ) : (
                record.state !== 'complete' && (
                  <button onClick={() => void action(() => resumeDownload(record.track.id))}>
                    {record.state === 'failed' ? '重试' : '继续下载'}
                  </button>
                )
              )}
              <button
                aria-label={`删除离线 ${record.track.title}`}
                onClick={() => void action(() => removeDownload(record.track.id))}
              >
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
