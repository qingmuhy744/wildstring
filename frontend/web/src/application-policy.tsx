import { HelpLabel } from './desktop-help';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { errorText, useWorkspaceResource, WorkspaceNotice } from './workspace-ui';

type Policy = {
  mode: 'manual' | 'automatic';
  kinds: string[];
  version: number;
  allowed_kinds: string[];
};
const labelKeys: Record<string, string> = {
  playlist: 'applicationPolicy.typePlaylist',
  metadata: 'applicationPolicy.typeMetadata',
  metadata_batch: 'applicationPolicy.typeMetadataBatch',
  cover: 'applicationPolicy.typeCover',
  lyrics: 'applicationPolicy.typeLyrics',
  intake: 'applicationPolicy.typeIntake',
};

export function ApplicationPolicySettings() {
  const { t } = useTranslation();
  const resource = useWorkspaceResource<Policy>('/agent/application-policy');
  const [form, setForm] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    if (resource.value) setForm(resource.value);
  }, [resource.value]);
  async function save() {
    if (!form || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { mode, kinds, version } = form;
      const saved = await api<Policy>('/agent/application-policy', {
        method: 'PUT',
        body: JSON.stringify({ mode, kinds, version }),
      });
      setForm(saved);
      setNotice(t('applicationPolicy.savedNotice'));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="workspace-card application-policy"
      aria-label={t('applicationPolicy.sectionAria')}
    >
      <h2>{t('applicationPolicy.title')}</h2>
      <p className="muted">{t('applicationPolicy.description')}</p>
      <WorkspaceNotice error={error || resource.error} notice={notice} />
      {form ? (
        <>
          <label>
            <HelpLabel hint="application">{t('applicationPolicy.modeLabel')}</HelpLabel>
            <select
              aria-label={t('applicationPolicy.modeLabel')}
              value={form.mode}
              disabled={busy}
              onChange={(e) => setForm({ ...form, mode: e.target.value as Policy['mode'] })}
            >
              <option value="manual">{t('applicationPolicy.modeManual')}</option>
              <option value="automatic">{t('applicationPolicy.modeAutomatic')}</option>
            </select>
          </label>
          <p>
            {form.mode === 'manual'
              ? t('applicationPolicy.manualHint')
              : t('applicationPolicy.automaticHint')}
          </p>
          <fieldset disabled={busy || form.mode !== 'automatic'}>
            <legend>{t('applicationPolicy.autoTypesLegend')}</legend>
            {form.allowed_kinds.map((kind) => (
              <label className="workspace-check" key={kind}>
                <input
                  type="checkbox"
                  checked={form.kinds.includes(kind)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      kinds: e.target.checked
                        ? [...form.kinds, kind]
                        : form.kinds.filter((k) => k !== kind),
                    })
                  }
                />
                {labelKeys[kind] ? t(labelKeys[kind]) : kind}
              </label>
            ))}
          </fieldset>
          <p className="muted">{t('applicationPolicy.safetyHint')}</p>
          <button
            className="primary"
            disabled={busy || (form.mode === 'automatic' && !form.kinds.length)}
            onClick={() => void save()}
          >
            {busy ? t('applicationPolicy.saving') : t('applicationPolicy.savePolicy')}
          </button>
          <button disabled={busy} onClick={() => void resource.reload()}>
            {t('applicationPolicy.reloadPolicy')}
          </button>
        </>
      ) : (
        <button disabled={resource.loading} onClick={() => void resource.reload()}>
          {t('applicationPolicy.reloadPolicy')}
        </button>
      )}
    </section>
  );
}
