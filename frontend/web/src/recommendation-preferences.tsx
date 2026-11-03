import { HelpLabel } from './desktop-help';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentConnection } from './agent-api';
import { ModelConnectionChoice } from './model-connection';
import {
  recommendationSourceName,
  type RecommendationPreferences,
  type SourceStatus,
  type RecommendationWarning,
} from './recommendation-types';

export function RecommendationPreferencesForm({
  value,
  saved,
  onChange,
  onSave,
  busy,
  connections,
  connectionsBusy,
  onConnections,
}: {
  value: RecommendationPreferences;
  saved: RecommendationPreferences | null;
  onChange: (value: RecommendationPreferences) => void;
  onSave: () => void;
  busy: boolean;
  connections: AgentConnection[];
  connectionsBusy: boolean;
  onConnections: () => void;
}) {
  const { t } = useTranslation();
  const [tagsInput, setTagsInput] = useState((value.lastfm_tags || []).join(', '));
  useEffect(() => {
    setTagsInput((value.lastfm_tags || []).join(', '));
  }, [value.version]);
  const unified = Array.isArray(value.sources),
    sources = value.sources || ['personal', 'community', 'discovery', 'revisit'];
  function toggle(id: string, checked: boolean, external = false) {
    const key = external ? 'external_sources' : 'sources',
      prior =
        value[key] || (external ? ['lastfm_charts', 'lastfm_tags', 'lastfm_artists'] : sources);
    const next = checked
      ? [...prior.filter((item) => item !== id), id]
      : prior.filter((item) => item !== id);
    onChange({
      ...value,
      [key]: next,
      ...(!external ? { use_lastfm: next.includes('lastfm_similar') } : {}),
    });
  }
  return (
    <details
      id="recommendation-preferences"
      className="discovery-preferences recommendation-preferences"
    >
      <summary>{t('recommendations.preferences.summary')}</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <p className="muted">{t('recommendations.preferences.intro')}</p>
        {unified ? (
          <>
            <ModelConnectionChoice
              items={connections}
              value={value.connection_id || 'local'}
              onChange={(id) =>
                onChange({
                  ...value,
                  connection_id: id,
                  use_ai: id !== 'local',
                  ...(id === 'local' ? { external_use_ai: false } : {}),
                })
              }
              label={t('recommendations.preferences.connection')}
              disabled={busy || connectionsBusy}
              onManage={onConnections}
            />
            <fieldset className="recommendation-source-group">
              <legend>
                <HelpLabel text={t('recommendations.preferences.help')}>
                  {t('recommendations.preferences.sourcesLegend')}
                </HelpLabel>
              </legend>
              <p className="muted">{t('recommendations.preferences.sourcesHint')}</p>
              <div className="workspace-check-grid">
                {['personal', 'community', 'discovery', 'revisit'].map((id) => (
                  <label className="workspace-check" key={id}>
                    <input
                      type="checkbox"
                      checked={sources.includes(id)}
                      onChange={(event) => toggle(id, event.target.checked)}
                    />
                    {recommendationSourceName(t, id)}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="recommendation-source-group">
              <legend>{t('recommendations.preferences.dailyLegend')}</legend>
              <div className="recommendation-settings-grid">
                <label className="workspace-check">
                  <input
                    type="checkbox"
                    checked={!!value.daily_enabled}
                    onChange={(event) =>
                      onChange({ ...value, daily_enabled: event.target.checked })
                    }
                  />
                  {t('recommendations.preferences.dailyCheck')}
                </label>
                <label>
                  {t('recommendations.preferences.timeLabel')}
                  <input
                    aria-label={t('recommendations.preferences.timeAria')}
                    type="time"
                    value={value.daily_time || '00:00'}
                    onChange={(event) => onChange({ ...value, daily_time: event.target.value })}
                  />
                </label>
              </div>
              <p className="muted">{t('recommendations.preferences.timeHint')}</p>
            </fieldset>
            <fieldset className="recommendation-source-group">
              <legend>{t('recommendations.preferences.lastfmLegend')}</legend>
              <div className="workspace-check-grid">
                {['lastfm_similar', 'lastfm_charts', 'lastfm_tags'].map((id) => (
                  <label className="workspace-check" key={id}>
                    <input
                      type="checkbox"
                      checked={sources.includes(id)}
                      onChange={(event) => toggle(id, event.target.checked)}
                    />
                    {recommendationSourceName(t, id)}
                  </label>
                ))}
              </div>
              <p className="muted">{t('recommendations.preferences.lastfmHint')}</p>
              <label>
                {t('recommendations.preferences.tagsLabel')}
                <input
                  aria-label={t('recommendations.preferences.tagsAria')}
                  maxLength={200}
                  value={tagsInput}
                  onChange={(event) => {
                    setTagsInput(event.target.value);
                    onChange({
                      ...value,
                      lastfm_tags: event.target.value
                        .split(/[,，]/)
                        .map((tag) => tag.trim())
                        .filter(Boolean)
                        .slice(0, 3),
                    });
                  }}
                />
              </label>
            </fieldset>
            <fieldset className="recommendation-source-group">
              <legend>{t('recommendations.preferences.externalLegend')}</legend>
              <label className="workspace-check">
                <input
                  type="checkbox"
                  checked={!!value.external_enabled}
                  onChange={(event) =>
                    onChange({ ...value, external_enabled: event.target.checked })
                  }
                />
                {t('recommendations.preferences.externalEnable')}
              </label>
              <p className="muted">{t('recommendations.preferences.externalHint')}</p>
              {value.external_enabled && (
                <>
                  <div className="workspace-check-grid">
                    {['lastfm_charts', 'lastfm_tags', 'lastfm_artists', 'lastfm_similar'].map(
                      (id) => (
                        <label className="workspace-check" key={id}>
                          <input
                            type="checkbox"
                            checked={(
                              value.external_sources || [
                                'lastfm_charts',
                                'lastfm_tags',
                                'lastfm_artists',
                              ]
                            ).includes(id)}
                            onChange={(event) => toggle(id, event.target.checked, true)}
                          />
                          {recommendationSourceName(t, id)}
                        </label>
                      ),
                    )}
                  </div>
                  <div className="recommendation-settings-grid">
                    <label>
                      {t('recommendations.preferences.refreshLabel')}
                      <select
                        aria-label={t('recommendations.preferences.refreshAria')}
                        value={value.external_refresh_days ?? 7}
                        onChange={(event) =>
                          onChange({ ...value, external_refresh_days: Number(event.target.value) })
                        }
                      >
                        {[
                          [0, t('recommendations.preferences.manual')],
                          [1, t('recommendations.preferences.daily')],
                          [3, t('recommendations.preferences.every3')],
                          [7, t('recommendations.preferences.every7')],
                          [14, t('recommendations.preferences.every14')],
                          [30, t('recommendations.preferences.every30')],
                        ].map(([days, label]) => (
                          <option value={days} key={days}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="workspace-check">
                      <input
                        type="checkbox"
                        checked={!!value.external_use_ai}
                        disabled={(value.connection_id || 'local') === 'local'}
                        onChange={(event) =>
                          onChange({ ...value, external_use_ai: event.target.checked })
                        }
                      />
                      {t('recommendations.preferences.useAi')}
                    </label>
                  </div>
                  <p className="muted">
                    {value.external_use_ai
                      ? t('recommendations.preferences.useAiHintOn')
                      : t('recommendations.preferences.useAiHintOff')}{' '}
                    {t('recommendations.preferences.autoHint')}
                  </p>
                </>
              )}
            </fieldset>
          </>
        ) : (
          <p className="workspace-notice">{t('recommendations.preferences.legacy')}</p>
        )}
        <div className="recommendation-settings-grid">
          <label>
            {t('recommendations.preferences.count')}
            <input
              aria-label={t('recommendations.preferences.countAria')}
              type="number"
              required
              min={1}
              max={50}
              value={value.count}
              onChange={(event) => onChange({ ...value, count: Number(event.target.value) })}
            />
          </label>
          <div className="workspace-actions">
            <button
              disabled={busy || !sources.length || JSON.stringify(value) === JSON.stringify(saved)}
              className="primary"
            >
              {busy
                ? t('recommendations.preferences.saving')
                : t('recommendations.preferences.save')}
            </button>
          </div>
        </div>
      </form>
    </details>
  );
}
export function RecommendationSources({
  items,
  warnings,
  degraded,
}: {
  items?: SourceStatus[];
  warnings?: RecommendationWarning[];
  degraded?: boolean;
}) {
  const { t } = useTranslation();
  if (!items?.length && !warnings?.length && !degraded) return null;
  return (
    <details className="recommendation-provenance">
      <summary>
        {degraded
          ? t('recommendations.provenance.degradedSummary')
          : t('recommendations.provenance.summary')}
      </summary>
      {degraded && <p className="muted">{t('recommendations.provenance.degradedNote')}</p>}
      <ul>
        {items?.map((item) => (
          <li key={item.id}>
            <strong>{recommendationSourceName(t, item.id)}</strong>
            <span>
              {t(`recommendations.states.${item.status}`, { defaultValue: item.status })}
              {item.matched > 0
                ? t('recommendations.provenance.matched', { count: item.matched })
                : ''}
              {item.candidate_count != null
                ? t('recommendations.provenance.candidates', { count: item.candidate_count })
                : ''}
              {item.unmatched != null && item.unmatched > 0
                ? t('recommendations.provenance.unmatched', { count: item.unmatched })
                : ''}
              {item.cached ? t('recommendations.provenance.cached') : ''}
            </span>
          </li>
        ))}
      </ul>
      {warnings?.map((warning, index) => (
        <p className="muted" key={index}>
          {t('recommendations.provenance.warning', {
            source: recommendationSourceName(t, warning.source),
            message: t(`recommendations.warnings.${recommendationWarningKey(warning.code)}`),
          })}
        </p>
      ))}
    </details>
  );
}
export function recommendationWarningKey(code: string) {
  if (code.includes('budget')) return 'budget';
  if (code.includes('disabled') || code.includes('not_configured')) return 'disabled';
  if (code.includes('no_match') || code.includes('empty')) return 'noMatch';
  if (code.includes('rate') || code.includes('429')) return 'rate';
  if (code.includes('connection') || code.includes('model') || code.startsWith('ai_'))
    return 'model';
  return 'other';
}
