import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import type { AgentPage, Delivery, NotificationPreferences, TelegramTarget } from './agent-api';
import {
  DiagnosticId,
  errorText,
  localDate,
  StateBadge,
  useWorkspaceResource,
  WorkspaceNotice,
} from './workspace-ui';
import { WorkspacePagination } from './agent-workbench';
const events: Record<string, string> = {
  'task.completed': '任务完成',
  'task.failed': '任务失败',
  'task.partial': '部分完成',
  'task.paused': '任务暂停，需要处理',
  'draft.pending': '草案待确认',
  'draft.applied': '草案已应用',
  'dependency.changed': '外部依赖状态变化',
};
export function TelegramSettings() {
  const targets = useWorkspaceResource<AgentPage<TelegramTarget>>(
      '/agent/telegram-targets?limit=100',
    ),
    preferences = useWorkspaceResource<NotificationPreferences>('/agent/notification-preferences');
  const [offset, setOffset] = useState(0),
    deliveries = useWorkspaceResource<AgentPage<Delivery>>(
      `/agent/deliveries?limit=20&offset=${offset}`,
    );
  const [name, setName] = useState('我的 Telegram'),
    [token, setToken] = useState(''),
    [chat, setChat] = useState(''),
    [topic, setTopic] = useState(''),
    [proxy, setProxy] = useState('inherit'),
    [codes, setCodes] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [prefs, setPrefs] = useState<NotificationPreferences>({
    telegram_enabled: false,
    event_types: [],
    min_severity: 'info',
    quiet_start: null,
    quiet_end: null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
  });
  useEffect(() => {
    if (preferences.value) setPrefs(preferences.value);
  }, [preferences.value]);
  async function perform(path: string, method: string, body: unknown, message: string) {
    if (busy) return false;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(path, { method, ...(body === null ? {} : { body: JSON.stringify(body) }) });
      setNotice(message);
      await Promise.all([targets.reload(), deliveries.reload(), preferences.reload()]);
      return true;
    } catch (reason) {
      setError(errorText(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    if (
      await perform(
        '/agent/telegram-targets',
        'POST',
        {
          name,
          bot_token: token,
          chat_id: chat,
          topic_id: topic ? Number(topic) : null,
          proxy_mode: proxy,
          enabled: false,
        },
        '目标已保存，先发送验证码并回填，验证后才能接收私人结果。',
      )
    ) {
      setToken('');
      setChat('');
      setTopic('');
    }
  }
  return (
    <>
      <section className="workspace-card" aria-label="Telegram 通知设置">
        <div className="workspace-card-head">
          <div>
            <h2>Telegram 通知</h2>
            <p className="muted">
              站内通知始终可用。Telegram 是可选的出站渠道，所有修改仍在野弦内确认。
            </p>
          </div>
          <button
            disabled={targets.loading || busy}
            onClick={() => {
              void targets.reload();
              void deliveries.reload();
            }}
          >
            刷新渠道
          </button>
        </div>
        <WorkspaceNotice
          error={error || targets.error || preferences.error || deliveries.error}
          notice={notice}
          unavailable={targets.unsupported}
        />
        {!targets.unsupported && (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void perform('/agent/notification-preferences', 'PUT', prefs, '通知订阅已保存。');
              }}
            >
              <h3>订阅偏好</h3>
              <div className="workspace-form">
                <label className="workspace-check span-all">
                  <input
                    type="checkbox"
                    checked={prefs.telegram_enabled}
                    onChange={(e) => setPrefs({ ...prefs, telegram_enabled: e.target.checked })}
                  />
                  启用 Telegram 结果通知
                </label>
                <label>
                  最低提醒级别
                  <select
                    value={prefs.min_severity}
                    onChange={(e) => setPrefs({ ...prefs, min_severity: e.target.value })}
                  >
                    <option value="info">全部结果</option>
                    <option value="warning">需要留意及错误</option>
                    <option value="error">仅错误</option>
                  </select>
                </label>
                <label>
                  静默时区
                  <input
                    required
                    value={prefs.timezone}
                    onChange={(e) => setPrefs({ ...prefs, timezone: e.target.value })}
                  />
                </label>
                <label>
                  静默开始
                  <input
                    type="time"
                    value={prefs.quiet_start || ''}
                    onChange={(e) => setPrefs({ ...prefs, quiet_start: e.target.value || null })}
                  />
                </label>
                <label>
                  静默结束
                  <input
                    type="time"
                    value={prefs.quiet_end || ''}
                    onChange={(e) => setPrefs({ ...prefs, quiet_end: e.target.value || null })}
                  />
                </label>
                <fieldset className="span-all">
                  <legend>事件（不选则接收所有符合级别的结果）</legend>
                  <div className="workspace-check-grid">
                    {Object.entries(events).map(([key, label]) => (
                      <label className="workspace-check" key={key}>
                        <input
                          type="checkbox"
                          checked={prefs.event_types.includes(key)}
                          onChange={(e) =>
                            setPrefs({
                              ...prefs,
                              event_types: e.target.checked
                                ? [...prefs.event_types, key]
                                : prefs.event_types.filter((type) => type !== key),
                            })
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="span-all">
                  <button disabled={busy || !preferences.value}>保存通知偏好</button>
                </div>
              </div>
            </form>
            <h3>接收目标</h3>
            {targets.value?.items.map((target) => (
              <article className="telegram-target workspace-card" key={target.id}>
                <div className="workspace-card-head">
                  <div>
                    <h3>{target.name}</h3>
                    <small>
                      {target.verified ? '目标已验证' : '等待目标验证'} ·{' '}
                      {target.enabled ? '已开启' : '已关闭'}
                    </small>
                  </div>
                  <div className="workspace-actions">
                    {target.verified && (
                      <>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void perform(
                              `/agent/telegram-targets/${target.id}`,
                              'PATCH',
                              { version: target.version, enabled: !target.enabled },
                              target.enabled ? '目标已关闭。' : '目标已开启。',
                            )
                          }
                        >
                          {target.enabled ? '关闭目标' : '开启目标'}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void perform(
                              `/agent/telegram-targets/${target.id}/test`,
                              'POST',
                              {},
                              '测试消息已提交；接口确认不代表已读。',
                            )
                          }
                        >
                          发送测试消息
                        </button>
                      </>
                    )}
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (confirm(`删除目标“${target.name}”？尚未发送的投递会取消。`))
                          void perform(
                            `/agent/telegram-targets/${target.id}`,
                            'DELETE',
                            null,
                            '接收目标已删除。',
                          );
                      }}
                    >
                      删除目标
                    </button>
                  </div>
                </div>
                {!target.verified && (
                  <div className="workspace-inline">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void perform(
                          `/agent/telegram-targets/${target.id}/verify-send`,
                          'POST',
                          {},
                          '验证码已向该目标发送，请在 Telegram 中查看并回填。',
                        )
                      }
                    >
                      发送验证消息
                    </button>
                    <label>
                      验证码
                      <input
                        aria-label={`${target.name} 的验证码`}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={16}
                        value={codes[target.id] || ''}
                        onChange={(e) => setCodes({ ...codes, [target.id]: e.target.value })}
                      />
                    </label>
                    <button
                      disabled={busy || !codes[target.id]?.trim()}
                      onClick={() =>
                        void perform(
                          `/agent/telegram-targets/${target.id}/verify`,
                          'POST',
                          { code: codes[target.id] },
                          '目标验证成功，已启用接收。',
                        )
                      }
                    >
                      确认验证码
                    </button>
                  </div>
                )}
              </article>
            ))}
            <details>
              <summary>添加 Telegram 接收目标</summary>
              <form onSubmit={(e) => void create(e)} className="workspace-form">
                <label>
                  目标名称
                  <input
                    aria-label="Telegram 目标名称"
                    required
                    maxLength={100}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label>
                  Bot Token
                  <input
                    aria-label="Telegram Bot Token"
                    type="password"
                    autoComplete="new-password"
                    required
                    maxLength={256}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </label>
                <label>
                  Chat ID
                  <input
                    aria-label="Telegram Chat ID"
                    required
                    maxLength={80}
                    value={chat}
                    onChange={(e) => setChat(e.target.value)}
                  />
                </label>
                <label>
                  Topic ID（可选）
                  <input
                    aria-label="Telegram Topic ID"
                    type="number"
                    min={1}
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                  />
                </label>
                <label>
                  连接策略
                  <select
                    aria-label="Telegram 代理策略"
                    value={proxy}
                    onChange={(e) => setProxy(e.target.value)}
                  >
                    <option value="inherit">跟随服务端网络代理</option>
                    <option value="direct">直接连接</option>
                  </select>
                </label>
                <div className="span-all">
                  <button className="primary" disabled={busy}>
                    保存待验证目标
                  </button>
                  <p className="muted">
                    保存不会发送消息。请显式发送验证消息，验证码只会出现在目标聊天中。
                  </p>
                </div>
              </form>
            </details>
          </>
        )}
      </section>
      {!targets.unsupported && (
        <section className="workspace-card" aria-label="Telegram 投递记录">
          <h2>外部投递记录</h2>
          <p className="muted">
            “接口已确认发送”不代表已读。结果不明时先核对 Telegram，显式重试可能产生重复消息。
          </p>
          {deliveries.value?.items.map((item) => (
            <div className="workspace-row" key={item.id}>
              <div className="workspace-row-main">
                <strong>
                  {targets.value?.items.find((target) => target.id === item.target_id)?.name ||
                    '已撤销目标'}
                </strong>
                <small>
                  尝试 {item.attempt} 次
                  {item.next_attempt_at ? ` · 下次 ${localDate(item.next_attempt_at)}` : ''}
                  {item.error_code ? ` · ${item.error_code}` : ''}
                </small>
                <DiagnosticId id={item.trace_id} />
              </div>
              <StateBadge state={item.status} />
              {['failed', 'unknown'].includes(item.status) && (
                <button
                  disabled={busy}
                  onClick={() => {
                    if (
                      item.status === 'unknown' &&
                      !confirm('消息可能已发送。请先在 Telegram 中核对，仍要重试吗？')
                    )
                      return;
                    void perform(
                      `/agent/deliveries/${item.id}/retry`,
                      'POST',
                      { ...(item.status === 'unknown' ? { acknowledge_unknown: true } : {}) },
                      '已提交重试；业务任务结果保持不变。',
                    );
                  }}
                >
                  重试投递
                </button>
              )}
            </div>
          ))}
          {!deliveries.value?.items.length && (
            <p className="workspace-empty">还没有外部投递记录。</p>
          )}
          <WorkspacePagination
            total={deliveries.value?.total || 0}
            offset={offset}
            onOffset={setOffset}
          />
        </section>
      )}
    </>
  );
}
