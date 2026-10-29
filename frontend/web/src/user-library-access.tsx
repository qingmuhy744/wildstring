import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, type User } from './api';
import { DialogCloseButton } from './dialog-close';
import type { MusicLibrary } from './music-libraries';

type Access = { version: number; library_ids: string[] };

export function UserLibraryAccessDialog({
  user,
  onClose,
  onSaved,
}: {
  user: User;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [libraries, setLibraries] = useState<MusicLibrary[]>([]);
  const [access, setAccess] = useState<Access | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const endpoint = `/libraries/access/${encodeURIComponent(user.id)}`;
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setAccess(null);
    void Promise.all([
      api<MusicLibrary[]>('/libraries', { signal: controller.signal }),
      api<Access>(endpoint, { signal: controller.signal }),
    ])
      .then(([items, value]) => {
        if (controller.signal.aborted) return;
        setLibraries(items);
        setAccess(value);
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint, reload]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!access || busy) return;
    setBusy(true);
    setError('');
    try {
      await api<Access>(endpoint, { method: 'PUT', body: JSON.stringify(access) });
      window.dispatchEvent(new Event('wildstring:libraries-updated'));
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '库权限保存失败。');
      setReload((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="playlist-editor user-library-dialog"
      aria-label={`${user.username} 的库权限`}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="editor-heading">
        <div>
          <h2>库权限</h2>
          <p className="muted">{user.username}</p>
        </div>
        <DialogCloseButton aria-label="关闭库权限" disabled={busy} onClick={onClose} />
      </div>
      <p className="muted">选择这个账号可以浏览和播放的音乐库。编辑、导入等能力由账号角色决定。</p>
      <form className="account-form" onSubmit={save}>
        {loading && <p role="status">正在读取库权限…</p>}
        {!loading && access && (
          <fieldset className="music-library-options" disabled={busy}>
            <legend>可访问音乐库</legend>
            {libraries.map((library) => (
              <label className="music-library-grant-option" key={library.id}>
                <input
                  type="checkbox"
                  checked={access.library_ids.includes(library.id)}
                  onChange={(event) =>
                    setAccess({
                      ...access,
                      library_ids: event.target.checked
                        ? [...access.library_ids, library.id]
                        : access.library_ids.filter((id) => id !== library.id),
                    })
                  }
                />
                <span>{library.name}</span>
              </label>
            ))}
            {libraries.length === 0 && (
              <p className="muted">暂无已启用的音乐库，请先在设置中创建。</p>
            )}
            <small>未勾选时仍可使用个人播客关注等功能。保存后，新请求会使用新的授权范围。</small>
          </fieldset>
        )}
        {error && (
          <div className="error" role="alert">
            <p>{error}</p>
            {!loading && !access && (
              <button type="button" onClick={() => setReload((value) => value + 1)}>
                重新读取库权限
              </button>
            )}
          </div>
        )}
        <div className="editor-footer">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy || loading || !access}>
            {busy ? '保存中…' : '保存库权限'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
