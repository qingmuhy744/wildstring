import { useEffect, useState } from 'react';
import { api } from './api';

type FolderSummary = {
  folder: string;
  track_count: number;
  album_variants: string[];
  album_artist_variants: string[];
  warning: boolean;
};
type FolderTrack = {
  track_id: string;
  title: string;
  metadata_version: number;
  album: string | null;
  album_artists: string[];
  track_number: number | null;
  disc_number: number | null;
};
type FolderDetail = FolderSummary & { tracks: FolderTrack[] };

export function FolderMetadataEditor({ onChanged }: { onChanged: () => void }) {
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [selected, setSelected] = useState<FolderDetail | null>(null);
  const [album, setAlbum] = useState('');
  const [artists, setArtists] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    api<{ items: FolderSummary[] }>('/manage/metadata/folders?limit=200', {
      signal: controller.signal,
    })
      .then((result) => setFolders(result.items))
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : '无法读取文件夹分组。');
      });
    return () => controller.abort();
  }, []);

  async function open(folder: string) {
    setBusy(true);
    setError('');
    try {
      const detail = await api<FolderDetail>(
        `/manage/metadata/folders?folder=${encodeURIComponent(folder)}`,
      );
      setSelected(detail);
      setAlbum(detail.album_variants[0] || '');
      setArtists(detail.album_artist_variants.join(' / '));
      setMessage('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取文件夹歌曲。');
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!selected || (!album.trim() && !artists.trim())) return;
    setBusy(true);
    setError('');
    setMessage('');
    const overrides: Record<string, unknown> = {};
    if (album.trim()) overrides.album = album.trim();
    if (artists.trim())
      overrides.album_artists = artists
        .split(/[/,，、]/)
        .map((item) => item.trim())
        .filter(Boolean);
    try {
      const result = await api<{ updated: number }>('/manage/metadata/folders', {
        method: 'PUT',
        body: JSON.stringify({
          folder: selected.folder,
          tracks: selected.tracks.map((track) => ({
            track_id: track.track_id,
            version: track.metadata_version,
          })),
          overrides,
        }),
      });
      setMessage(`已更新 ${result.updated} 首，历史版本已保留。`);
      await open(selected.folder);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '批量更新未完成，请重新读取后重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="management-card" aria-label="按文件夹批量整理">
      <div className="management-section-heading">
        <div>
          <h2>按文件夹批量整理</h2>
          <p className="muted">
            同一文件夹通常对应同一发行版。先查看差异，再一次修改整组歌曲；每首歌的元数据历史仍可恢复。
          </p>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="muted" role="status">
          {message}
        </p>
      )}
      {!folders.length ? (
        <p className="muted">暂时没有可批量整理的文件夹。</p>
      ) : (
        <div className="management-task-actions">
          <div>
            <h3>文件夹分组</h3>
            <ul className="manage-track-list">
              {folders.map((item) => (
                <li key={item.folder}>
                  <div>
                    <strong>{item.folder}</strong>
                    <span>
                      {item.track_count} 首 · {item.album_variants.join(' / ') || '未命名专辑'}
                    </span>
                    {item.warning && (
                      <small className="metadata-task-warning">发现多个专辑版本，建议先核对</small>
                    )}
                  </div>
                  <button disabled={busy} onClick={() => void open(item.folder)}>
                    查看并编辑
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {selected && (
            <div>
              <h3>{selected.folder}</h3>
              <p className="muted">
                将应用到 {selected.tracks.length} 首：
                {selected.tracks.map((track) => track.title).join('、')}
              </p>
              {selected.warning && (
                <p className="error">
                  这个文件夹包含多个现有专辑或专辑艺人值，确认后会统一为下面的值。
                </p>
              )}
              <label className="metadata-field">
                <span>专辑</span>
                <input
                  value={album}
                  onChange={(event) => setAlbum(event.target.value)}
                  maxLength={1000}
                />
              </label>
              <label className="metadata-field">
                <span>专辑艺人（用 / 分隔）</span>
                <input
                  value={artists}
                  onChange={(event) => setArtists(event.target.value)}
                  maxLength={1000}
                />
              </label>
              <button
                className="primary"
                disabled={busy || (!album.trim() && !artists.trim())}
                onClick={() => void apply()}
              >
                {busy ? '正在更新…' : '应用到整组歌曲'}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
