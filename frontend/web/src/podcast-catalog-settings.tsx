import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
      setMessage(t('podcastCatalogSettings.saveSuccess'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('podcastCatalogSettings.saveFailed'));
      setPolicy(await api<CatalogPolicy>('/podcasts/catalog-settings').catch(() => null));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="management-card" aria-label={t('podcastCatalogSettings.cardTitle')}>
      <h2>{t('podcastCatalogSettings.cardTitle')}</h2>
      <p className="muted">{t('podcastCatalogSettings.description')}</p>
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
            <span>{t('podcastCatalogSettings.allowUserSubscriptions')}</span>
          </label>
          <p className="muted">{t('podcastCatalogSettings.allowUserSubscriptionsHelp')}</p>
          <button type="button" disabled={busy} onClick={() => void save()}>
            {busy ? t('podcastCatalogSettings.saving') : t('podcastCatalogSettings.saveButton')}
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
