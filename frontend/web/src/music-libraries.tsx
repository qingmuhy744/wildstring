import { useEffect, useId, useState } from 'react';
import { api, type User } from './api';
import { selectLibrary, selectedLibrary } from './library-context';
import { LibraryStorage } from './library-storage';
import './music-libraries.css';

export interface MusicLibrary {
  id: string;
  name: string;
  enabled: boolean;
  is_default: boolean;
  version: number;
  sources?: { id: string; root: string; watch_enabled?: number }[];
  managed_root?: string;
}
type Access = { version: number; library_ids: string[] };

export function LibrarySwitcher({
  onChanged,
  management = false,
}: {
  onChanged: () => void;
  management?: boolean;
}) {
  const [libraries, setLibraries] = useState<MusicLibrary[]>([]);
  const [selected, setSelected] = useState(selectedLibrary());
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const items = await api<MusicLibrary[]>('/libraries');
        if (!active) return;
        setSupported(true);
        setLibraries(items);
        if (management && selectedLibrary() === 'all' && items[0])
          selectLibrary(items.find((item) => item.is_default)?.id || items[0].id);
        if (selectedLibrary() !== 'all' && !items.some((item) => item.id === selectedLibrary()))
          selectLibrary('all');
        setSelected(selectedLibrary());
      } catch {
        /* Older servers keep their single-library interface. */
      }
    }
    const changed = () => {
      setSelected(selectedLibrary());
      onChanged();
    };
    void load();
    window.addEventListener('focus', load);
    window.addEventListener('wildstring:library-changed', changed);
    window.addEventListener('wildstring:library-access-changed', load);
    window.addEventListener('wildstring:libraries-updated', load);
    const interval = window.setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', load);
      window.removeEventListener('wildstring:library-changed', changed);
      window.removeEventListener('wildstring:library-access-changed', load);
      window.removeEventListener('wildstring:libraries-updated', load);
    };
  }, [onChanged, management]);
  if (!supported) return null;
  return (
    <label className="music-library-switcher">
      音乐库
      <select
        aria-label="选择音乐库"
        value={selected}
        onChange={(event) => selectLibrary(event.target.value)}
      >
        {!management && <option value="all">全部可访问库</option>}
        {libraries.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      {libraries.length === 0 && <small>尚未分配音乐库，可联系所有者授权。</small>}
    </label>
  );
}

export function MusicLibraryManager() {
  const id = useId();
  const [libraries, setLibraries] = useState<MusicLibrary[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [editing, setEditing] = useState<MusicLibrary | null>(null);
  const [name, setName] = useState('');
  const [folders, setFolders] = useState('');
  const [paused, setPaused] = useState<string[]>([]);
  const [managedRoot, setManagedRoot] = useState('');
  const [userId, setUserId] = useState('');
  const [access, setAccess] = useState<Access | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function load() {
    const [items, accounts] = await Promise.all([
      api<MusicLibrary[]>('/libraries?include_disabled=true'),
      api<{ items: User[] }>('/manage/users'),
    ]);
    setLibraries(items);
    setUsers(accounts.items);
    return items;
  }
  useEffect(() => {
    const refresh = () => {
      void load().catch((reason: Error) => setError(reason.message));
    };
    refresh();
    window.addEventListener('wildstring:users-updated', refresh);
    return () => window.removeEventListener('wildstring:users-updated', refresh);
  }, []);
  useEffect(() => {
    setAccess(null);
    if (!userId) return;
    let active = true;
    void api<Access>(`/libraries/access/${encodeURIComponent(userId)}`)
      .then((value) => {
        if (active) setAccess(value);
      })
      .catch((reason: Error) => {
        if (active) setError(reason.message);
      });
    return () => {
      active = false;
    };
  }, [userId]);
  function edit(item: MusicLibrary | null) {
    setEditing(item);
    setName(item?.name || '');
    setFolders(item?.sources?.map((s) => s.root).join('\n') || '');
    setPaused(item?.sources?.filter((s) => s.watch_enabled === 0).map((s) => s.root) || []);
    setManagedRoot('');
    setError('');
    setNotice('');
  }
  async function save(enabled = true) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(`/libraries${editing ? `/${editing.id}` : ''}`, {
        method: editing ? 'PUT' : 'POST',
        body: JSON.stringify({
          name,
          source_roots: folders
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
          paused_source_roots: paused.filter((root) =>
            folders
              .split('\n')
              .map((s) => s.trim())
              .includes(root),
          ),
          ...(!editing && managedRoot.trim() ? { managed_root: managedRoot.trim() } : {}),
          ...(editing ? { version: editing.version, enabled } : {}),
        }),
      });
      edit(null);
      await load();
      setNotice('音乐库已保存。');
      window.dispatchEvent(new Event('wildstring:libraries-updated'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '音乐库保存失败。');
    } finally {
      setBusy(false);
    }
  }
  async function grant() {
    if (!access) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<Access>(`/libraries/access/${encodeURIComponent(userId)}`, {
        method: 'PUT',
        body: JSON.stringify(access),
      });
      setAccess(result);
      setNotice('库权限已保存，对方的新请求会使用新的授权范围。');
      window.dispatchEvent(new Event('wildstring:libraries-updated'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '权限保存失败。');
      setAccess(null);
      const fresh = await api<Access>(`/libraries/access/${encodeURIComponent(userId)}`).catch(
        () => null,
      );
      setAccess(fresh);
    } finally {
      setBusy(false);
    }
  }
  async function reread() {
    const identity = editing?.id;
    if (!identity) return;
    setBusy(true);
    try {
      const items = await load();
      edit(items.find((item) => item.id === identity) || null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '音乐库读取失败。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="management-card music-library-manager" aria-label="音乐库与权限">
      <h2>音乐库与权限</h2>
      <p className="muted">
        每个库可接入多个只读文件夹。导入后使用托管副本，移除来源或停用库会保留已有音乐。
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="music-library-list">
        {libraries.map((item) => (
          <button type="button" key={item.id} onClick={() => edit(item)} disabled={busy}>
            <strong>{item.name}</strong>
            <span>
              {item.sources?.length || 0} 个来源 · {item.enabled ? '启用' : '已停用'}
              {item.is_default ? ' · 默认库' : ''}
            </span>
          </button>
        ))}
        <button type="button" onClick={() => edit(null)} disabled={busy}>
          ＋ 新建音乐库
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h3>{editing ? `编辑「${editing.name}」` : '新建音乐库'}</h3>
        <label htmlFor={`${id}-name`}>库名称</label>
        <input
          id={`${id}-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={100}
          disabled={busy}
        />
        <label htmlFor={`${id}-folders`}>源文件夹，每行一个</label>
        <textarea
          id={`${id}-folders`}
          value={folders}
          onChange={(event) => setFolders(event.target.value)}
          required
          rows={4}
          disabled={busy}
        />
        <fieldset disabled={busy}>
          <legend>监听文件夹</legend>
          {folders
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((root, index) => (
              <label className="music-library-grant-option" key={`${root}:${index}`}>
                <input
                  type="checkbox"
                  checked={!paused.includes(root)}
                  onChange={(e) =>
                    setPaused(
                      e.target.checked ? paused.filter((p) => p !== root) : [...paused, root],
                    )
                  }
                />
                <span className="storage-path">{root}</span>
              </label>
            ))}
          <p className="muted">
            勾选的来源参与自动监听；取消勾选仍可手动导入。自动导入还需启用下方策略。
          </p>
        </fieldset>
        {!editing && (
          <>
            <label htmlFor={`${id}-managed`}>托管目录（可选）</label>
            <input
              id={`${id}-managed`}
              value={managedRoot}
              onChange={(e) => setManagedRoot(e.target.value)}
              placeholder="留空使用默认目录"
              disabled={busy}
            />
            <p className="muted">填写服务端可写的独立空目录。Docker 使用容器内已挂载的路径。</p>
          </>
        )}
        <div className="music-library-actions">
          <button type="submit" disabled={busy}>
            {busy ? '保存中…' : '保存音乐库'}
          </button>
          {editing && !editing.is_default && (
            <button type="button" disabled={busy} onClick={() => void save(!editing.enabled)}>
              {editing.enabled ? '停用并保留音乐' : '重新启用'}
            </button>
          )}
          {editing && (
            <button type="button" disabled={busy} onClick={() => void reread()}>
              重新读取配置
            </button>
          )}
        </div>
      </form>
      {editing && <LibraryStorage library={editing} onChanged={reread} />}
      <div className="music-library-grants">
        <h3>用户可访问的库</h3>
        <label htmlFor={`${id}-user`}>选择用户</label>
        <select
          id={`${id}-user`}
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          disabled={busy}
        >
          <option value="">选择需要授权的用户</option>
          {users
            .filter((user) => user.profile !== 'owner')
            .map((user) => (
              <option key={user.id} value={user.id}>
                {user.display_name || user.username}
              </option>
            ))}
        </select>
        <fieldset disabled={!access || busy}>
          <legend>允许访问</legend>
          {libraries
            .filter((item) => item.enabled)
            .map((item) => (
              <label key={item.id} className="music-library-grant-option">
                <input
                  type="checkbox"
                  checked={access?.library_ids.includes(item.id) || false}
                  onChange={(event) =>
                    setAccess(
                      (value) =>
                        value && {
                          ...value,
                          library_ids: event.target.checked
                            ? [...value.library_ids, item.id]
                            : value.library_ids.filter((key) => key !== item.id),
                        },
                    )
                  }
                />
                {item.name}
              </label>
            ))}
        </fieldset>
        <p className="muted">编辑和管理能力由账号角色决定。所有者始终可以访问全部库。</p>
        <button type="button" onClick={() => void grant()} disabled={busy || !access}>
          保存库权限
        </button>
      </div>
    </section>
  );
}
