import { useEffect, useState } from 'react';
import { api, type User } from './api';

function useAvatar(user: User) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setVersion(null);
    const load = () =>
      void api<{ version: string | null }>('/auth/avatar/info', { signal: controller.signal })
        .then((value) => {
          if (!controller.signal.aborted)
            setVersion(
              typeof value.version === 'string' && /^[a-f0-9]{64}$/.test(value.version)
                ? value.version
                : null,
            );
        })
        .catch(() => {});
    load();
    window.addEventListener('wildstring:avatar-changed', load);
    window.addEventListener('focus', load);
    return () => {
      controller.abort();
      window.removeEventListener('wildstring:avatar-changed', load);
      window.removeEventListener('focus', load);
    };
  }, [user.id]);
  return version;
}

export function AccountAvatar({ user }: { user: User }) {
  const version = useAvatar(user);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [version]);
  return version && !failed ? (
    <img
      className="user-avatar"
      src={`/api/v1/auth/avatar?v=${version}`}
      alt=""
      onError={() => setFailed(true)}
    />
  ) : (
    <span className="user-avatar avatar-fallback" aria-hidden="true">
      {user.username.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function AvatarEditor({
  user,
  disabled = false,
  onBusy,
}: {
  user: User;
  disabled?: boolean;
  onBusy?: (value: boolean) => void;
}) {
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    const url = file ? URL.createObjectURL(file) : '';
    setPreview(url);
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);
  async function save(remove = false) {
    if (busy || disabled || (!remove && !file)) return;
    setBusy(true);
    onBusy?.(true);
    setMessage('正在保存头像…');
    try {
      await api(
        '/auth/avatar',
        remove
          ? { method: 'DELETE' }
          : {
              method: 'POST',
              headers: { 'Content-Type': file!.type || 'application/octet-stream' },
              body: file,
            },
      );
      setFile(null);
      window.dispatchEvent(new Event('wildstring:avatar-changed'));
      setMessage(remove ? '已恢复默认头像。' : '头像已保存。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '头像未保存，请重试。');
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  }
  return (
    <section className="avatar-editor" aria-label="自定义头像">
      <div className="avatar-preview">
        {preview ? (
          <img className="user-avatar" src={preview} alt="头像预览" />
        ) : (
          <AccountAvatar user={user} />
        )}
      </div>
      <div className="avatar-controls">
        <label>
          选择头像
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy || disabled}
            onChange={(event) => {
              const selected = event.target.files?.[0] || null;
              event.target.value = '';
              if (selected && selected.size > 5 * 1024 * 1024) {
                setMessage('请选择不超过 5 MiB 的图片。');
                return;
              }
              setFile(selected);
              setMessage('');
            }}
          />
        </label>
        <small className="muted">
          JPG / PNG / WebP，最多 5 MiB；居中裁成方形，保存时移除图片附带信息。
        </small>
        <div className="avatar-actions">
          <button type="button" disabled={busy || disabled || !file} onClick={() => void save()}>
            上传头像
          </button>
          <button type="button" disabled={busy || disabled} onClick={() => void save(true)}>
            恢复默认头像
          </button>
        </div>
        {message && <p role="status">{message}</p>}
      </div>
    </section>
  );
}
