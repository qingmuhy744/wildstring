import { useState } from 'react';
import type { User } from './api';
import { AgentConnections, AssistantPreferences, ToolCredentials } from './agent-settings';
import { TelegramSettings } from './telegram-settings';
import { WorkspaceHeader } from './workspace-ui';
export function AssistantSettings({ user }: { user: User }) {
  const [tab, setTab] = useState('connections');
  return (
    <section className="workspace-page" aria-label="助手与通知设置">
      <WorkspaceHeader
        eyebrow="YOUR CHOICES, YOUR CONTROL"
        title="让助手，按你的方式工作。"
        description="选择模型、授权范围和结果通知；关闭外部服务后，音乐仍照常播放。"
      />
      <nav className="workspace-tabs" aria-label="助手设置分类">
        {[
          ['connections', '模型连接'],
          ['telegram', '通知与 Telegram'],
          ['credentials', 'MCP 工具凭据'],
          ['history', '对话历史'],
        ].map(([key, label]) => (
          <button key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === 'connections' && <AgentConnections user={user} />}{' '}
      {tab === 'telegram' && <TelegramSettings />}
      {tab === 'credentials' && <ToolCredentials user={user} />}{' '}
      {tab === 'history' && <AssistantPreferences />}
    </section>
  );
}
