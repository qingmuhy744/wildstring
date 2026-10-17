import { useEffect, useState } from 'react';
import { artist } from './api';
import { Cover } from './cover';
import {
  offlineLimit,
  offlineTracks,
  pauseDownload,
  removeDownload,
  resumeDownload,
  setOfflineLimit,
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
export function OfflinePanel({ player }: { player: Player }) {
  const [records, setRecords] = useState<OfflineTrack[]>([]),
    [error, setError] = useState('');
  const [limit, setLimit] = useState(offlineLimit() / 1024 / 1024);
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
        从歌曲操作、专辑或歌单保存完整原音。退出登录会清除本机离线音乐。离线访问有效期 7
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
