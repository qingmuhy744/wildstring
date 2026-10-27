import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { DialogCloseButton } from './dialog-close';
import type { PodcastSummary } from './podcasts';

export interface PodcastDownloadSettings {
  version: number;
  download_policy: 'none' | 'latest_3' | 'latest_5' | 'latest_10' | 'unplayed' | 'all';
  retention_policy: 'keep' | 'delete_after_played';
  active: boolean;
}
const choices: [PodcastDownloadSettings['download_policy'], string][] = [
  ['none', '关闭自动下载'],
  ['latest_3', '最新 3 集'],
  ['latest_5', '最新 5 集'],
  ['latest_10', '最新 10 集'],
  ['unplayed', '所有未听完单集'],
  ['all', '全部历史单集'],
];
export function PodcastDownloadDialog({
  podcast,
  onClose,
  onSaved,
}: {
  podcast: PodcastSummary;
  onClose: () => void;
  onSaved: (value: PodcastDownloadSettings) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState<PodcastDownloadSettings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setValue(null);
    setError('');
    void api<PodcastDownloadSettings>(
      `/podcasts/${encodeURIComponent(podcast.id)}/download-settings`,
      {
        signal: controller.signal,
      },
    )
      .then(setValue)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '读取失败');
      });
    return () => controller.abort();
  }, [podcast.id, reload]);
  async function save() {
    if (!value) return;
    setBusy(true);
    setError('');
    try {
      const updated = await api<PodcastDownloadSettings>(
        `/podcasts/${encodeURIComponent(podcast.id)}/download-settings`,
        {
          method: 'PUT',
          body: JSON.stringify({
            version: value.version,
            download_policy: value.download_policy,
            retention_policy: value.retention_policy,
          }),
        },
      );
      onSaved(updated);
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? '设置已发生变化或节目已取消关注，请重新读取后再试。'
          : err instanceof Error
            ? err.message
            : '保存失败',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="podcasts-modal podcast-storage-modal"
      aria-labelledby="personal-download-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <header className="podcasts-modal-header">
        <div>
          <p className="storage-podcast-name">{podcast.title}</p>
          <h3 id="personal-download-title">自动下载设置</h3>
        </div>
        <DialogCloseButton
          className="modal-close-btn"
          aria-label="关闭自动下载设置"
          disabled={busy}
          onClick={onClose}
        />
      </header>
      <form
        className="podcast-storage-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="podcast-storage-body">
          <p className="podcast-settings-desc">
            仅对当前账号关注的这个节目生效。服务器音频共享，你的保存记录与其他用户独立。
          </p>
          {!value && !error && <p role="status">正在读取…</p>}
          {value && (
            <>
              {!value.active && (
                <p role="status">已取消关注，自动下载暂停。重新关注后恢复此设置。</p>
              )}
              <fieldset className="storage-policy-group" disabled={busy || !value.active}>
                <legend>自动下载范围</legend>
                <div className="storage-policy-options">
                  {choices.map(([key, label]) => (
                    <label className="storage-choice" key={key}>
                      <input
                        type="radio"
                        name="personal-download-policy"
                        value={key}
                        checked={value.download_policy === key}
                        onChange={() => setValue({ ...value, download_policy: key })}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
                <p className="podcast-settings-desc">
                  最新 N 集始终按发布时间取固定范围，已有音频直接复用；不会逐轮补下更旧的单集。
                </p>
              </fieldset>
              <fieldset className="storage-policy-group" disabled={busy || !value.active}>
                <legend>听完后</legend>
                {(
                  [
                    ['keep', '保留自动保存'],
                    ['delete_after_played', '释放我的自动保存'],
                  ] as const
                ).map(([key, label]) => (
                  <label className="storage-choice" key={key}>
                    <input
                      type="radio"
                      name="personal-download-retention"
                      checked={value.retention_policy === key}
                      onChange={() => setValue({ ...value, retention_policy: key })}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
              <p className="podcast-settings-desc">
                关闭自动下载、取消关注或移出范围会释放自动引用。手动保存继续保留；文件只有在无人引用时才进入服务器清理规则。
              </p>
            </>
          )}
          {error && (
            <p className="podcast-settings-error" role="alert">
              {error}
            </p>
          )}
          {error && (
            <button
              type="button"
              className="modal-cancel-btn"
              disabled={busy}
              onClick={() => setReload((n) => n + 1)}
            >
              重新读取设置
            </button>
          )}
        </div>
        <footer className="storage-settings-footer">
          <button type="button" className="modal-cancel-btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="modal-submit-btn primary"
            disabled={!value || busy || !value.active}
          >
            {busy ? '保存中…' : '保存设置'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
