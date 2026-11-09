import { HelpLabel } from './desktop-help';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
interface Settings {
  enabled: boolean;
  hosts: string[];
  version: number;
}
export function HostSettings() {
  const { t } = useTranslation();
  const [record, setRecord] = useState<Settings | null>(null),
    [enabled, setEnabled] = useState(false),
    [text, setText] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api<Settings>('/manage/access', { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) {
          setRecord(result);
          setEnabled(result.enabled);
          setText(result.hosts.join('\n'));
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!record) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<Settings>('/manage/access', {
        method: 'PUT',
        body: JSON.stringify({
          version: record.version,
          enabled,
          hosts: text
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
        }),
      });
      setRecord(result);
      setText(result.hosts.join('\n'));
      setNotice(t('hostSettings.savedNotice'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('hostSettings.saveFailed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="management-card account-form host-settings"
      onSubmit={save}
      aria-label={t('hostSettings.sectionAria')}
    >
      <h2>{t('hostSettings.title')}</h2>
      <p className="muted">{t('hostSettings.description')}</p>
      <p className="access-warning" role="note">
        <strong>{t('hostSettings.warningPrefix')}</strong>
        {t('hostSettings.warningDetail')}
        <code>{location.hostname}</code>
        {t('hostSettings.warningSuffix')}
      </p>
      <label className="check-label">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!record || busy}
          onChange={(event) => {
            setEnabled(event.target.checked);
            setNotice('');
          }}
        />
        {t('hostSettings.enableAllowlist')}
      </label>
      <label>
        <HelpLabel hint="hostAllowlist">{t('hostSettings.allowedHostsLabel')}</HelpLabel>
        <textarea
          rows={5}
          placeholder={'music.example.com\n192.168.10.65'}
          value={text}
          disabled={!record || busy}
          onChange={(event) => {
            setText(event.target.value);
            setNotice('');
          }}
        />
      </label>
      <p className="muted">{t('hostSettings.hostsFormatHint')}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="ai-status" role="status">
          {notice}
        </p>
      )}
      <button className="primary" disabled={!record || busy}>
        {busy ? t('hostSettings.saving') : t('hostSettings.saveBtn')}
      </button>
    </form>
  );
}
