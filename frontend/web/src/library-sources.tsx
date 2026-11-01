import { useEffect, useState } from 'react';
import { api } from './api';
import { MusicUploader } from './music-uploader';

import { Icon } from './icons';
import {
  ImportFolderDialog,
  type ImportPreview,
  type ImportSelection,
  type ImportSource,
} from './import-folder-dialog';

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
  const [sources, setSources] = useState<ImportSource[]>([]);
  const [selection, setSelection] = useState<ImportSelection | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [notice, setNotice] = useState('');

  async function loadTrash() {
    const removed = await api<{ items: TrashEntry[] }>('/manage/library/trash');
    setTrash(removed.items);
  }
  async function loadSources(signal?: AbortSignal) {
    setSourceError('');
    try {
      const value = await api<{ items: ImportSource[] }>('/manage/library/sources', { signal });
      if (signal?.aborted) return;
      setSources(value.items);
      setSelection(value.items[0] ? { source_id: value.items[0].id, path: '.' } : null);
    } catch (reason) {
      if (!signal?.aborted)
        setSourceError(reason instanceof Error ? reason.message : '来源暂时无法读取。');
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void loadSources(controller.signal);
    void api<{ items: TrashEntry[] }>('/manage/library/trash', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setTrash(value.items);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : '回收区暂时无法读取。');
      });
    return () => controller.abort();
  }, []);
  const source = sources.find((item) => item.id === selection?.source_id);

  async function importFolder() {
    if (!canImport || !selection) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/manage/library/import', {
        method: 'POST',
        body: JSON.stringify(selection),
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
      await loadTrash();
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
      await loadTrash();
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
          选择本次导入的文件夹，包含其下所有子目录。已入库且未变化的音频会跳过复制。
        </p>
        <div className="source-folder-selection">
          <Icon name="folder" />
          <div>
            <strong>
              {selection
                ? selection.path === '.'
                  ? source?.name || '来源根目录'
                  : selection.path.split('/').at(-1)
                : '尚未选择来源'}
            </strong>
            <small>
              {source?.path}
              {selection && selection.path !== '.' ? `/${selection.path}` : ''}
            </small>
          </div>
          <button type="button" disabled={busy || !selection} onClick={() => setPickerOpen(true)}>
            浏览文件夹
          </button>
        </div>
        {sourceError && (
          <p className="error" role="alert">
            {sourceError}{' '}
            <button type="button" onClick={() => void loadSources()}>
              重新读取来源
            </button>
          </p>
        )}
        <p className="muted">
          导入源始终只读，文件复制到当前音乐库；带有 .part 等标记的文件会等待下载完成。
        </p>
        <div className="source-actions">
          <button
            type="button"
            className="primary"
            disabled={busy || !canImport || !selection}
            onClick={() => void importFolder()}
          >
            {busy ? '正在提交…' : '导入所选文件夹'}
          </button>
          <small className="muted">
            {selection ? displayPath(selection.path) : '请先选择导入文件夹'}
          </small>
        </div>
        {pickerOpen && selection && (
          <ImportFolderDialog
            sources={sources}
            initial={selection}
            onClose={() => setPickerOpen(false)}
            onSelect={(next, result) => {
              setSelection(next);
              setPreview(result);
              setNotice('');
              setPickerOpen(false);
            }}
          />
        )}
        {preview && (
          <div className="source-preview">
            <strong>{displayPath(preview.path)}</strong>
            <span>{preview.count} 个音频文件（含子目录）</span>
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
