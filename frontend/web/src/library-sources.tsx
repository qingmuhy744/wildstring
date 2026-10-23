import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { MusicUploader } from './music-uploader';

type SourceItem = {
  name: string;
  path: string;
  kind: 'folder' | 'file';
  importable?: boolean;
  pending?: boolean;
};
type SourceListing = { source_id: string; path: string; items: SourceItem[] };
type Preview = {
  path: string;
  files: string[];
  count: number;
  pending_markers: string[];
};
type TrashEntry = {
  id: string;
  album_id: string;
  created_at: string;
  created_by: string;
  status: 'trashed' | 'restored' | 'purged';
  tracks: number;
};

function displayPath(path: string) {
  return path === '.' ? '导入目录' : `导入目录 / ${path}`;
}

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
  const [path, setPath] = useState('.');
  const [listing, setListing] = useState<SourceListing | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load(folder = path) {
    const [current, removed] = await Promise.all([
      api<SourceListing>(
        `/manage/library/folders?source_id=import&path=${encodeURIComponent(folder)}`,
      ),
      api<{ items: TrashEntry[] }>('/manage/library/trash'),
    ]);
    setListing(current);
    setTrash(removed.items);
  }
  useEffect(() => {
    void load('.').catch((reason) =>
      setError(reason instanceof Error ? reason.message : '来源目录暂时无法读取。'),
    );
  }, []);

  const breadcrumbs = useMemo(() => {
    if (path === '.') return [{ label: '导入目录', value: '.' }];
    const parts = path.split('/');
    return [
      { label: '导入目录', value: '.' },
      ...parts.map((part, index) => ({ label: part, value: parts.slice(0, index + 1).join('/') })),
    ];
  }, [path]);

  async function openFolder(next: string) {
    setError('');
    try {
      await load(next);
      setPath(next);
      setPreview(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '目录暂时无法读取。');
    }
  }

  async function inspect() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setPreview(
        await api<Preview>('/manage/library/import/preview', {
          method: 'POST',
          body: JSON.stringify({ source_id: 'import', path }),
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '预览未完成。');
    } finally {
      setBusy(false);
    }
  }

  async function importFolder() {
    if (!canImport) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/manage/library/import', {
        method: 'POST',
        body: JSON.stringify({ source_id: 'import', path }),
      });
      setNotice('已提交导入任务，可在任务记录查看进度。');
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导入任务未提交。');
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
      setNotice('回收项已恢复到原位置。');
      await load();
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '恢复未完成。');
    } finally {
      setBusy(false);
    }
  }

  async function purge(id: string) {
    if (!canPurge || !confirm('永久清理后无法恢复，确认继续吗？')) return;
    setBusy(true);
    setError('');
    try {
      await api(`/manage/library/trash/${id}`, { method: 'DELETE' });
      setNotice('回收项已永久清理。');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '永久清理未完成。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <MusicUploader canImport={canImport} onUploaded={onChanged} />
      <section className="management-card" aria-label="导入来源工作台">
        <span className="eyebrow">SOURCE WORKSPACE</span>
        <h2>来源浏览与导入</h2>
        <p className="muted">
          导入源始终只读。先浏览和预览，再提交导入；带有 .part 等标记的文件会等待下载完成。
        </p>
        <nav className="source-breadcrumbs" aria-label="来源路径">
          {breadcrumbs.map((crumb, index) => (
            <span key={crumb.value}>
              {index > 0 && <span aria-hidden="true"> / </span>}
              <button type="button" onClick={() => void openFolder(crumb.value)}>
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
        {listing && (
          <div className="source-browser" aria-live="polite">
            {listing.items.length === 0 ? (
              <p className="muted">这个目录是空的。</p>
            ) : (
              listing.items.map((item) => (
                <div className="source-row" key={item.path}>
                  <div>
                    <strong>
                      {item.kind === 'folder' ? '▰ ' : '♫ '}
                      {item.name}
                    </strong>
                    {item.pending && <small className="source-pending">等待下载完成</small>}
                    {item.kind === 'file' && !item.pending && (
                      <small>{item.importable ? '可导入音频' : '附属文件或暂不支持'}</small>
                    )}
                  </div>
                  {item.kind === 'folder' && (
                    <button type="button" onClick={() => void openFolder(item.path)}>
                      打开
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}
        <div className="source-actions">
          <button type="button" disabled={busy} onClick={() => void inspect()}>
            预览当前目录
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !canImport}
            onClick={() => void importFolder()}
          >
            提交导入任务
          </button>
        </div>
        {preview && (
          <div className="source-preview">
            <strong>{displayPath(preview.path)}</strong>
            <span>{preview.count} 个可导入文件</span>
            {preview.pending_markers.length > 0 && (
              <span className="source-pending">
                {preview.pending_markers.length} 个文件仍在等待下载
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
      <section className="management-card" aria-label="曲库回收区">
        <span className="eyebrow">LIBRARY TRASH</span>
        <h2>回收区</h2>
        <p className="muted">删除的托管副本会先保留在这里。导入源不会被移动或删除。</p>
        {trash.filter((item) => item.status === 'trashed').length === 0 ? (
          <p className="muted">回收区为空。</p>
        ) : (
          <div className="trash-list">
            {trash
              .filter((item) => item.status === 'trashed')
              .map((item) => (
                <div className="trash-row" key={item.id}>
                  <div>
                    <strong>专辑 {item.album_id}</strong>
                    <small>
                      {item.tracks} 首 · {new Date(item.created_at).toLocaleString()} ·{' '}
                      {item.created_by}
                    </small>
                  </div>
                  <div className="source-actions">
                    <button
                      type="button"
                      disabled={busy || !canDelete}
                      onClick={() => void restore(item.id)}
                    >
                      恢复
                    </button>
                    {canPurge && (
                      <button type="button" disabled={busy} onClick={() => void purge(item.id)}>
                        永久清理
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
