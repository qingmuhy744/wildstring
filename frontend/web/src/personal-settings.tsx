import { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type User } from './api';
import { AccountSettings, LanguageControl } from './accounts';
import { ThemeControl } from './theme';
import { PlaybackStyleControl } from './playback-style';
import { RadioClickControl } from './radio-click';
import { TrackListSizeControl } from './track-list-size';
import { LyricPreferenceControls } from './lyric-preferences';
import { OfflineSettings } from './offline-panel';
import { Devices } from './discover';
import type { AssistantSettingsTab } from './assistant-settings';
import { SettingsLayout, type SettingsCategory } from './settings-layout';
import type { Player } from './player';
import { version } from '../package.json';

const AssistantSettings = lazy(() =>
  import('./assistant-settings').then((module) => ({ default: module.AssistantSettings })),
);

export type PersonalSection =
  'account' | 'appearance' | 'playback' | 'downloads' | 'assistant' | 'about';
function AboutSettings() {
  const { t } = useTranslation();
  const [serverVersion, setServerVersion] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<{ version: string }>('/auth/status', { signal: controller.signal })
      .then((status) => setServerVersion(status.version))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);
  return (
    <div className="management-card">
      <h2>野弦 / WildString</h2>
      <p>{t('account.versionWeb', { version })}</p>
      {serverVersion && (
        <p>{t('account.versionServer', { version: serverVersion }).replace(/^ · /, '')}</p>
      )}
      {failed && (
        <p role="status" className="muted">
          {t('settings.serverVersionFailed')}
        </p>
      )}
    </div>
  );
}
export function PersonalSettings({
  user,
  player,
  initialSection,
  initialAssistantTab,
  onUserChange,
  onBack,
  onPodcasts,
}: {
  user: User;
  player: Player;
  initialSection: PersonalSection | null;
  initialAssistantTab?: AssistantSettingsTab;
  onUserChange: (user: User) => void;
  onBack: () => void;
  onPodcasts: () => void;
}) {
  const { t } = useTranslation();
  const [section, setSection] = useState<PersonalSection | null>(initialSection);
  const categories: SettingsCategory[] = [
    { id: 'account', icon: 'artist' },
    { id: 'appearance', icon: 'album' },
    { id: 'playback', icon: 'music' },
    { id: 'downloads', icon: 'download' },
    { id: 'assistant', icon: 'assistant' },
    { id: 'about', icon: 'info' },
  ].map((item) => ({
    ...item,
    label: t(`settings.${item.id}`),
    description: t(`settings.${item.id}Description`),
  })) as SettingsCategory[];
  return (
    <main className="library personal-settings">
      <SettingsLayout
        title={t('settings.personal')}
        categories={categories}
        selected={section}
        onSelect={(id) => setSection(id as PersonalSection | null)}
        onBack={onBack}
      >
        {section === 'account' && <AccountSettings user={user} onUserChange={onUserChange} />}
        {section === 'appearance' && (
          <>
            <p className="settings-scope">{t('settings.languageScope')}</p>
            <LanguageControl user={user} onUserChange={onUserChange} />
            <ThemeControl />
            <TrackListSizeControl />
          </>
        )}
        {section === 'playback' && (
          <>
            <p className="settings-scope">{t('settings.localScope')}</p>
            <PlaybackStyleControl />
            <RadioClickControl />
            <LyricPreferenceControls />
          </>
        )}
        {section === 'downloads' && (
          <>
            <p className="settings-scope">{t('settings.localScope')}</p>
            <OfflineSettings userId={user.id} />
            <section className="management-card">
              <h2>{t('settings.podcastDownloads')}</h2>
              <p className="muted">{t('settings.podcastDownloadsDescription')}</p>
              <button onClick={onPodcasts}>{t('settings.openPodcasts')}</button>
            </section>
            <Devices player={player} user={user} />
          </>
        )}
        {section === 'assistant' && (
          <Suspense fallback={<p role="status">{t('settings.loadingAssistant')}</p>}>
            <AssistantSettings user={user} initialTab={initialAssistantTab} embedded />
          </Suspense>
        )}
        {section === 'about' && <AboutSettings />}
      </SettingsLayout>
    </main>
  );
}
