import { useEffect, useState } from 'react';
import { api } from './api';

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

export function SourcePlugins() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, string>>({});
  async function load() {
    const result = await api<{ items: Plugin[] }>('/manage/source-plugins');
    setPlugins(result.items);
    setValues(Object.fromEntries(result.items.map((p) => [p.id, p.config])));
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
    void load().catch(() => setMessage('无法读取数据源插件。'));
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
    if (busy || dirty(p)) return;
    setBusy(true);
    setResults((prior) => ({ ...prior, [p.id]: '正在测试此插件…' }));
    try {
      const result = await api<{ count: number }>(`/manage/source-plugins/${p.id}/test`, {
        method: 'POST',
      });
      setResults((prior) => ({ ...prior, [p.id]: `检索已响应 · 返回 ${result.count} 条候选。` }));
    } catch (error) {
      setResults((prior) => ({
        ...prior,
        [p.id]: error instanceof Error ? error.message : '插件测试未完成。',
      }));
    } finally {
      setBusy(false);
    }
  }
  async function run(work: () => Promise<unknown>, success: string) {
    if (busy) return;
    setBusy(true);
    setMessage('正在处理…');
    try {
      await work();
      await load();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作未完成。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="management-card source-plugins">
      <h3>数据源插件</h3>
      <p className="muted">
        导入 WildString ZIP 插件包，独立启用元数据和歌词。插件运行 Python
        代码，只导入你信任的包。升级会保留配置并先停用；社区平台接口的可用性由各插件验证。
      </p>
      <label>
        插件 ZIP
        <input
          aria-label="数据源插件 ZIP"
          type="file"
          accept=".zip,application/zip"
          disabled={busy}
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
      </label>
      <button
        disabled={!file || busy}
        onClick={() =>
          void run(async () => {
            const imported = await api<Plugin>('/manage/source-plugins/import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/zip' },
              body: await file!.arrayBuffer(),
            });
            setFile(null);
            return imported;
          }, '插件已导入，请配置并启用。')
        }
      >
        导入插件
      </button>
      <p role="status">{message}</p>
      {plugins.map((p) => (
        <article className="suggestion-card" key={p.id}>
          <h4>{p.name}</h4>
          <p>
            <a href={p.upstream} target="_blank" rel="noreferrer">
              上游项目
            </a>{' '}
            · {p.license} · 插件 {p.plugin_version} · 配置版本 {p.version}
          </p>
          {!p.available && (
            <p role="status">
              运行环境缺少插件声明的依赖，请使用含社区插件运行时的官方镜像或按插件说明配置。
            </p>
          )}
          <fieldset disabled={busy}>
            {(['enabled', 'metadata_enabled', 'lyrics_enabled'] as const).map((field, index) => (
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
                {['启用此插件', '提供元数据与封面', '提供歌词'][index]}
              </label>
            ))}
            <label>
              来源优先级（数值越小越优先）
              <input
                type="number"
                min="0"
                max="100"
                value={p.priority}
                onChange={(e) =>
                  setPlugins(
                    plugins.map((value) =>
                      value.id === p.id ? { ...value, priority: Number(e.target.value) } : value,
                    ),
                  )
                }
              />
            </label>
            {p.settings.map((field) => (
              <label key={field.key}>
                {field.label}
                <input
                  type={
                    field.type === 'secret' ? 'password' : field.type === 'url' ? 'url' : 'text'
                  }
                  value={values[p.id]?.[field.key] || ''}
                  placeholder={p.configured_secrets.includes(field.key) ? '已保存，留空保留' : ''}
                  onChange={(e) =>
                    setValues({
                      ...values,
                      [p.id]: { ...values[p.id], [field.key]: e.target.value },
                    })
                  }
                />
              </label>
            ))}
            <button
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
                )
              }
            >
              保存 {p.name}
            </button>
            <button disabled={!p.enabled || dirty(p)} onClick={() => void testPlugin(p)}>
              测试 {p.name}
            </button>
            {dirty(p) && <p className="muted">请先保存当前插件设置，再测试。</p>}
            {results[p.id] && (
              <p role="status" aria-live="polite" className="plugin-test-result">
                {results[p.id]}
              </p>
            )}
            <a href={`/api/v1/manage/source-plugins/${p.id}/export`}>导出 ZIP</a>
            <label>
              升级插件 ZIP
              <input
                type="file"
                accept=".zip"
                onChange={(e) => {
                  const upgrade = e.target.files?.[0];
                  if (upgrade)
                    void run(
                      async () =>
                        api(
                          `/manage/source-plugins/import?expected_version=${p.version}&expected_id=${encodeURIComponent(p.id)}`,
                          {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/zip' },
                            body: await upgrade.arrayBuffer(),
                          },
                        ),
                      '插件已升级并停用，配置已保留，请重新核对后启用。',
                    );
                }}
              />
            </label>
            <button
              disabled={p.enabled}
              onClick={() =>
                void run(
                  () =>
                    api(`/manage/source-plugins/${p.id}?version=${p.version}`, {
                      method: 'DELETE',
                    }),
                  '插件已卸载。已有候选和歌词保留。',
                )
              }
            >
              卸载 {p.name}
            </button>
          </fieldset>
        </article>
      ))}
      {!plugins.length && <p>尚未导入数据源插件。QQ、酷狗和网易云插件 ZIP 随本次 Release 提供。</p>}
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
      words?: unknown[];
      translation?: string;
      romanization?: string;
    }[];
    format: string;
    layers?: Record<string, unknown[]>;
  };
};
export function OnlineLyrics({ trackId, applied }: { trackId: string; applied: () => void }) {
  const [result, setResult] = useState<{
    items: LyricCandidate[];
    jobs: { status: string; warnings: string[] }[];
  } | null>(null);
  const [selected, setSelected] = useState<LyricCandidate | null>(null),
    [offset, setOffset] = useState(0);
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
      {result?.items.map((candidate) => (
        <article className="suggestion-card" key={candidate.id}>
          <a href={candidate.source_url} target="_blank" rel="noreferrer">
            {candidate.plugin_id} · {candidate.match.title}
          </a>
          <p>
            {candidate.match.artists.join(' / ')} · {candidate.normalized.format.toUpperCase()} ·{' '}
            {candidate.line_count} 行 · 匹配 {Math.round(candidate.match.score * 100)}%
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
      ))}
      {selected && (
        <div className="management-card">
          <h4>核对歌词候选</h4>
          <p>
            {selected.match.title} · {selected.plugin_id}
          </p>
          <pre style={{ maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
            {selected.normalized.lines
              .slice(0, 100)
              .map(
                (line) =>
                  `${line.time_ms === null ? '' : (line.time_ms / 1000).toFixed(2)} ${line.text}` +
                  (line.translation ? `\n${line.translation}` : '') +
                  (line.romanization ? `\n${line.romanization}` : ''),
              )
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
      )}
    </section>
  );
}
