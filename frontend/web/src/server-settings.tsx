import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
interface ServerSettingsRecord {
  instance_id: string;
  name: string;
  connection_policy: 'legacy' | 'mixed' | 'https_only';
  sources: Record<'name' | 'connection_policy', 'database' | 'environment' | 'default'>;
}
const sourceKeys = {
  database: 'serverSettings.sourceDatabase',
  environment: 'serverSettings.sourceEnvironment',
  default: 'serverSettings.sourceDefault',
};
export function ServerSettings() {
  const { t } = useTranslation();
  const [record, setRecord] = useState<ServerSettingsRecord | null>(null);
  const [name, setName] = useState('');
  const [policy, setPolicy] = useState<ServerSettingsRecord['connection_policy']>('legacy');
  const [nameEdited, setNameEdited] = useState(false);
  const [policyEdited, setPolicyEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  function receive(value: ServerSettingsRecord) {
    setRecord(value);
    setName(value.name);
    setPolicy(value.connection_policy);
    setNameEdited(false);
    setPolicyEdited(false);
  }
  useEffect(() => {
    const controller = new AbortController();
    api<ServerSettingsRecord>('/manage/server', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) receive(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, []);
  async function save(body: Record<string, string | null>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      receive(
        await api<ServerSettingsRecord>('/manage/server', {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
      );
      setNotice(t('serverSettings.savedNotice'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('serverSettings.saveFailed'));
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const body: Record<string, string> = {};
    if (nameEdited) body.name = name.trim();
    if (policy !== 'legacy' && policyEdited) body.connection_policy = policy;
    void save(body);
  }
  return (
    <form
      className="management-card account-form"
      aria-label={t('serverSettings.sectionAria')}
      onSubmit={submit}
    >
      <h2>{t('serverSettings.sectionAria')}</h2>
      <p className="muted">{t('serverSettings.description')}</p>
      <label>
        {t('serverSettings.serverNameLabel')}
        <input
          required
          maxLength={80}
          value={name}
          disabled={!record || busy}
          onChange={(e) => {
            setName(e.target.value);
            setNameEdited(true);
          }}
        />
      </label>
      {record && (
        <div className="workspace-actions">
          <small>
            {t('serverSettings.sourcePrefix', {
              source: t(sourceKeys[record.sources.name] || record.sources.name),
            })}
          </small>
          <button
            type="button"
            disabled={busy || record.sources.name !== 'database'}
            onClick={() => void save({ name: null })}
          >
            {t('serverSettings.resetName')}
          </button>
        </div>
      )}
      <label>
        {t('serverSettings.policyLabel')}
        <select
          value={policy}
          disabled={!record || busy}
          onChange={(e) => {
            setPolicy(e.target.value as ServerSettingsRecord['connection_policy']);
            setPolicyEdited(true);
          }}
        >
          {record?.connection_policy === 'legacy' && (
            <option value="legacy">{t('serverSettings.policyLegacy')}</option>
          )}
          <option value="mixed">{t('serverSettings.policyMixed')}</option>
          <option value="https_only">{t('serverSettings.policyHttpsOnly')}</option>
        </select>
      </label>
      <p className="muted">{t('serverSettings.policyDescription')}</p>
      {policy === 'https_only' && location.protocol === 'http:' && (
        <p role="note" className="access-warning">
          {t('serverSettings.httpWarning')}
        </p>
      )}
      {record && (
        <div className="workspace-actions">
          <small>
            {t('serverSettings.sourcePrefix', {
              source: t(
                sourceKeys[record.sources.connection_policy] || record.sources.connection_policy,
              ),
            })}
          </small>
          <button
            type="button"
            disabled={busy || record.sources.connection_policy !== 'database'}
            onClick={() => void save({ connection_policy: null })}
          >
            {t('serverSettings.resetPolicy')}
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <button className="primary" disabled={!record || busy}>
        {busy ? t('serverSettings.saving') : t('serverSettings.saveSettings')}
      </button>
    </form>
  );
}
