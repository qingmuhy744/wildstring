import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, type User } from './api';
import { LastfmAccount } from './providers';
import { ThemeControl } from './theme';
import { PlaybackStyleControl } from './playback-style';
import { TrackListSizeControl } from './track-list-size';
import { AvatarEditor } from './avatar';
import { DialogCloseButton } from './dialog-close';
import type { MusicLibrary } from './music-libraries';
import { UserLibraryAccessDialog } from './user-library-access';

type Profile = User['profile'];
const profileLabels: Record<Profile, string> = {
  owner: '所有者',
  librarian: '曲库管理员',
  editor: '资料编辑员',
  listener: '听众',
};
const userProfile = (user: User): Profile => user.profile;

export function AccountDialog({
  user,
  onClose,
  onUserChange,
}: {
  user: User;
  onClose: () => void;
  onUserChange?: (user: User) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [current, setCurrent] = useState(''),
    [password, setPassword] = useState(''),
    [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [username, setUsername] = useState(user.username);
  const [displayName, setDisplayName] = useState(user.display_name || '');
  const [email, setEmail] = useState(user.email || '');
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState('');
  const [serverVersion, setServerVersion] = useState('');
  useEffect(() => {
    api<{ version?: string }>('/auth/status')
      .then((res) => {
        if (res.version) setServerVersion(res.version);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('两次输入的新密码不一致。');
      return;
    }
    setBusy(true);
    try {
      await api('/auth/password', {
        method: 'POST',
        body: JSON.stringify({ current_password: current, new_password: password }),
      });
      setCurrent('');
      setPassword('');
      setConfirm('');
      window.dispatchEvent(
        new CustomEvent('wildstring:unauthorized', { detail: '密码已修改，请使用新密码登录。' }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '修改未完成，请重试。');
    } finally {
      setBusy(false);
    }
  }
  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setProfileError('');
    setProfileSuccess('');
    setBusy(true);
    try {
      const updated = await api<User>('/auth/profile', {
        method: 'PUT',
        body: JSON.stringify({
          version: user.version,
          username,
          display_name: displayName,
          email,
        }),
      });
      setUsername(updated.username);
      setDisplayName(updated.display_name || '');
      setEmail(updated.email || '');
      setProfileSuccess('个人资料已保存。');
      onUserChange?.(updated);
    } catch (reason) {
      setProfileError(reason instanceof Error ? reason.message : '资料保存未完成，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="playlist-editor account-dialog"
      aria-label="账号设置"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="editor-heading">
        <div>
          <span className="eyebrow">YOUR ACCOUNT</span>
          <h2>账号设置</h2>
          <p className="muted">
            {user.username} · {profileLabels[userProfile(user)]}
          </p>
        </div>
        <DialogCloseButton aria-label="关闭账号设置" disabled={busy} onClick={onClose} />
      </div>
      <AvatarEditor user={user} disabled={busy} onBusy={setBusy} />
      <form className="account-form" onSubmit={saveProfile} aria-label="个人资料">
        <h3>个人资料</h3>
        <label>
          登录 ID
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,31}"
            maxLength={32}
            required
            autoComplete="username"
          />
        </label>
        <label>
          昵称
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={80}
            placeholder="显示给自己和设备的名称"
          />
        </label>
        <label>
          邮箱（仅作资料）
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            maxLength={254}
            placeholder="暂不用于找回密码"
            autoComplete="email"
          />
        </label>
        <p className="muted">邮箱当前只保存为账号资料，不会发送邮件或用于找回密码。</p>
        {profileError && (
          <p className="error" role="alert">
            {profileError}
          </p>
        )}
        {profileSuccess && (
          <p className="notice" role="status">
            {profileSuccess}
          </p>
        )}
        <div className="editor-footer">
          <span />
          <button className="primary" disabled={busy}>
            {busy ? '保存中…' : '保存个人资料'}
          </button>
        </div>
      </form>
      <section className="account-preferences-section" aria-label="界面与偏好">
        <h3>界面与偏好</h3>
        <p className="muted">这些偏好按账号保存在当前浏览器。</p>
        <div className="account-preferences-list">
          <ThemeControl />
          <PlaybackStyleControl />
          <TrackListSizeControl />
        </div>
      </section>
      <LastfmAccount />
      <form className="account-form" onSubmit={submit}>
        <label>
          当前密码
          <input
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label>
          新密码
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          确认新密码
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        <p className="muted">密码为 12–128 个字符。修改后，所有设备都需要重新登录。</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="editor-footer">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '修改中…' : '修改密码'}
          </button>
        </div>
      </form>
      <div className="account-version-info">
        <small className="muted">
          WildString 网页端 v0.8.1{serverVersion ? ` · 服务端 v${serverVersion}` : ''}
        </small>
      </div>
    </dialog>
  );
}

export function UsersPanel() {
  const [libraries, setLibraries] = useState<MusicLibrary[]>([]);
  const [libraryIds, setLibraryIds] = useState<string[] | null>(null);
  const defaultLibraryIds = libraries
    .filter((library) => library.default_access ?? library.is_default)
    .map((library) => library.id);
  const [users, setUsers] = useState<User[]>([]),
    [self, setSelf] = useState<User | null>(null);
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [profile, setProfile] = useState<Profile>('listener');
  const [resetting, setResetting] = useState<User | null>(null),
    [resetPassword, setResetPassword] = useState(''),
    [resetConfirm, setResetConfirm] = useState('');
  const [granting, setGranting] = useState<User | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  async function load(signal?: AbortSignal) {
    const [list, auth] = await Promise.all([
      api<{ items: User[] }>('/manage/users', { signal }),
      api<{ user: User }>('/auth/status', { signal }),
    ]);
    if (signal?.aborted) return;
    setUsers(list.items);
    setSelf(auth.user);
    const available = await api<MusicLibrary[]>('/libraries', { signal }).catch(() => []);
    if (!signal?.aborted) setLibraries(available);
  }
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      void load(controller.signal).catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    };
    refresh();
    window.addEventListener('wildstring:libraries-updated', refresh);
    return () => {
      controller.abort();
      window.removeEventListener('wildstring:libraries-updated', refresh);
    };
  }, []);
  async function act(work: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      await load();
      window.dispatchEvent(new Event('wildstring:users-updated'));
      setNotice(message);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作未完成，请重试。');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (password !== confirmation) {
      setError('两次输入的初始密码不一致。');
      return;
    }
    if (
      await act(
        () =>
          api('/manage/users', {
            method: 'POST',
            body: JSON.stringify({
              username,
              password,
              profile,
              library_ids: libraryIds ?? defaultLibraryIds,
            }),
          }),
        '账号已创建。',
      )
    ) {
      setUsername('');
      setPassword('');
      setConfirmation('');
      setLibraryIds(null);
    }
  }
  function update(user: User, values: { profile?: Profile; enabled?: boolean }) {
    void act(
      () =>
        api(`/manage/users/${user.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            version: user.version,
            profile: values.profile ?? userProfile(user),
            enabled: values.enabled ?? user.enabled,
          }),
        }),
      '账号已更新，旧会话已退出。',
    );
  }
  async function reset(event: FormEvent) {
    event.preventDefault();
    if (!resetting) return;
    if (resetPassword !== resetConfirm) {
      setError('两次输入的重置密码不一致。');
      return;
    }
    if (
      await act(
        () =>
          api(`/manage/users/${resetting.id}/password`, {
            method: 'POST',
            body: JSON.stringify({ version: resetting.version, new_password: resetPassword }),
          }),
        '密码已重置，对方需要重新登录。',
      )
    ) {
      setResetting(null);
      setResetPassword('');
      setResetConfirm('');
    }
  }
  return (
    <section aria-label="用户管理" className="management-users">
      <div className="management-card">
        <h2>用户管理</h2>
        <p className="muted">
          按账号分配音乐库，角色决定可执行的操作。收藏、关注和播放进度各自保存。
        </p>
        {error && (
          <p className="error" role="alert">
            {error}{' '}
            <button
              disabled={busy}
              onClick={() => {
                setResetting(null);
                void act(() => Promise.resolve(), '账号列表已刷新。');
              }}
            >
              重新读取账号
            </button>
          </p>
        )}
        {notice && (
          <p role="status" className="ai-status">
            {notice}
          </p>
        )}
        <div className="account-list-heading" aria-hidden="true">
          <span>账号</span>
          <span>角色</span>
          <span>音乐库</span>
          <span>账号操作</span>
        </div>
        <ul className="account-list" aria-label="账号列表">
          {users.map((user) => (
            <li key={user.id}>
              <div className="account-row-identity">
                <strong>{user.username}</strong>
                <small>
                  {user.enabled ? '已启用' : '已停用'}
                  {self?.id === user.id ? ' · 当前账号' : ''}
                </small>
              </div>
              <select
                className="account-row-role"
                aria-label={`${user.username} 的角色`}
                disabled={busy || !self || self.id === user.id}
                value={userProfile(user)}
                onChange={(e) => update(user, { profile: e.target.value as Profile })}
              >
                <option value="listener">听众</option>
                <option value="editor">资料编辑员</option>
                <option value="librarian">曲库管理员</option>
                <option value="owner">所有者</option>
              </select>
              <button
                className="account-row-access"
                aria-label={`${user.username} 的库权限`}
                title={user.profile === 'owner' ? '所有者始终可以访问全部音乐库' : undefined}
                disabled={busy || !self || user.profile === 'owner'}
                onClick={() => setGranting(user)}
              >
                {user.profile === 'owner' ? '全部音乐库' : '库权限'}
              </button>
              <div className="account-row-actions">
                <button
                  aria-label={`${user.enabled ? '停用' : '启用'} ${user.username}`}
                  disabled={busy || !self || self.id === user.id}
                  onClick={() => update(user, { enabled: !user.enabled })}
                >
                  {user.enabled ? '停用' : '启用'}
                </button>
                <button
                  aria-label={`重置密码 · ${user.username}`}
                  disabled={busy || !self || self.id === user.id}
                  onClick={() => {
                    setResetting(user);
                    setResetPassword('');
                    setResetConfirm('');
                    setError('');
                  }}
                >
                  重置密码
                </button>
              </div>
            </li>
          ))}
        </ul>
        {granting && (
          <UserLibraryAccessDialog
            user={granting}
            onClose={() => setGranting(null)}
            onSaved={() => {
              setNotice(`${granting.username} 的库权限已保存。`);
              setGranting(null);
            }}
          />
        )}
        {resetting && (
          <form
            className="account-form reset-password-form"
            onSubmit={reset}
            aria-label={`重置 ${resetting.username} 的密码`}
          >
            <h3>重置 {resetting.username} 的密码</h3>
            <label>
              重置密码
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
              />
            </label>
            <label>
              确认重置密码
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={resetConfirm}
                onChange={(e) => setResetConfirm(e.target.value)}
              />
            </label>
            <div className="editor-footer">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setResetting(null);
                  setResetPassword('');
                  setResetConfirm('');
                }}
              >
                取消重置
              </button>
              <button className="primary" disabled={busy}>
                确认重置密码
              </button>
            </div>
          </form>
        )}
      </div>
      <form className="management-card account-form" onSubmit={create} aria-label="创建账号">
        <h2>创建账号</h2>
        <label>
          用户名
          <input
            required
            minLength={1}
            maxLength={32}
            pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{0,31}"
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <span className="muted">1–32 位英文字母、数字、点、下划线或连字符；首位为字母或数字。</span>
        <label>
          角色
          <select value={profile} onChange={(e) => setProfile(e.target.value as Profile)}>
            <option value="listener">听众</option>
            <option value="editor">资料编辑员</option>
            <option value="librarian">曲库管理员</option>
            <option value="owner">所有者</option>
          </select>
        </label>
        {profile !== 'owner' && (
          <fieldset className="music-library-options">
            <legend>可访问音乐库</legend>
            {libraries.map((library) => (
              <label key={library.id} className="music-library-grant-option">
                <input
                  type="checkbox"
                  checked={(libraryIds ?? defaultLibraryIds).includes(library.id)}
                  onChange={(event) =>
                    setLibraryIds((values) =>
                      event.target.checked
                        ? [...(values ?? defaultLibraryIds), library.id]
                        : (values ?? defaultLibraryIds).filter((key) => key !== library.id),
                    )
                  }
                />
                <span>{library.name}</span>
              </label>
            ))}
            <small>未勾选时只可使用个人播客关注等功能。</small>
          </fieldset>
        )}
        <label>
          初始密码
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          确认初始密码
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? '处理中…' : '创建账号'}
        </button>
      </form>
    </section>
  );
}
