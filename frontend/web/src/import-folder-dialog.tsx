import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { DialogCloseButton } from './dialog-close';
import { Icon } from './icons';
import './import-folder-dialog.css';

export type ImportSource = { id: string; name: string; path?: string };
export type ImportSelection = { source_id: string; path: string };
export type ImportPreview = ImportSelection & {
  files: string[];
  count: number;
  pending_markers: string[];
};
type SourceListing = ImportSelection & {
  items: {
    name: string;
    path: string;
    kind: 'folder' | 'file';
    importable?: boolean;
    pending?: boolean;
  }[];
};

export function ImportFolderDialog({
  sources,
  initial,
  onSelect,
  onClose,
}: {
  sources: ImportSource[];
  initial: ImportSelection;
  onSelect: (selection: ImportSelection, preview: ImportPreview | null) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [sourceId, setSourceId] = useState(initial.source_id);
  const [path, setPath] = useState(initial.path);
  const [listing, setListing] = useState<SourceListing | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const load = useCallback(async (source: string, folder: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    setListing(null);
    setPreview(null);
    setFilter('');
    setSourceId(source);
    setPath(folder);
    try {
      const current = await api<SourceListing>(
        `/manage/library/folders?source_id=${encodeURIComponent(source)}&path=${encodeURIComponent(folder)}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) {
        setListing(current);
        setPath(current.path);
      }
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error ? reason.message : '目录暂时无法读取，请检查来源路径是否可用。',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, []);
  useEffect(() => {
    dialog.current?.showModal();
    void load(initial.source_id, initial.path);
    return () => request.current?.abort();
  }, [initial.source_id, initial.path, load]);

  async function inspect() {
    if (!listing) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const value = await api<ImportPreview>('/manage/library/import/preview', {
        method: 'POST',
        body: JSON.stringify({ source_id: sourceId, path: listing.path }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setPreview(value);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : '预览未完成，请重试。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const source = sources.find((item) => item.id === sourceId);
  const parts = listing?.path === '.' ? [] : (listing?.path || '').split('/');
  const visible =
    listing?.items.filter((item) =>
      item.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
    ) || [];
  const folders = listing?.items.filter((item) => item.kind === 'folder').length || 0;
  const audio = listing?.items.filter((item) => item.importable).length || 0;
  return (
    <dialog
      ref={dialog}
      className="import-folder-dialog"
      aria-label="选择导入文件夹"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="import-folder-heading">
        <div>
          <span className="eyebrow">IMPORT FOLDER</span>
          <h2>选择导入文件夹</h2>
          <p>浏览服务器来源，选择本次要导入的目录。</p>
        </div>
        <DialogCloseButton aria-label="关闭导入文件夹选择" onClick={onClose} />
      </header>
      <div className="import-folder-location">
        <label>
          导入来源
          <select value={sourceId} onChange={(event) => void load(event.target.value, '.')}>
            {sources.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void load(sourceId, path.trim() || '.');
          }}
        >
          <label>
            来源内路径
            <input
              aria-label="来源内路径"
              disabled={busy}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder=". 或 艺人/专辑"
            />
          </label>
          <button type="submit" disabled={busy}>
            打开路径
          </button>
        </form>
      </div>
      <nav className="source-breadcrumbs" aria-label="导入文件夹导航">
        <button type="button" disabled={busy} onClick={() => void load(sourceId, '.')}>
          {source?.name || '来源根目录'}
        </button>
        {parts.map((part, index) => (
          <span key={index}>
            <span aria-hidden="true"> / </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void load(sourceId, parts.slice(0, index + 1).join('/'))}
            >
              {part}
            </button>
          </span>
        ))}
      </nav>
      <div className="import-folder-workspace">
        <section className="import-folder-files" aria-label="来源文件列表" aria-busy={busy}>
          <div className="import-folder-tools">
            <button
              type="button"
              disabled={busy || !listing || listing.path === '.'}
              onClick={() => void load(sourceId, parts.slice(0, -1).join('/') || '.')}
            >
              <Icon name="up" />
              上一级
            </button>
            <input
              type="search"
              aria-label="筛选当前文件夹"
              disabled={busy}
              placeholder="筛选当前目录…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <button
              type="button"
              aria-label="刷新目录"
              disabled={busy}
              onClick={() => void load(sourceId, listing?.path || path)}
            >
              <Icon name="refresh" />
            </button>
          </div>
          <div className="import-folder-list">
            {busy && !listing ? (
              <p className="muted" role="status">
                正在读取目录…
              </p>
            ) : (
              visible.map((item) =>
                item.kind === 'folder' ? (
                  <button
                    type="button"
                    className="import-folder-entry"
                    key={item.path}
                    disabled={busy}
                    onClick={() => void load(sourceId, item.path)}
                  >
                    <Icon name="folder" />
                    <strong>{item.name}</strong>
                    <span>文件夹</span>
                    <Icon name="chevron" />
                  </button>
                ) : (
                  <div className="import-folder-entry" key={item.path}>
                    <Icon name="music" />
                    <span>{item.name}</span>
                    <small className={item.pending ? 'source-pending' : ''}>
                      {item.pending ? '等待下载' : item.importable ? '音频' : '附属文件'}
                    </small>
                  </div>
                ),
              )
            )}
            {!busy && listing && !visible.length && (
              <p className="muted">{filter ? '没有匹配的文件或文件夹。' : '这个目录是空的。'}</p>
            )}
            {!busy && !listing && <p className="muted">无法读取此目录，可返回来源根目录或重试。</p>}
          </div>
        </section>
        <aside className="import-folder-summary" aria-label="当前导入范围">
          <Icon name="folder" />
          <h3>当前文件夹</h3>
          <strong>{listing ? parts.at(-1) || source?.name : '尚未读取'}</strong>
          <code>
            {source?.path}
            {listing && listing.path !== '.' ? `/${listing.path}` : ''}
          </code>
          <p>选择后导入此目录及其子目录，不包含同级的其他文件夹。</p>
          {listing && (
            <small>
              当前层级：{folders} 个文件夹 · {audio} 个音频文件
            </small>
          )}
          <button type="button" disabled={busy || !listing} onClick={() => void inspect()}>
            {busy && listing ? '正在预览…' : '预览此文件夹'}
          </button>
          {preview && (
            <div className="import-folder-result" role="status">
              <strong>{preview.count} 个音频文件</strong>
              <span>包含所有子目录，已入库且未变化的音频会跳过复制。</span>
              {preview.pending_markers.length > 0 && (
                <small className="source-pending">
                  {preview.pending_markers.length} 个下载标记，相关音频仍需等待完成。
                </small>
              )}
            </div>
          )}
          <small>来源始终只读，文件复制到当前音乐库。</small>
        </aside>
      </div>
      {error && (
        <p className="error import-folder-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <span>
          {listing
            ? `已浏览：${listing.path === '.' ? '来源根目录' : listing.path}`
            : '请选择可读取的文件夹'}
        </span>
        <div>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !listing}
            onClick={() =>
              listing && onSelect({ source_id: sourceId, path: listing.path }, preview)
            }
          >
            选择此文件夹
          </button>
        </div>
      </footer>
    </dialog>
  );
}
