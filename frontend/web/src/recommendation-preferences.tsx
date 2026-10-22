import { HelpLabel } from './desktop-help';
import { useEffect, useState } from 'react';
import type { AgentConnection } from './agent-api';
import { ModelConnectionChoice } from './model-connection';
import {
  recommendationSources,
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
      <summary>推荐偏好</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <p className="muted">
          这些设置属于当前账号。保存只更新偏好；点击“换一批”或“获取收歌建议”后才会处理新结果。
        </p>
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
              label="找歌与推荐模型连接"
              disabled={busy || connectionsBusy}
              onManage={onConnections}
            />
            <fieldset className="recommendation-source-group">
              <legend>
                <HelpLabel hint="recommendations">本库推荐来源</HelpLabel>
              </legend>
              <p className="muted">
                混合自己的收听、全站汇总热度和未充分听过的收藏。全站排行不展示其他账号的个人记录。
              </p>
              <div className="workspace-check-grid">
                {['personal', 'community', 'discovery', 'revisit'].map((id) => (
                  <label className="workspace-check" key={id}>
                    <input
                      type="checkbox"
                      checked={sources.includes(id)}
                      onChange={(event) => toggle(id, event.target.checked)}
                    />
                    {recommendationSources[id]}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="recommendation-source-group">
              <legend>每日推荐自动生成</legend>
              <div className="recommendation-settings-grid">
                <label className="workspace-check">
                  <input
                    type="checkbox"
                    checked={!!value.daily_enabled}
                    onChange={(event) =>
                      onChange({ ...value, daily_enabled: event.target.checked })
                    }
                  />
                  按时自动生成新的每日推荐
                </label>
                <label>
                  生成时间
                  <input
                    aria-label="每日推荐生成时间"
                    type="time"
                    value={value.daily_time || '00:00'}
                    onChange={(event) => onChange({ ...value, daily_time: event.target.value })}
                  />
                </label>
              </div>
              <p className="muted">
                服务端按 Asia/Shanghai
                时间检查；错过设定时间后会在下一次后台检查补生成，每天最多一份。
              </p>
            </fieldset>
            <fieldset className="recommendation-source-group">
              <legend>可选 Last.fm 资料</legend>
              <div className="workspace-check-grid">
                {['lastfm_similar', 'lastfm_charts', 'lastfm_tags'].map((id) => (
                  <label className="workspace-check" key={id}>
                    <input
                      type="checkbox"
                      checked={sources.includes(id)}
                      onChange={(event) => toggle(id, event.target.checked)}
                    />
                    {recommendationSources[id]}
                  </label>
                ))}
              </div>
              <p className="muted">
                公共榜单和标签提供流行度线索，不代表你的个人喜好。本库每日推荐仍只播放已导入的歌曲。
              </p>
              <label>
                Last.fm 标签（最多 3 项，逗号分隔）
                <input
                  aria-label="Last.fm 推荐标签"
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
              <legend>发现新音乐，留给自己慢慢收</legend>
              <label className="workspace-check">
                <input
                  type="checkbox"
                  checked={!!value.external_enabled}
                  onChange={(event) =>
                    onChange({ ...value, external_enabled: event.target.checked })
                  }
                />
                启用库外收歌建议
              </label>
              <p className="muted">
                “新”指你的曲库中可能还没有，可能是老歌。这里只给名称、理由和资料来源；歌曲由你自行下载并放入导入文件夹。
              </p>
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
                          {recommendationSources[id]}
                        </label>
                      ),
                    )}
                  </div>
                  <div className="recommendation-settings-grid">
                    <label>
                      收歌建议更新频率
                      <select
                        aria-label="收歌建议更新频率"
                        value={value.external_refresh_days ?? 7}
                        onChange={(event) =>
                          onChange({ ...value, external_refresh_days: Number(event.target.value) })
                        }
                      >
                        {[
                          [0, '仅手动更新'],
                          [1, '每天'],
                          [3, '每 3 天'],
                          [7, '每 7 天'],
                          [14, '每 14 天'],
                          [30, '每 30 天'],
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
                      使用已选模型整理收歌建议
                    </label>
                  </div>
                  <p className="muted">
                    {value.external_use_ai
                      ? '更新收歌建议会使用上方连接与同一份每日额度。'
                      : '使用真实来源与本地规则，不调用模型。'}
                    自动更新在你打开发现页且建议到期时进行；选择“仅手动更新”可完全由自己触发。
                  </p>
                </>
              )}
            </fieldset>
          </>
        ) : (
          <p className="workspace-notice">
            当前服务端尚未提供统一连接与推荐来源设置。找歌仅使用本地检索，请升级服务端后配置新能力。
          </p>
        )}
        <div className="recommendation-settings-grid">
          <label>
            每日首数
            <input
              aria-label="每日首数"
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
              {busy ? '正在保存…' : '保存推荐偏好'}
            </button>
          </div>
        </div>
      </form>
    </details>
  );
}
const sourceState: Record<string, string> = {
  ok: '已使用',
  disabled: '未启用',
  empty: '没有可用候选',
  unavailable: '暂不可用',
};
export function RecommendationSources({
  items,
  warnings,
  degraded,
}: {
  items?: SourceStatus[];
  warnings?: RecommendationWarning[];
  degraded?: boolean;
}) {
  if (!items?.length && !warnings?.length && !degraded) return null;
  return (
    <details className="recommendation-provenance">
      <summary>{degraded ? '部分来源不可用，查看推荐依据' : '推荐来自哪里'}</summary>
      {degraded && (
        <p className="muted">这次部分步骤未完成，展示已经验证的结果；不会自动改用其他付费连接。</p>
      )}
      <ul>
        {items?.map((item) => (
          <li key={item.id}>
            <strong>{recommendationSources[item.id] || item.id}</strong>
            <span>
              {sourceState[item.status] || item.status}
              {item.matched > 0 ? ` · ${item.matched} 首本库匹配` : ''}
              {item.candidate_count != null ? ` · 来源候选 ${item.candidate_count} 首` : ''}
              {item.unmatched != null && item.unmatched > 0 ? ` · 未匹配 ${item.unmatched} 首` : ''}
              {item.cached ? ' · 使用缓存' : ''}
            </span>
          </li>
        ))}
      </ul>
      {warnings?.map((warning, index) => (
        <p className="muted" key={index}>
          {recommendationSources[warning.source] || warning.source}：
          {recommendationWarning(warning.code)}
        </p>
      ))}
    </details>
  );
}
export function recommendationWarning(code: string) {
  if (code.includes('budget')) return '模型额度不足，已保留可用的本地结果。';
  if (code.includes('disabled') || code.includes('not_configured')) return '服务未启用或尚未配置。';
  if (code.includes('no_match') || code.includes('empty'))
    return '来源有资料，但这批候选尚未匹配到本库。';
  if (code.includes('rate') || code.includes('429')) return '来源暂时限流，请稍后重试。';
  if (code.includes('connection') || code.includes('model') || code.startsWith('ai_'))
    return '模型步骤未完成，可查看连接状态后重试。';
  return '本次来源查询未完成，已保留其他可用结果。';
}
