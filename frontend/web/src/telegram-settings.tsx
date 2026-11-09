import { HelpLabel } from './desktop-help';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
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

export function TelegramSettings() {
  const { t } = useTranslation();
  const targets = useWorkspaceResource<AgentPage<TelegramTarget>>(
      '/agent/telegram-targets?limit=100',
    ),
    preferences = useWorkspaceResource<NotificationPreferences>('/agent/notification-preferences');
  const [offset, setOffset] = useState(0),
    deliveries = useWorkspaceResource<AgentPage<Delivery>>(
      `/agent/deliveries?limit=20&offset=${offset}`,
    );
  const [name, setName] = useState(() => t('telegramSettings.defaultName')),
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

  const eventKeys: [string, string][] = [
    ['task.completed', t('telegramSettings.event_task_completed')],
    ['task.failed', t('telegramSettings.event_task_failed')],
    ['task.partial', t('telegramSettings.event_task_partial')],
    ['task.paused', t('telegramSettings.event_task_paused')],
    ['draft.pending', t('telegramSettings.event_draft_pending')],
    ['draft.applied', t('telegramSettings.event_draft_applied')],
    ['dependency.changed', t('telegramSettings.event_dependency_changed')],
  ];

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
        t('telegramSettings.targetSavedNotice'),
      )
    ) {
      setToken('');
      setChat('');
      setTopic('');
    }
  }
  return (
    <>
      <section className="workspace-card" aria-label={t('telegramSettings.sectionAria')}>
        <div className="workspace-card-head">
          <div>
            <h2>{t('telegramSettings.title')}</h2>
            <p className="muted">{t('telegramSettings.description')}</p>
          </div>
          <button
            disabled={targets.loading || busy}
            onClick={() => {
              void targets.reload();
              void deliveries.reload();
            }}
          >
            {t('telegramSettings.refreshChannels')}
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
                void perform(
                  '/agent/notification-preferences',
                  'PUT',
                  prefs,
                  t('telegramSettings.prefsSavedNotice'),
                );
              }}
            >
              <h3>{t('telegramSettings.subscriptionTitle')}</h3>
              <div className="workspace-form">
                <label className="workspace-check span-all">
                  <input
                    type="checkbox"
                    checked={prefs.telegram_enabled}
                    onChange={(e) => setPrefs({ ...prefs, telegram_enabled: e.target.checked })}
                  />
                  {t('telegramSettings.enableNotifications')}
                </label>
                <label>
                  {t('telegramSettings.minSeverityLabel')}
                  <select
                    value={prefs.min_severity}
                    onChange={(e) => setPrefs({ ...prefs, min_severity: e.target.value })}
                  >
                    <option value="info">{t('telegramSettings.severityInfo')}</option>
                    <option value="warning">{t('telegramSettings.severityWarning')}</option>
                    <option value="error">{t('telegramSettings.severityError')}</option>
                  </select>
                </label>
                <label>
                  <HelpLabel hint="telegramQuiet">{t('telegramSettings.quietTimezone')}</HelpLabel>
                  <input
                    required
                    value={prefs.timezone}
                    onChange={(e) => setPrefs({ ...prefs, timezone: e.target.value })}
                  />
                </label>
                <label>
                  {t('telegramSettings.quietStart')}
                  <input
                    type="time"
                    value={prefs.quiet_start || ''}
                    onChange={(e) => setPrefs({ ...prefs, quiet_start: e.target.value || null })}
                  />
                </label>
                <label>
                  {t('telegramSettings.quietEnd')}
                  <input
                    type="time"
                    value={prefs.quiet_end || ''}
                    onChange={(e) => setPrefs({ ...prefs, quiet_end: e.target.value || null })}
                  />
                </label>
                <fieldset className="span-all">
                  <legend>{t('telegramSettings.eventsLegend')}</legend>
                  <div className="workspace-check-grid">
                    {eventKeys.map(([key, label]) => (
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
                  <button disabled={busy || !preferences.value}>
                    {t('telegramSettings.savePreferences')}
                  </button>
                </div>
              </div>
            </form>
            <h3>{t('telegramSettings.targetsTitle')}</h3>
            {targets.value?.items.map((target) => (
              <article className="telegram-target workspace-card" key={target.id}>
                <div className="workspace-card-head">
                  <div>
                    <h3>{target.name}</h3>
                    <small>
                      {target.verified
                        ? t('telegramSettings.targetVerified')
                        : t('telegramSettings.targetPendingVerification')}{' '}
                      ·{' '}
                      {target.enabled
                        ? t('telegramSettings.targetEnabled')
                        : t('telegramSettings.targetDisabled')}
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
                              target.enabled
                                ? t('telegramSettings.targetClosedNotice')
                                : t('telegramSettings.targetOpenedNotice'),
                            )
                          }
                        >
                          {target.enabled
                            ? t('telegramSettings.closeTarget')
                            : t('telegramSettings.openTarget')}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void perform(
                              `/agent/telegram-targets/${target.id}/test`,
                              'POST',
                              {},
                              t('telegramSettings.testSentNotice'),
                            )
                          }
                        >
                          {t('telegramSettings.sendTestMessage')}
                        </button>
                      </>
                    )}
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (confirm(t('telegramSettings.confirmDelete', { name: target.name })))
                          void perform(
                            `/agent/telegram-targets/${target.id}`,
                            'DELETE',
                            null,
                            t('telegramSettings.targetDeletedNotice'),
                          );
                      }}
                    >
                      {t('telegramSettings.deleteTarget')}
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
                          t('telegramSettings.verifyCodeSentNotice'),
                        )
                      }
                    >
                      {t('telegramSettings.sendVerifyMessage')}
                    </button>
                    <label>
                      {t('telegramSettings.verifyCodeLabel')}
                      <input
                        aria-label={t('telegramSettings.verifyCodeAria', { name: target.name })}
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
                          t('telegramSettings.verifySuccessNotice'),
                        )
                      }
                    >
                      {t('telegramSettings.confirmVerifyCode')}
                    </button>
                  </div>
                )}
              </article>
            ))}
            <details>
              <summary>{t('telegramSettings.addTargetSummary')}</summary>
              <form onSubmit={(e) => void create(e)} className="workspace-form">
                <label>
                  {t('telegramSettings.targetNameLabel')}
                  <input
                    aria-label={t('telegramSettings.targetNameAria')}
                    required
                    maxLength={100}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label>
                  {t('telegramSettings.botTokenLabel')}
                  <input
                    aria-label={t('telegramSettings.botTokenAria')}
                    type="password"
                    autoComplete="new-password"
                    required
                    maxLength={256}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </label>
                <label>
                  <HelpLabel hint="telegramTarget">{t('telegramSettings.chatIdLabel')}</HelpLabel>
                  <input
                    aria-label={t('telegramSettings.chatIdAria')}
                    required
                    maxLength={80}
                    value={chat}
                    onChange={(e) => setChat(e.target.value)}
                  />
                </label>
                <label>
                  <HelpLabel hint="telegramTarget">{t('telegramSettings.topicIdLabel')}</HelpLabel>
                  <input
                    aria-label={t('telegramSettings.topicIdAria')}
                    type="number"
                    min={1}
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                  />
                </label>
                <label>
                  {t('telegramSettings.proxyPolicyLabel')}
                  <select
                    aria-label={t('telegramSettings.proxyPolicyAria')}
                    value={proxy}
                    onChange={(e) => setProxy(e.target.value)}
                  >
                    <option value="inherit">{t('telegramSettings.proxyInherit')}</option>
                    <option value="direct">{t('telegramSettings.proxyDirect')}</option>
                  </select>
                </label>
                <div className="span-all">
                  <button className="primary" disabled={busy}>
                    {t('telegramSettings.saveTargetButton')}
                  </button>
                  <p className="muted">{t('telegramSettings.saveTargetHint')}</p>
                </div>
              </form>
            </details>
          </>
        )}
      </section>
      {!targets.unsupported && (
        <section
          className="workspace-card"
          aria-label={t('telegramSettings.deliveriesSectionAria')}
        >
          <h2>{t('telegramSettings.deliveriesTitle')}</h2>
          <p className="muted">{t('telegramSettings.deliveriesDescription')}</p>
          {deliveries.value?.items.map((item) => (
            <div className="workspace-row" key={item.id}>
              <div className="workspace-row-main">
                <strong>
                  {targets.value?.items.find((target) => target.id === item.target_id)?.name ||
                    t('telegramSettings.revokedTarget')}
                </strong>
                <small>
                  {t('telegramSettings.attemptCount', { count: item.attempt })}
                  {item.next_attempt_at
                    ? t('telegramSettings.nextAttempt', { date: localDate(item.next_attempt_at) })
                    : ''}
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
                      !confirm(t('telegramSettings.confirmRetryUnknown'))
                    )
                      return;
                    void perform(
                      `/agent/deliveries/${item.id}/retry`,
                      'POST',
                      { ...(item.status === 'unknown' ? { acknowledge_unknown: true } : {}) },
                      t('telegramSettings.retrySubmittedNotice'),
                    );
                  }}
                >
                  {t('telegramSettings.retryDelivery')}
                </button>
              )}
            </div>
          ))}
          {!deliveries.value?.items.length && (
            <p className="workspace-empty">{t('telegramSettings.noDeliveries')}</p>
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
