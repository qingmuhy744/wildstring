import { useEffect, useRef, useState } from 'react';
import { api, artist, type Track } from './api';

interface TrackFileInfo {
  track_id: string;
  format: string;
  size_bytes: number;
  path: string;
  source_path?: string | null;
  source_filename?: string;
  absolute_path: string;
  suggested_path: string;
  in_sync: boolean;
  file_exists: boolean;
}

interface ReorganizeResult {
  status: string;
  changed: boolean;
  old_path?: string;
  new_path?: string;
  moved_sidecars?: string[];
  reason?: string;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function TrackFileInfoDialog({
  track,
  canManage = false,
  onClose,
  onReorganized,
}: {
  track: Track;
  canManage?: boolean;
  onClose: () => void;
  onReorganized?: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<TrackFileInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reorganizing, setReorganizing] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await api<TrackFileInfo>(`/tracks/${encodeURIComponent(track.id)}/file-info`);
      setInfo(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法获取文件信息');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const node = dialogRef.current;
    node?.showModal();
    void load();
    return () => {
      node?.close();
    };
  }, [track.id]);

  async function copyText(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // ignore clipboard error
    }
  }

  async function handleReorganize() {
    setReorganizing(true);
    setActionMessage('');
    try {
      const res = await api<ReorganizeResult>(
        `/manage/tracks/${encodeURIComponent(track.id)}/reorganize-file`,
        { method: 'POST' },
      );
      await load();
      if (res.changed) {
        const sidecars = res.moved_sidecars?.length
          ? `（同时已迁移 ${res.moved_sidecars.length} 个关联文件，如歌词）`
          : '';
        setActionMessage(`物理文件已规范重排到新路径！${sidecars}`);
      } else {
        setActionMessage('文件物理路径已经是最新规范状态，无需移动。');
      }
      onReorganized?.();
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : '重排物理文件失败');
    } finally {
      setReorganizing(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="track-file-info-dialog modal-dialog"
      onClose={onClose}
      aria-labelledby="file-info-title"
    >
      <div className="file-info-content">
        <header className="file-info-header">
          <div className="file-info-title-group">
            <h3 id="file-info-title">歌曲文件与属性</h3>
            <p className="file-info-track-name ellipsis">
              {track.title} · {artist(track)}
            </p>
          </div>
          <button
            type="button"
            className="icon-button close-button"
            aria-label="关闭"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        {loading ? (
          <div className="file-info-loading" role="status">
            正在读取磁盘文件信息…
          </div>
        ) : error ? (
          <div className="file-info-error" role="alert">
            <p>{error}</p>
            <button type="button" className="text-button" onClick={load}>
              重试
            </button>
          </div>
        ) : info ? (
          <div className="file-info-body">
            <div className="file-info-meta-grid">
              <div className="meta-item">
                <span className="meta-label">音频格式</span>
                <span className="meta-value format-badge">{info.format.toUpperCase()}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">文件大小</span>
                <span className="meta-value">{formatBytes(info.size_bytes)}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">文件状态</span>
                <span className={`meta-value ${info.file_exists ? 'status-ok' : 'status-missing'}`}>
                  {info.file_exists ? '正常存在' : '文件丢失'}
                </span>
              </div>
              <div className="meta-item">
                <span className="meta-label">路径对齐</span>
                <span
                  className={`meta-value sync-tag ${info.in_sync ? 'tag-synced' : 'tag-desynced'}`}
                >
                  {info.in_sync ? '已对齐最新元数据' : '路径未对齐'}
                </span>
              </div>
            </div>

            {info.source_filename && (
              <div className="file-info-section">
                <div className="section-label-row">
                  <span className="section-title">原始导入/上传文件名</span>
                  <button
                    type="button"
                    className="text-copy-button"
                    onClick={() => copyText(info.source_filename!, 'source')}
                  >
                    {copiedKey === 'source' ? '已复制' : '复制'}
                  </button>
                </div>
                <div className="path-display-box">
                  <code>{info.source_filename}</code>
                </div>
              </div>
            )}

            <div className="file-info-section">
              <div className="section-label-row">
                <span className="section-title">托管曲库相对路径</span>
                <button
                  type="button"
                  className="text-copy-button"
                  onClick={() => copyText(info.path, 'rel')}
                >
                  {copiedKey === 'rel' ? '已复制' : '复制'}
                </button>
              </div>
              <div className="path-display-box">
                <code>{info.path}</code>
              </div>
            </div>

            <div className="file-info-section">
              <div className="section-label-row">
                <span className="section-title">服务器绝对物理路径</span>
                <button
                  type="button"
                  className="text-copy-button"
                  onClick={() => copyText(info.absolute_path, 'abs')}
                >
                  {copiedKey === 'abs' ? '已复制' : '复制'}
                </button>
              </div>
              <div className="path-display-box">
                <code>{info.absolute_path}</code>
              </div>
            </div>

            {!info.in_sync && (
              <div className="file-info-desync-box">
                <div className="desync-header">
                  <span className="desync-icon">⚠</span>
                  <strong>物理路径与最新元数据未对齐</strong>
                </div>
                <p className="desync-hint">
                  这首歌曲的元数据（如艺人、专辑或音轨编号）发生过修改，但磁盘上的文件及目录尚未重组。
                </p>
                <div className="section-label-row">
                  <span className="section-title">规范目标路径</span>
                  <button
                    type="button"
                    className="text-copy-button"
                    onClick={() => copyText(info.suggested_path, 'suggested')}
                  >
                    {copiedKey === 'suggested' ? '已复制' : '复制'}
                  </button>
                </div>
                <div className="path-display-box suggested">
                  <code>{info.suggested_path}</code>
                </div>

                {canManage ? (
                  <div className="reorganize-action-row">
                    <button
                      type="button"
                      className="primary reorganize-btn"
                      disabled={reorganizing}
                      onClick={handleReorganize}
                    >
                      {reorganizing ? '正在重排物理文件…' : '按最新元数据重排物理文件'}
                    </button>
                  </div>
                ) : (
                  <p className="desync-note">管理员账号可在本页面一键重排物理文件。</p>
                )}
              </div>
            )}

            {actionMessage && (
              <p
                className={`action-message ${actionMessage.includes('失败') ? 'error' : 'success'}`}
                role="status"
              >
                {actionMessage}
              </p>
            )}
          </div>
        ) : null}

        <footer className="file-info-footer">
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </dialog>
  );
}
