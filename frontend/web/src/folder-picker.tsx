import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api';
import { Icon } from './icons';
import { DialogCloseButton } from './dialog-close';

type FolderListing = {
  path: string | null;
  parent: string | null;
  items: { name: string; path: string }[];
  truncated: boolean;
  can_create?: boolean;
  creation_blocked_reason?: 'read_only_source' | 'not_writable' | null;
};

export function FolderPicker({
  title,
  initialPath = '',
  onSelect,
  onClose,
}: {
  title: string;
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const pathRevision = useRef(0);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [path, setPath] = useState(initialPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async (next?: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const revision = pathRevision.current;
    setBusy(true);
    setError('');
    setShowCreate(false);
    setFolderName('');
    setCreateError('');
    setNotice('');
    try {
      const value = await api<FolderListing>(
        `/libraries/folders${next ? `?path=${encodeURIComponent(next)}` : ''}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setListing(value);
      if (pathRevision.current === revision) setPath(value.path || '');
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : '无法读取目录');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, []);
  useEffect(() => {
    dialog.current?.showModal();
    void load(initialPath || undefined);
    return () => {
      request.current?.abort();
    };
  }, [initialPath, load]);
  async function createFolder(event: FormEvent) {
    event.preventDefault();
    if (!listing?.path || !listing.can_create || creating || !folderName.trim()) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setCreating(true);
    setCreateError('');
    setNotice('');
    try {
      const value = await api<FolderListing>('/libraries/folders', {
        method: 'POST',
        body: JSON.stringify({ parent_path: listing.path, name: folderName.trim() }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setListing(value);
      setPath(value.path || '');
      setShowCreate(false);
      setFolderName('');
      setNotice('文件夹已创建，可选择此文件夹。');
    } catch (reason) {
      if (!controller.signal.aborted)
        setCreateError(reason instanceof Error ? reason.message : '无法创建文件夹');
    } finally {
      if (!controller.signal.aborted) setCreating(false);
    }
  }
  const parts = listing?.path?.split('/').filter(Boolean) || [];
  return (
    <dialog
      ref={dialog}
      className="server-folder-picker"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (creating) return;
        if (showCreate) setShowCreate(false);
        else onClose();
      }}
      onClick={(event) => {
        if (!creating && event.target === event.currentTarget) onClose();
      }}
    >
      <header>
        <div>
          <span className="eyebrow">SERVER FOLDERS</span>
          <h2>{title}</h2>
        </div>
        <DialogCloseButton aria-label="关闭文件夹选择" disabled={creating} onClick={onClose} />
      </header>
      <div className="folder-picker-body">
        <p className="muted">
          浏览服务器上的目录。Docker 中显示容器内路径，选择文件夹不会修改源文件。
        </p>
        <div className="folder-path-entry">
          <input
            aria-label="服务器目录路径"
            value={path}
            disabled={creating}
            placeholder="输入完整路径，如 /music"
            onChange={(event) => {
              pathRevision.current += 1;
              setPath(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void load(path.trim());
              }
            }}
          />
          <button
            type="button"
            disabled={busy || creating || !path.trim()}
            onClick={() => void load(path.trim())}
          >
            打开路径
          </button>
          <button
            type="button"
            disabled={busy || creating || !!error || !listing?.can_create}
            onClick={() => {
              setShowCreate(true);
              setCreateError('');
              setNotice('');
            }}
          >
            <Icon name="add" /> 新建文件夹
          </button>
        </div>
        <nav aria-label="服务器目录导航">
          <button type="button" disabled={creating} onClick={() => void load()}>
            常用位置
          </button>
          {listing?.path && (
            <button type="button" disabled={creating} onClick={() => void load('/')}>
              /
            </button>
          )}
          {parts.map((part, index) => (
            <button
              type="button"
              key={index}
              disabled={creating}
              onClick={() => void load('/' + parts.slice(0, index + 1).join('/'))}
            >
              {part}
            </button>
          ))}
        </nav>
        {listing?.creation_blocked_reason && (
          <p className="folder-picker-hint">
            {listing?.creation_blocked_reason === 'read_only_source'
              ? '音乐来源保持只读'
              : '当前目录不可写'}
          </p>
        )}
        {showCreate && (
          <form className="folder-create-form" aria-label="新建文件夹" onSubmit={createFolder}>
            <label>
              文件夹名称
              <input
                autoFocus
                required
                maxLength={255}
                value={folderName}
                onChange={(event) => setFolderName(event.target.value)}
                placeholder="输入新文件夹名称"
                disabled={creating}
              />
            </label>
            <div className="folder-create-actions">
              <button type="button" disabled={creating} onClick={() => setShowCreate(false)}>
                取消新建
              </button>
              <button className="primary" disabled={creating || !folderName.trim()}>
                {creating ? '创建中…' : '创建文件夹'}
              </button>
            </div>
            {createError && (
              <p className="error" role="alert">
                {createError}
              </p>
            )}
          </form>
        )}
        {notice && (
          <p className="folder-picker-notice" role="status">
            {notice}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="folder-picker-list" aria-busy={busy || creating}>
          {busy || creating ? (
            <p role="status">{creating ? '正在创建文件夹…' : '正在读取目录…'}</p>
          ) : (
            <>
              {listing?.parent && (
                <button type="button" onClick={() => void load(listing.parent!)}>
                  <Icon name="up" />
                  <span className="folder-entry-label">上一级</span>
                </button>
              )}
              {listing?.items.map((item) => (
                <button type="button" key={item.path} onClick={() => void load(item.path)}>
                  <Icon name="folder" />
                  <span className="folder-entry-label">
                    <strong>{item.name}</strong>
                    <small>{item.path}</small>
                  </span>
                  <Icon name="chevron" />
                </button>
              ))}
              {listing?.items.length === 0 && <p className="muted">没有可浏览的子文件夹。</p>}
              {listing?.truncated && (
                <p className="muted">仅显示前 500 个目录，可输入完整路径继续查找。</p>
              )}
            </>
          )}
        </div>
      </div>
      <footer>
        <div className="folder-picker-current">
          <span>当前目录</span>
          <span className="storage-path">{listing?.path || '请选择目录'}</span>
        </div>
        <div className="folder-picker-actions">
          <button type="button" disabled={creating} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || creating || !!error || !listing?.path}
            onClick={() => {
              if (listing?.path) onSelect(listing.path);
            }}
          >
            选择此文件夹
          </button>
        </div>
      </footer>
    </dialog>
  );
}
