import { useEffect, useState } from 'react';
import { api } from './api';

type CatalogPolicy = { version: number; allow_user_subscriptions: boolean; can_add: boolean };

export function useCanAddPodcast(userId: string, canManage: boolean) {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () =>
      void api<CatalogPolicy>('/podcasts/catalog-settings')
        .then((policy) => {
          if (active) setAllowed(policy.can_add);
        })
        .catch(() => {
          if (active) setAllowed(false);
        });
    load();
    window.addEventListener('focus', load);
    return () => {
      active = false;
      window.removeEventListener('focus', load);
    };
  }, [userId]);
  return canManage || allowed;
}

export function PodcastCatalogSettings() {
  const [policy, setPolicy] = useState<CatalogPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void api<CatalogPolicy>('/podcasts/catalog-settings')
      .then((value) => {
        if (active) setPolicy(value);
      })
      .catch((error: Error) => {
        if (active) setMessage(error.message);
      });
    return () => {
      active = false;
    };
  }, []);
  async function save() {
    if (!policy) return;
    setBusy(true);
    setMessage('');
    try {
      setPolicy(
        await api<CatalogPolicy>('/podcasts/catalog-settings', {
          method: 'PUT',
          body: JSON.stringify({
            version: policy.version,
            allow_user_subscriptions: policy.allow_user_subscriptions,
          }),
        }),
      );
      setMessage('播客添加权限已保存。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
      setPolicy(await api<CatalogPolicy>('/podcasts/catalog-settings').catch(() => null));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="management-card" aria-label="播客添加权限">
      <h2>播客添加权限</h2>
      <p className="muted">
        控制普通用户是否可以通过 RSS
        添加节目并关注。节目和音频由服务器共享，关注和收听进度属于个人。
      </p>
      {policy && (
        <>
          <label className="music-library-grant-option">
            <input
              type="checkbox"
              checked={policy.allow_user_subscriptions}
              disabled={busy}
              onChange={(event) =>
                setPolicy({ ...policy, allow_user_subscriptions: event.target.checked })
              }
            />
            <span>允许普通用户添加 RSS 并关注</span>
          </label>
          <p className="muted">
            关闭后仍可关注本服已有节目。全服更新、存储策略和删除节目继续由管理员管理。
          </p>
          <button type="button" disabled={busy} onClick={() => void save()}>
            {busy ? '保存中…' : '保存播客添加权限'}
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
