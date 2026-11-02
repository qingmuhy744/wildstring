import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { DialogCloseButton } from './dialog-close';

type Resource = {
  id: string;
  podcast_title: string;
  title: string;
  reference_count: number;
  size_bytes: number;
  protected: boolean;
  active: boolean;
  version: number;
};
type ResourcePage = { items: Resource[]; total: number; total_bytes: number };
type Settings = { version: number; enabled: boolean; retention_days: number };
export type CleanupCandidate = {
  id: string;
  podcast_id: string;
  podcast_title: string;
  title: string;
  size_bytes: number;
  local_path: string;
};
export type Cleanup = {
  candidate_count: number;
  candidate_bytes: number;
  deleted_count: number;
  freed_bytes: number;
  failed_count: number;
  candidates?: CleanupCandidate[];
};
const size = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

export function PodcastCleanupCandidatesDialog({
  preview,
  busy,
  onClose,
  onConfirmCleanup,
}: {
  preview: Cleanup;
  busy: boolean;
  onClose: () => void;
  onConfirmCleanup: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      previous?.focus({ preventScroll: true });
    };
  }, []);

  const candidates = preview.candidates ?? [];

  return (
    <dialog
      ref={dialog}
      className="podcast-cleanup-dialog"
      aria-labelledby="podcast-cleanup-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) {
          const bounds = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < bounds.left ||
            e.clientX > bounds.right ||
            e.clientY < bounds.top ||
            e.clientY > bounds.bottom
          ) {
            onClose();
          }
        }
      }}
    >
      <header className="podcast-cleanup-dialog-header">
        <div className="podcast-cleanup-dialog-title-wrap">
          <h2 id="podcast-cleanup-dialog-title">待清理零引用音频</h2>
          <span className="podcast-cleanup-dialog-badge">
            {preview.candidate_count} 个文件 · {size(preview.candidate_bytes)}
          </span>
        </div>
        <DialogCloseButton aria-label="关闭待清理清单" disabled={busy} onClick={onClose} />
      </header>

      <div className="podcast-cleanup-dialog-body">
        <p className="podcast-cleanup-dialog-desc">
          以下音频文件无任何用户保存或个人引用、未被标记保护，且不在活跃播放或下载中。执行手动清理将物理回收磁盘空间，单集元数据与收听历史仍会保留。
        </p>

        {candidates.length > 0 ? (
          <div className="podcast-cleanup-candidates-list" role="list">
            {candidates.map((item) => (
              <article key={item.id} className="podcast-cleanup-candidate-item" role="listitem">
                <div className="candidate-info">
                  <strong className="candidate-title">{item.title}</strong>
                  <span className="candidate-podcast">{item.podcast_title}</span>
                  {item.local_path && (
                    <span className="candidate-path" title={item.local_path}>
                      {item.local_path.split('/').pop()}
                    </span>
                  )}
                </div>
                <div className="candidate-meta">
                  <span className="candidate-size">{size(item.size_bytes)}</span>
                  <span className="candidate-pill">0 份引用</span>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="podcast-cleanup-empty-state">
            <p className="empty-title">当前暂无待清理音频</p>
            <p className="empty-desc">
              所有本地音频均有账号引用、处于保护状态或正在播放/下载中，无需清理。
            </p>
          </div>
        )}
      </div>

      <footer className="podcast-cleanup-dialog-footer">
        <span className="podcast-cleanup-dialog-hint">
          {candidates.length > 0 ? '清理后无法撤销，仅删除音频本地缓存文件' : ''}
        </span>
        <div className="podcast-cleanup-dialog-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={busy || !preview.candidate_count}
            onClick={onConfirmCleanup}
          >
            {busy ? '正在清理…' : `确认清理 (${preview.candidate_count})`}
          </button>
        </div>
      </footer>
    </dialog>
  );
}

export function PodcastResourceManager() {
  const [page, setPage] = useState<ResourcePage | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [offset, setOffset] = useState(0);
  const [preview, setPreview] = useState<Cleanup | null>(null);
  const [candidateDialogOpen, setCandidateDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function load(start = offset) {
    const [items, policy] = await Promise.all([
      api<ResourcePage>(`/podcasts/resources?offset=${start}&limit=50`),
      api<Settings>('/podcasts/resources/settings'),
    ]);
    setPage(items);
    setSettings(policy);
  }
  useEffect(() => {
    void load(offset).catch((error: Error) => setMessage(error.message));
  }, [offset]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作未完成');
    } finally {
      setBusy(false);
    }
  }
  async function cleanup(dry_run: boolean) {
    const result = await api<Cleanup>('/podcasts/resources/cleanup', {
      method: 'POST',
      body: JSON.stringify({ dry_run }),
    });
    if (dry_run) {
      setPreview(result);
      return result;
    } else {
      setPreview(null);
      setCandidateDialogOpen(false);
      setMessage(
        `已清理 ${result.deleted_count} 个文件，释放 ${size(result.freed_bytes)}${result.failed_count ? `，${result.failed_count} 个文件未能删除，登记已保留` : ''}。`,
      );
      await load();
      return result;
    }
  }

  async function openCandidateDialog() {
    if (!preview) {
      await run(async () => {
        await cleanup(true);
      });
    }
    setCandidateDialogOpen(true);
  }

  return (
    <section aria-labelledby="podcast-resources-title">
      <div className="podcast-resource-manager">
        <div className="podcast-resource-heading">
          <h2 id="podcast-resources-title">共享音频管理</h2>
        </div>
        <p>保存单集会建立个人引用。清理仅处理零引用音频；正在播放、下载和手动保护的资源会保留。</p>
        <p className="muted">
          自动清理会等待保留期结束；节目资料与收听记录保留。以下手动清理会立即回收符合条件的零引用文件。
        </p>
        {message && <p role="status">{message}</p>}
        {settings && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                setSettings(
                  await api<Settings>('/podcasts/resources/settings', {
                    method: 'PUT',
                    body: JSON.stringify(settings),
                  }),
                );
                setPreview(null);
                setMessage('自动清理策略已保存。');
              });
            }}
          >
            <fieldset disabled={busy}>
              <legend>自动清理</legend>
              <label>
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
                />
                自动清理零引用音频
              </label>
              <label>
                零引用后保留天数
                <input
                  type="number"
                  min={0}
                  max={3650}
                  value={settings.retention_days}
                  onChange={(e) =>
                    setSettings({ ...settings, retention_days: Number(e.target.value) })
                  }
                />
              </label>
              <button type="submit">保存清理策略</button>
            </fieldset>
          </form>
        )}
        <div className="podcast-resource-cleanup">
          <p>{page ? `${page.total} 份共享音频 · ${size(page.total_bytes)}` : '正在读取资源…'}</p>
          <div className="podcast-cleanup-action-row">
            <button type="button" disabled={busy} onClick={() => void run(() => cleanup(true))}>
              预览零引用清理
            </button>
            <button
              type="button"
              className="podcast-cleanup-view-btn"
              disabled={busy}
              onClick={() => void openCandidateDialog()}
            >
              {preview ? `查看待清理清单 (${preview.candidate_count})` : '查看待清理清单'}
            </button>
          </div>
          {preview && (
            <div role="status" className="podcast-cleanup-preview-box">
              <p>
                当前可清理 {preview.candidate_count} 个文件，共 {size(preview.candidate_bytes)}
                。手动清理会立即回收这些零引用文件。
              </p>
              <div className="podcast-cleanup-preview-actions">
                <button
                  type="button"
                  disabled={busy || !preview.candidate_count}
                  onClick={() => void run(() => cleanup(false))}
                >
                  确认清理零引用文件
                </button>
                <button
                  type="button"
                  className="podcast-cleanup-view-btn"
                  disabled={busy}
                  onClick={() => setCandidateDialogOpen(true)}
                >
                  查看待清理清单 ({preview.candidate_count})
                </button>
              </div>
            </div>
          )}
        </div>
        {candidateDialogOpen && preview && (
          <PodcastCleanupCandidatesDialog
            preview={preview}
            busy={busy}
            onClose={() => setCandidateDialogOpen(false)}
            onConfirmCleanup={() => void run(() => cleanup(false))}
          />
        )}
        <div className="podcast-resource-list">
          {page?.items.map((item) => (
            <article key={item.id}>
              <div>
                <strong>{item.title}</strong>
                <p>{item.podcast_title}</p>
                <small>
                  {item.reference_count} 份引用 · {size(item.size_bytes)}
                  {item.active ? ' · 使用中' : ''}
                </small>
              </div>
              <button
                type="button"
                disabled={busy}
                aria-label={`${item.protected ? '取消保护' : '保护'}：${item.title}`}
                onClick={() =>
                  void run(async () => {
                    await api(`/podcasts/resources/${encodeURIComponent(item.id)}/protection`, {
                      method: 'PUT',
                      body: JSON.stringify({ version: item.version, protected: !item.protected }),
                    });
                    setPreview(null);
                    await load();
                  })
                }
              >
                {item.protected ? '取消保护' : '保护音频'}
              </button>
            </article>
          ))}
        </div>
        <div className="podcast-resource-pagination">
          <button
            type="button"
            disabled={busy || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            上一页
          </button>
          <button
            type="button"
            disabled={busy || !page || offset + 50 >= page.total}
            onClick={() => setOffset(offset + 50)}
          >
            下一页
          </button>
          <button type="button" disabled={busy} onClick={() => void run(() => load())}>
            重新读取
          </button>
        </div>
      </div>
    </section>
  );
}
