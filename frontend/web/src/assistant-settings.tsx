import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApplicationPolicySettings } from './application-policy';
import type { User } from './api';
import { AgentConnections, AssistantPreferences, ToolCredentials } from './agent-settings';
import { TelegramSettings } from './telegram-settings';
import { WorkspaceHeader } from './workspace-ui';
import { ResearchSettings } from './assistant-research';
export type AssistantSettingsTab =
  'connections' | 'application' | 'telegram' | 'credentials' | 'history' | 'research';
export function AssistantSettings({
  user,
  initialTab = 'connections',
  embedded = false,
}: {
  user: User;
  initialTab?: AssistantSettingsTab;
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState(initialTab);
  return (
    <section className="workspace-page" aria-label={t('assistantSettings.ariaLabel')}>
      {!embedded && (
        <WorkspaceHeader
          title={t('assistantSettings.title')}
          description={t('assistantSettings.description')}
        />
      )}
      <nav className="settings-tabs" aria-label={t('assistantSettings.tabsAriaLabel')}>
        {[
          ['connections', t('assistantSettings.tabConnections')],
          ['application', t('assistantSettings.tabApplication')],
          ['telegram', t('assistantSettings.tabTelegram')],
          ['credentials', t('assistantSettings.tabCredentials')],
          ['history', t('assistantSettings.tabHistory')],
          ['research', t('assistantSettings.tabResearch')],
        ].map(([key, label]) => (
          <button
            key={key}
            aria-pressed={tab === key}
            onClick={() => setTab(key as AssistantSettingsTab)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === 'connections' && <AgentConnections user={user} />}{' '}
      {tab === 'telegram' && <TelegramSettings />}
      {tab === 'credentials' && <ToolCredentials user={user} />}{' '}
      {tab === 'history' && <AssistantPreferences />}
      {tab === 'application' && <ApplicationPolicySettings />}
      {tab === 'research' && <ResearchSettings />}
    </section>
  );
}
