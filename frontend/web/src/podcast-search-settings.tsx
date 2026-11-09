import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { regionName } from './podcast-search';

export type PodcastSearchSettingsValue = {
  version: number;
  regions: string[];
  custom_regions: boolean;
  default_regions: string[];
  filter_explicit: boolean;
  supported_regions: string[];
  max_regions: number;
  can_manage: boolean;
};

const URL = '/podcasts/search-settings';

export function PodcastSearchSettings() {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<PodcastSearchSettingsValue | null>(null);
  const [regions, setRegions] = useState<string[]>([]);
  const [filterExplicit, setFilterExplicit] = useState(false);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const apply = (value: PodcastSearchSettingsValue) => {
    setSaved(value);
    setRegions(value.regions);
    setFilterExplicit(value.filter_explicit);
  };

  useEffect(() => {
    let active = true;
    void api<PodcastSearchSettingsValue>(URL)
      .then((value) => {
        if (active) apply(value);
      })
      .catch((error: Error) => {
        if (active) setMessage(error.message);
      });
    return () => {
      active = false;
    };
  }, []);

  if (saved && !saved.can_manage) return null;

  async function save(nextRegions: string[] | null) {
    if (!saved) return;
    setBusy(true);
    setMessage('');
    try {
      apply(
        await api<PodcastSearchSettingsValue>(URL, {
          method: 'PUT',
          body: JSON.stringify({
            version: saved.version,
            regions: nextRegions,
            filter_explicit: filterExplicit,
          }),
        }),
      );
      setMessage(t('podcastSearchSettings.saveSuccess'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('podcastSearchSettings.saveFailed'));
      const fresh = await api<PodcastSearchSettingsValue>(URL).catch(() => null);
      if (fresh) apply(fresh);
    } finally {
      setBusy(false);
    }
  }

  const move = (index: number, delta: number) =>
    setRegions((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item);
      return next;
    });

  const available = saved ? saved.supported_regions.filter((code) => !regions.includes(code)) : [];
  const isDefault =
    saved !== null &&
    regions.join(',') === saved.default_regions.join(',') &&
    !saved.custom_regions;

  return (
    <section className="management-card" aria-label={t('podcastSearchSettings.cardTitle')}>
      <h2>{t('podcastSearchSettings.cardTitle')}</h2>
      <p className="muted">{t('podcastSearchSettings.description')}</p>
      {saved && (
        <>
          <ol
            className="podcast-search-settings-regions"
            aria-label={t('podcastSearchSettings.regionsAriaLabel')}
          >
            {regions.map((code, index) => (
              <li key={code}>
                <span>
                  {regionName(code)} <small>{code.toUpperCase()}</small>
                </span>
                <button
                  type="button"
                  aria-label={t('podcastSearchSettings.moveUp', { region: regionName(code) })}
                  disabled={busy || index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={t('podcastSearchSettings.moveDown', { region: regionName(code) })}
                  disabled={busy || index === regions.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={t('podcastSearchSettings.removeRegion', { region: regionName(code) })}
                  disabled={busy || regions.length === 1}
                  onClick={() => setRegions(regions.filter((item) => item !== code))}
                >
                  {t('podcastSearchSettings.remove')}
                </button>
              </li>
            ))}
          </ol>
          <div className="podcast-search-settings-add">
            <label>
              <span>{t('podcastSearchSettings.addRegionLabel')}</span>
              <select
                value={adding}
                disabled={busy || regions.length >= saved.max_regions}
                onChange={(event) => setAdding(event.target.value)}
              >
                <option value="">{t('podcastSearchSettings.selectRegionPrompt')}</option>
                {available.map((code) => (
                  <option key={code} value={code}>
                    {t('podcastSearchSettings.regionOption', {
                      region: regionName(code),
                      code: code.toUpperCase(),
                    })}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy || !adding || regions.length >= saved.max_regions}
              onClick={() => {
                setRegions([...regions, adding]);
                setAdding('');
              }}
            >
              {t('podcastSearchSettings.add')}
            </button>
          </div>
          <p className="muted">
            {t('podcastSearchSettings.maxRegionsNotice', {
              max: saved.max_regions,
              defaults: saved.default_regions
                .map(regionName)
                .join(t('podcastSearchSettings.regionSeparator')),
              currentDefault: isDefault ? t('podcastSearchSettings.currentUsingDefault') : '',
            })}
          </p>
          <label className="music-library-grant-option">
            <input
              type="checkbox"
              checked={filterExplicit}
              disabled={busy}
              onChange={(event) => setFilterExplicit(event.target.checked)}
            />
            <span>{t('podcastSearchSettings.filterExplicit')}</span>
          </label>
          <p className="muted">{t('podcastSearchSettings.filterExplicitHelp')}</p>
          <div className="podcast-search-settings-actions">
            <button type="button" disabled={busy} onClick={() => void save(regions)}>
              {busy ? t('podcastSearchSettings.saving') : t('podcastSearchSettings.saveButton')}
            </button>
            <button type="button" disabled={busy} onClick={() => void save(null)}>
              {t('podcastSearchSettings.restoreDefault')}
            </button>
          </div>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
