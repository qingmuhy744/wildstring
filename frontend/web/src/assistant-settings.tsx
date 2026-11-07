import { useState } from 'react';
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
  const [tab, setTab] = useState(initialTab);
  return (
    <section className="workspace-page" aria-label="助手与通知设置">
      {!embedded && (
        <WorkspaceHeader
          title="助手设置"
          description="选择模型、授权范围和结果通知；关闭外部服务后，音乐仍照常播放。"
        />
      )}
      <nav className="settings-tabs" aria-label="助手设置分类">
        {[
          ['connections', '模型连接'],
          ['application', '整理方式'],
          ['telegram', '通知与 Telegram'],
          ['credentials', 'MCP 工具凭据'],
          ['history', '对话历史'],
          ['research', '联网与记忆'],
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
