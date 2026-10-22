import { hints } from './help-content';
import { HelpLabel } from './desktop-help';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Icon } from './icons';
import { PluginZipUpload } from './plugin-zip-upload';
import './source-plugins.css';

type Plugin = {
  id: string;
  name: string;
  version: number;
  plugin_version: string;
  available: boolean;
  request_pacing?: boolean;
  enabled: boolean;
  metadata_enabled: boolean;
  lyrics_enabled: boolean;
  priority: number;
  upstream: string;
  license: string;
  config: Record<string, string>;
  configured_secrets: string[];
  settings: { key: string; label: string; type: string; required?: boolean }[];
};
type Feedback = { text: string; kind: 'pending' | 'success' | 'error' };
function PluginFeedback({ value, className = '' }: { value?: Feedback; className?: string }) {
  return value ? (
    <p
      className={`plugin-feedback ${className}`}
      data-kind={value.kind}
      role={value.kind === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      {value.text}
    </p>
  ) : null;
}

export function SourcePlugins() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [operation, setOperation] = useState<string | null>(null);
  const pending = useRef(false);
  const busy = operation !== null;
  const [message, setMessage] = useState<Feedback>();
  const [notices, setNotices] = useState<Record<string, Feedback>>({});
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, Feedback>>({});
  async function load(resetId?: string) {
    const result = await api<{ items: Plugin[] }>('/manage/source-plugins');
    const drafts = new Map(
      plugins.filter((p) => p.id !== resetId && dirty(p)).map((p) => [p.id, p]),
    );
    setPlugins(result.items.map((p) => drafts.get(p.id) || p));
    setValues(
      Object.fromEntries(
        result.items.map((p) => [p.id, drafts.has(p.id) ? values[p.id] : p.config]),
      ),
    );
    setSaved(
      Object.fromEntries(
        result.items.map((p) => [
          p.id,
          JSON.stringify({
            enabled: p.enabled,
            metadata_enabled: p.metadata_enabled,
            lyrics_enabled: p.lyrics_enabled,
            priority: p.priority,
            config: p.config,
          }),
        ]),
      ),
    );
  }
  useEffect(() => {
    void load().catch(() => setMessage({ kind: 'error', text: '无法读取数据源插件。' }));
  }, []);
  function dirty(p: Plugin) {
    return (
      saved[p.id] !==
      JSON.stringify({
        enabled: p.enabled,
        metadata_enabled: p.metadata_enabled,
        lyrics_enabled: p.lyrics_enabled,
        priority: p.priority,
        config: values[p.id] || {},
      })
    );
  }
  async function testPlugin(p: Plugin) {
    if (pending.current || dirty(p)) return;
    pending.current = true;
    setOperation(`test:${p.id}`);
    setResults((prior) => ({ ...prior, [p.id]: { kind: 'pending', text: '正在测试此插件…' } }));
    try {
      const result = await api<{ count: number }>(`/manage/source-plugins/${p.id}/test`, {
        method: 'POST',
      });
      setResults((prior) => ({
        ...prior,
        [p.id]: { kind: 'success', text: `检索已响应 · 返回 ${result.count} 条候选。` },
      }));
    } catch (error) {
      setResults((prior) => ({
        ...prior,
        [p.id]: {
          kind: 'error',
          text: error instanceof Error ? error.message : '插件测试未完成。',
        },
      }));
    } finally {
      pending.current = false;
      setOperation(null);
    }
  }
  async function run(
    work: () => Promise<unknown>,
    success: string,
    action: string,
    pluginId?: string,
  ) {
    if (pending.current) return false;
    pending.current = true;
    setOperation(action);
    if (pluginId)
      setResults((prior) =>
        Object.fromEntries(Object.entries(prior).filter(([id]) => id !== pluginId)),
      );
    const feedback = (value: Feedback) =>
      pluginId ? setNotices((prior) => ({ ...prior, [pluginId]: value })) : setMessage(value);
    feedback({ kind: 'pending', text: '正在处理…' });
    try {
      await work();
      await load(pluginId);
      feedback({ kind: 'success', text: success });
      return true;
    } catch (error) {
      feedback({ kind: 'error', text: error instanceof Error ? error.message : '操作未完成。' });
      return false;
    } finally {
      pending.current = false;
      setOperation(null);
    }
  }
  return (
    <section className="source-plugins" aria-labelledby="source-plugins-heading">
      <header className="source-plugins-heading">
        <h3 id="source-plugins-heading">数据源插件</h3>
        <p className="muted">为曲库补充元数据、封面和歌词，按来源独立配置。</p>
      </header>
      <section className="plugin-import" aria-labelledby="plugin-import-heading">
        <h4 id="plugin-import-heading">导入新插件</h4>
        <p className="muted">
          插件会运行代码，请选择你信任的 WildString 插件包。导入后需配置并启用。
        </p>
        <PluginZipUpload
          inputLabel="数据源插件 ZIP"
          actionLabel="导入插件"
          disabled={busy}
          working={operation === 'import'}
          onUpload={(file) =>
            run(
              async () =>
                api('/manage/source-plugins/import', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/zip' },
                  body: await file.arrayBuffer(),
                }),
              '插件已导入，请在下方配置并启用。',
              'import',
            )
          }
        />
        <PluginFeedback value={message} className="plugin-import-result" />
      </section>
      <div className="plugin-list-heading">
        <h4>已安装插件</h4>
        <span>{plugins.length} 个来源</span>
      </div>
      <div className="plugin-list">
        {plugins.map((p) => (
          <article
            className="source-plugin-card"
            key={p.id}
            aria-labelledby={`plugin-name-${p.id}`}
          >
            <header className="source-plugin-header">
              <div>
                <h4 id={`plugin-name-${p.id}`}>{p.name}</h4>
                <p className="plugin-version">
                  插件 {p.plugin_version} · 配置版本 {p.version}
                </p>
                <a href={p.upstream} target="_blank" rel="noreferrer">
                  上游项目 ↗
                </a>
                <span className="plugin-license">{p.license}</span>
              </div>
              <span className={`plugin-state${p.enabled ? ' is-enabled' : ''}`}>
                {dirty(p) ? '未保存' : p.enabled ? '已启用' : '已停用'}
              </span>
            </header>
            {!p.available && (
              <p className="plugin-feedback" data-kind="error" role="status">
                运行环境缺少插件声明的依赖，请使用含社区插件运行时的官方镜像或按插件说明配置。
              </p>
            )}
            <fieldset disabled={busy}>
              <legend className="plugin-sr-only">{p.name} 配置</legend>
              <div className="plugin-capabilities">
                {(['enabled', 'metadata_enabled', 'lyrics_enabled'] as const).map(
                  (field, index) => (
                    <label className="check-label" key={field}>
                      <input
                        type="checkbox"
                        checked={p[field]}
                        onChange={(e) =>
                          setPlugins(
                            plugins.map((value) =>
                              value.id === p.id ? { ...value, [field]: e.target.checked } : value,
                            ),
                          )
                        }
                      />
                      {index === 0 ? (
                        <HelpLabel hint="pluginEnabled">启用此插件</HelpLabel>
                      ) : (
                        ['启用此插件', '提供元数据与封面', '提供歌词'][index]
                      )}
                    </label>
                  ),
                )}
              </div>
              <div className="plugin-config-grid">
                <label>
                  <HelpLabel hint="sourcePriority">来源优先级（0–100，越小越优先）</HelpLabel>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={p.priority}
                    onChange={(e) =>
                      setPlugins(
                        plugins.map((value) =>
                          value.id === p.id
                            ? { ...value, priority: Number(e.target.value) }
                            : value,
                        ),
                      )
                    }
                  />
                </label>
                {p.settings.map((field) => (
                  <label key={field.key}>
                    {field.type === 'secret' || field.type === 'url' ? (
                      <HelpLabel hint={field.type === 'secret' ? 'savedSecret' : 'pluginUrl'}>
                        {field.label}
                      </HelpLabel>
                    ) : (
                      field.label
                    )}
                    <input
                      type={
                        field.type === 'secret' ? 'password' : field.type === 'url' ? 'url' : 'text'
                      }
                      value={values[p.id]?.[field.key] || ''}
                      placeholder={
                        p.configured_secrets.includes(field.key) ? '已保存，留空保留' : ''
                      }
                      onChange={(e) =>
                        setValues({
                          ...values,
                          [p.id]: { ...values[p.id], [field.key]: e.target.value },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <div className="plugin-main-actions">
                <button
                  className="primary"
                  aria-label={`保存 ${p.name}`}
                  onClick={() =>
                    void run(
                      () =>
                        api(`/manage/source-plugins/${p.id}`, {
                          method: 'PUT',
                          body: JSON.stringify({
                            version: p.version,
                            enabled: p.enabled,
                            metadata_enabled: p.metadata_enabled,
                            lyrics_enabled: p.lyrics_enabled,
                            priority: p.priority,
                            config: values[p.id] || {},
                          }),
                        }),
                      '插件配置已保存。',
                      `save:${p.id}`,
                      p.id,
                    )
                  }
                >
                  {operation === `save:${p.id}` ? '正在保存…' : '保存设置'}
                </button>
                <button
                  aria-label={`测试 ${p.name}`}
                  disabled={!p.enabled || dirty(p)}
                  onClick={() => void testPlugin(p)}
                >
                  {operation === `test:${p.id}` ? '正在测试…' : '测试连接'}
                </button>
              </div>
              {dirty(p) && (
                <p className="muted plugin-unsaved">有未保存的设置，请先保存，再测试或升级。</p>
              )}
              <PluginFeedback value={notices[p.id]} className="plugin-operation-result" />
              <PluginFeedback value={results[p.id]} className="plugin-test-result" />
              <details className="plugin-maintenance">
                <summary data-help={hints.pluginMaintenance}>
                  <strong>版本与维护</strong>
                  <span>升级 · 导出 · 卸载</span>
                  <Icon name="chevron" />
                </summary>
                <div className="plugin-maintenance-content">
                  <h5>升级 {p.name}</h5>
                  <p className="muted">
                    选择此插件的 ZIP 升级包，确认后上传。升级保留配置并停用插件，核对后可重新启用。
                  </p>
                  <PluginZipUpload
                    inputLabel={`${p.name} 升级 ZIP`}
                    actionLabel="确认升级"
                    disabled={busy || dirty(p)}
                    working={operation === `upgrade:${p.id}`}
                    onUpload={(file) =>
                      run(
                        async () =>
                          api(
                            `/manage/source-plugins/import?expected_version=${p.version}&expected_id=${encodeURIComponent(p.id)}`,
                            {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/zip' },
                              body: await file.arrayBuffer(),
                            },
                          ),
                        '插件已升级并停用，配置已保留，请重新核对后启用。',
                        `upgrade:${p.id}`,
                        p.id,
                      )
                    }
                  />
                  <div className="plugin-maintenance-actions">
                    <a
                      className="plugin-export"
                      href={`/api/v1/manage/source-plugins/${p.id}/export`}
                    >
                      <Icon name="download" />
                      导出 ZIP
                    </a>
                    <div>
                      <button
                        className="plugin-uninstall"
                        aria-label={`卸载 ${p.name}`}
                        disabled={p.enabled || dirty(p)}
                        onClick={() =>
                          void run(
                            () =>
                              api(`/manage/source-plugins/${p.id}?version=${p.version}`, {
                                method: 'DELETE',
                              }),
                            `已卸载 ${p.name}，已有候选和歌词保留。`,
                            `uninstall:${p.id}`,
                          )
                        }
                      >
                        卸载插件
                      </button>
                      <small>
                        {p.enabled || dirty(p)
                          ? '先停用并保存，才能卸载。'
                          : '卸载会保留已有候选和歌词。'}
                      </small>
                    </div>
                  </div>
                </div>
              </details>
            </fieldset>
          </article>
        ))}
      </div>
      {!plugins.length && (
        <p className="plugin-empty">
          还没有插件。可以从 WildString Release 下载 QQ、酷狗或网易云插件 ZIP，使用上方入口导入。
        </p>
      )}
    </section>
  );
}

type LyricCandidate = {
  id: string;
  plugin_id: string;
  source_url: string;
  source_id: string;
  line_count: number;
  lyrics_version: number;
  file_version: string;
  quality?: {
    level: number;
    label: string;
    word_timed: boolean;
    bilingual: boolean;
    word_coverage: number;
    translation_coverage: number;
    lines: number;
  };
  match: {
    title: string;
    artists: string[];
    score: number;
    version_mismatch: boolean;
    duration_difference_ms: number | null;
  };
  normalized: {
    kind: string;
    lines: {
      text: string;
      time_ms: number | null;
      words?: { text: string; start_ms?: number | null; end_ms?: number | null }[];
      translation?: string;
      romanization?: string;
    }[];
    format: string;
    layers?: Record<string, unknown[]>;
  };
};

function inferCandidateQuality(candidate: LyricCandidate) {
  if (candidate.quality) {
    const hasRoman = candidate.normalized.lines.some((line) => Boolean(line.romanization?.trim()));
    return { ...candidate.quality, romanized: hasRoman };
  }
  const lines = candidate.normalized.lines.filter((line) => line.text.trim().length > 0);
  const count = Math.max(1, lines.length);
  const timedRatio = lines.filter((line) => line.time_ms !== null).length / count;
  const wordRatio = lines.filter((line) => (line.words?.length ?? 0) > 0).length / count;
  const transRatio = lines.filter((line) => Boolean(line.translation?.trim())).length / count;
  const hasRoman = lines.some((line) => Boolean(line.romanization?.trim()));
  const synced = candidate.normalized.kind === 'synced' && timedRatio >= 0.8;
  const wordTimed = synced && wordRatio >= 0.8;
  const bilingual = synced && transRatio >= 0.8;
  const label = wordTimed
    ? bilingual
      ? '双语逐字动态'
      : '逐字动态'
    : synced
      ? bilingual
        ? '双语逐行动态'
        : '逐行动态'
      : lines.length > 0
        ? '静态歌词'
        : '无歌词';
  return {
    level: wordTimed
      ? bilingual
        ? 5
        : 4
      : synced
        ? bilingual
          ? 3
          : 2
        : lines.length > 0
          ? 1
          : 0,
    label,
    word_timed: wordTimed,
    bilingual,
    word_coverage: wordRatio,
    translation_coverage: transRatio,
    lines: lines.length,
    romanized: hasRoman,
  };
}

export function OnlineLyrics({ trackId, applied }: { trackId: string; applied: () => void }) {
  const [result, setResult] = useState<{
    items: LyricCandidate[];
    jobs: { status: string; warnings: string[] }[];
  } | null>(null);
  const [selected, setSelected] = useState<LyricCandidate | null>(null),
    [offset, setOffset] = useState(0);
  const [filterMode, setFilterMode] = useState<'all' | 'word' | 'bilingual'>('all');
  const [showWordSplits, setShowWordSplits] = useState(true);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function load() {
    setResult(await api(`/manage/tracks/${trackId}/online-lyrics`));
  }
  useEffect(() => {
    void load().catch(() => setMessage('无法读取联网歌词候选。'));
  }, [trackId]);
  const running = result?.jobs.some((job) => ['queued', 'running'].includes(job.status));
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      void load().catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [running, trackId]);
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setMessage('');
    try {
      await work();
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '歌词操作未完成。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="online-lyrics">
      <h3>联网歌词候选</h3>
      <p className="muted">
        先比较版本、歌手和时长，再预览时间轴；逐字歌词也可能匹配错误，确认后才替换数据库歌词。
      </p>
      <button
        disabled={busy || running}
        onClick={() =>
          void run(() => api(`/manage/tracks/${trackId}/online-lyrics`, { method: 'POST' }))
        }
      >
        查找联网歌词
      </button>
      <p role="status">
        {message ||
          (running
            ? '后台正在查询歌词…'
            : result?.jobs[0]?.status === 'no_match'
              ? '没有取得可用歌词，请检查插件设置与查询反馈。'
              : '')}
      </p>
      {result?.jobs[0]?.warnings?.map((value) => (
        <p className="muted" key={value}>
          {value}
        </p>
      ))}
      {result && result.items.length > 1 && (
        <div className="button-row" style={{ marginBottom: 8 }}>
          <button
            type="button"
            aria-pressed={filterMode === 'all'}
            onClick={() => setFilterMode('all')}
          >
            全部（{result.items.length}）
          </button>
          <button
            type="button"
            aria-pressed={filterMode === 'word'}
            onClick={() => setFilterMode('word')}
          >
            仅看逐字（{result.items.filter((item) => inferCandidateQuality(item).word_timed).length}
            ）
          </button>
          <button
            type="button"
            aria-pressed={filterMode === 'bilingual'}
            onClick={() => setFilterMode('bilingual')}
          >
            仅看双语（{result.items.filter((item) => inferCandidateQuality(item).bilingual).length}
            ）
          </button>
        </div>
      )}
      {result?.items
        .filter((candidate) => {
          const q = inferCandidateQuality(candidate);
          if (filterMode === 'word') return q.word_timed;
          if (filterMode === 'bilingual') return q.bilingual;
          return true;
        })
        .map((candidate) => {
          const q = inferCandidateQuality(candidate);
          return (
            <article className="suggestion-card" key={candidate.id}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <a href={candidate.source_url} target="_blank" rel="noreferrer">
                  {candidate.plugin_id} · {candidate.match.title}
                </a>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 999,
                    fontSize: 12,
                    fontWeight: 600,
                    background: q.word_timed
                      ? 'var(--accent, #d96b43)'
                      : q.level >= 2
                        ? 'rgba(128, 128, 128, 0.2)'
                        : 'rgba(128, 128, 128, 0.12)',
                    color: q.word_timed ? '#fff' : 'inherit',
                  }}
                >
                  {q.word_timed
                    ? `逐字动态 · ${Math.round(q.word_coverage * 100)}%`
                    : q.level >= 2
                      ? '逐行动态'
                      : '静态歌词'}
                </span>
                {q.bilingual && (
                  <span
                    style={{
                      padding: '2px 8px',
                      borderRadius: 999,
                      fontSize: 12,
                      background: 'rgba(128, 128, 128, 0.18)',
                    }}
                  >
                    双语 · {Math.round(q.translation_coverage * 100)}%
                  </span>
                )}
                {q.romanized && (
                  <span
                    style={{
                      padding: '2px 8px',
                      borderRadius: 999,
                      fontSize: 12,
                      background: 'rgba(128, 128, 128, 0.18)',
                    }}
                  >
                    音译
                  </span>
                )}
                <span
                  style={{
                    padding: '2px 6px',
                    borderRadius: 6,
                    fontSize: 11,
                    opacity: 0.75,
                    border: '1px solid rgba(128, 128, 128, 0.3)',
                  }}
                >
                  {candidate.normalized.format.toUpperCase()}
                </span>
              </div>
              <p>
                {candidate.match.artists.join(' / ')} · {q.label} ·{' '}
                {candidate.normalized.format.toUpperCase()} · {candidate.line_count} 行 · 匹配{' '}
                {Math.round(candidate.match.score * 100)}%
              </p>
              {candidate.match.version_mismatch && <p>版本标记不同，请试听核对。</p>}
              <p>
                时长差：
                {candidate.match.duration_difference_ms === null
                  ? '未知'
                  : `${(candidate.match.duration_difference_ms / 1000).toFixed(1)} 秒`}{' '}
                · 来源 ID：{candidate.source_id}
              </p>
              <button
                disabled={busy}
                onClick={() => {
                  setSelected(candidate);
                  setOffset(0);
                }}
              >
                预览并选择歌词
              </button>
            </article>
          );
        })}
      {selected &&
        (() => {
          const selectedQuality = inferCandidateQuality(selected);
          const hasWords = selected.normalized.lines.some((line) => (line.words?.length ?? 0) > 0);
          return (
            <div className="management-card">
              <h4>核对歌词候选</h4>
              <p>
                {selected.match.title} · {selected.plugin_id} ·{' '}
                <strong>{selectedQuality.label}</strong>
                {selectedQuality.word_timed &&
                  `（逐字覆盖 ${Math.round(selectedQuality.word_coverage * 100)}%）`}
                {selectedQuality.bilingual &&
                  ` · 译文覆盖 ${Math.round(selectedQuality.translation_coverage * 100)}%`}
              </p>
              {hasWords && (
                <label
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 8 }}
                >
                  <input
                    type="checkbox"
                    checked={showWordSplits}
                    onChange={(e) => setShowWordSplits(e.target.checked)}
                  />
                  显示逐字时间切分标记
                </label>
              )}
              <pre style={{ maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                {selected.normalized.lines
                  .slice(0, 100)
                  .map((line) => {
                    const body =
                      hasWords && showWordSplits && line.words && line.words.length > 0
                        ? line.words
                            .map((w) =>
                              w.start_ms !== undefined && w.start_ms !== null
                                ? `${w.text}⟨${(w.start_ms / 1000).toFixed(2)}s⟩`
                                : w.text,
                            )
                            .join(' ')
                        : line.text;
                    return (
                      `${line.time_ms === null ? '' : (line.time_ms / 1000).toFixed(2)} ${body}` +
                      (line.translation ? `\n${line.translation}` : '') +
                      (line.romanization ? `\n${line.romanization}` : '')
                    );
                  })
                  .join('\n')}
              </pre>
              <label>
                播放偏移（毫秒，正值延后）
                <input
                  type="number"
                  min="-60000"
                  max="60000"
                  step="100"
                  value={offset}
                  onChange={(e) => setOffset(Number(e.target.value))}
                />
              </label>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/manage/lyric-candidates/${selected.id}/apply`, {
                      method: 'POST',
                      body: JSON.stringify({
                        version: selected.lyrics_version,
                        file_version: selected.file_version,
                        offset_ms: offset,
                      }),
                    });
                    setSelected(null);
                    applied();
                    window.dispatchEvent(
                      new CustomEvent('wildstring:lyrics-updated', { detail: trackId }),
                    );
                    setMessage('已保存选中的歌词，音乐文件未修改。');
                  })
                }
              >
                确认使用此歌词
              </button>
              <button onClick={() => setSelected(null)}>取消选择</button>
            </div>
          );
        })()}
    </section>
  );
}
