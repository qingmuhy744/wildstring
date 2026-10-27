import { useEffect, useRef, useState } from 'react';
import { api } from './api';

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
type Cleanup = {
  candidate_count: number;
  candidate_bytes: number;
  deleted_count: number;
  freed_bytes: number;
  failed_count: number;
};
const size = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

export function PodcastResourceManager({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState<ResourcePage | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [offset, setOffset] = useState(0);
  const [preview, setPreview] = useState<Cleanup | null>(null);
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
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    void load(offset).catch((error: Error) => setMessage(error.message));
  }, [offset]);
  async function run(action: () => Promise<void>) {
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
    if (dry_run) setPreview(result);
    else {
      setPreview(null);
      setMessage(
        `已清理 ${result.deleted_count} 个文件，释放 ${size(result.freed_bytes)}${result.failed_count ? `，${result.failed_count} 个文件未能删除，登记已保留` : ''}。`,
      );
      await load();
    }
  }
  return (
    <dialog
      ref={dialog}
      className="podcasts-modal podcast-resource-modal"
      aria-labelledby="podcast-resources-title"
      onCancel={onClose}
    >
      <div className="podcast-resource-manager">
        <div className="podcast-resource-heading">
          <h2 id="podcast-resources-title">共享音频管理</h2>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
        <p>保存单集会建立个人引用。清理仅处理零引用音频；正在播放、下载和手动保护的资源会保留。</p>
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
          <button type="button" disabled={busy} onClick={() => void run(() => cleanup(true))}>
            预览零引用清理
          </button>
          {preview && (
            <div role="status">
              <p>
                当前可清理 {preview.candidate_count} 个文件，共 {size(preview.candidate_bytes)}
                。手动清理会立即回收这些零引用文件。
              </p>
              <button
                type="button"
                disabled={busy || !preview.candidate_count}
                onClick={() => void run(() => cleanup(false))}
              >
                确认清理零引用文件
              </button>
            </div>
          )}
        </div>
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
    </dialog>
  );
}
