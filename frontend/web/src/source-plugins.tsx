import { hints } from './help-content';
import { HelpLabel } from './desktop-help';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import i18n from './i18n';
import { api, time, type Track } from './api';
import { Icon } from './icons';
import type { Player } from './player';
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
  const { t } = useTranslation();
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
    void load().catch(() => setMessage({ kind: 'error', text: t('sourcePlugins.loadError') }));
  }, [t]);
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
    setResults((prior) => ({
      ...prior,
      [p.id]: { kind: 'pending', text: t('sourcePlugins.testing') },
    }));
    try {
      const result = await api<{ count: number }>(`/manage/source-plugins/${p.id}/test`, {
        method: 'POST',
      });
      setResults((prior) => ({
        ...prior,
        [p.id]: {
          kind: 'success',
          text: t('sourcePlugins.testSuccess', { count: result.count }),
        },
      }));
    } catch (error) {
      setResults((prior) => ({
        ...prior,
        [p.id]: {
          kind: 'error',
          text: error instanceof Error ? error.message : t('sourcePlugins.testFailed'),
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
    feedback({ kind: 'pending', text: t('sourcePlugins.processing') });
    try {
      await work();
      await load(pluginId);
      feedback({ kind: 'success', text: success });
      return true;
    } catch (error) {
      feedback({
        kind: 'error',
        text: error instanceof Error ? error.message : t('sourcePlugins.actionFailed'),
      });
      return false;
    } finally {
      pending.current = false;
      setOperation(null);
    }
  }
  return (
    <section className="source-plugins" aria-labelledby="source-plugins-heading">
      <header className="source-plugins-heading">
        <h3 id="source-plugins-heading">{t('sourcePlugins.title')}</h3>
        <p className="muted">{t('sourcePlugins.description')}</p>
      </header>
      <section className="plugin-import" aria-labelledby="plugin-import-heading">
        <h4 id="plugin-import-heading">{t('sourcePlugins.importTitle')}</h4>
        <p className="muted">{t('sourcePlugins.importDescription')}</p>
        <PluginZipUpload
          inputLabel={t('sourcePlugins.zipInputLabel')}
          actionLabel={t('sourcePlugins.importAction')}
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
              t('sourcePlugins.importSuccess'),
              'import',
            )
          }
        />
        <PluginFeedback value={message} className="plugin-import-result" />
      </section>
      <div className="plugin-list-heading">
        <h4>{t('sourcePlugins.installedTitle')}</h4>
        <span>{t('sourcePlugins.sourcesCount', { count: plugins.length })}</span>
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
                  {t('sourcePlugins.versionInfo', {
                    pluginVersion: p.plugin_version,
                    version: p.version,
                  })}
                </p>
                <a href={p.upstream} target="_blank" rel="noreferrer">
                  {t('sourcePlugins.upstreamLink')}
                </a>
                <span className="plugin-license">{p.license}</span>
              </div>
              <span className={`plugin-state${p.enabled ? ' is-enabled' : ''}`}>
                {dirty(p)
                  ? t('sourcePlugins.statusUnsaved')
                  : p.enabled
                    ? t('sourcePlugins.statusEnabled')
                    : t('sourcePlugins.statusDisabled')}
              </span>
            </header>
            {!p.available && (
              <p className="plugin-feedback" data-kind="error" role="status">
                {t('sourcePlugins.missingDependencies')}
              </p>
            )}
            <fieldset disabled={busy}>
              <legend className="plugin-sr-only">
                {t('sourcePlugins.configLegend', { name: p.name })}
              </legend>
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
                        <HelpLabel hint="pluginEnabled">
                          {t('sourcePlugins.enablePlugin')}
                        </HelpLabel>
                      ) : (
                        [
                          t('sourcePlugins.enablePlugin'),
                          t('sourcePlugins.provideMetadata'),
                          t('sourcePlugins.provideLyrics'),
                        ][index]
                      )}
                    </label>
                  ),
                )}
              </div>
              <div className="plugin-config-grid">
                <label>
                  <HelpLabel hint="sourcePriority">{t('sourcePlugins.sourcePriority')}</HelpLabel>
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
                        p.configured_secrets.includes(field.key)
                          ? t('sourcePlugins.secretPlaceholder')
                          : ''
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
                  aria-label={t('sourcePlugins.savePluginAria', { name: p.name })}
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
                      t('sourcePlugins.savedNotice'),
                      `save:${p.id}`,
                      p.id,
                    )
                  }
                >
                  {operation === `save:${p.id}`
                    ? t('sourcePlugins.saving')
                    : t('sourcePlugins.saveSettings')}
                </button>
                <button
                  aria-label={t('sourcePlugins.testPluginAria', { name: p.name })}
                  disabled={!p.enabled || dirty(p)}
                  onClick={() => void testPlugin(p)}
                >
                  {operation === `test:${p.id}`
                    ? t('sourcePlugins.testingButton')
                    : t('sourcePlugins.testConnection')}
                </button>
              </div>
              {dirty(p) && (
                <p className="muted plugin-unsaved">{t('sourcePlugins.unsavedSettings')}</p>
              )}
              <PluginFeedback value={notices[p.id]} className="plugin-operation-result" />
              <PluginFeedback value={results[p.id]} className="plugin-test-result" />
              <details className="plugin-maintenance">
                <summary data-help={hints.pluginMaintenance}>
                  <strong>{t('sourcePlugins.maintenanceTitle')}</strong>
                  <span>{t('sourcePlugins.maintenanceSubtitle')}</span>
                  <Icon name="chevron" />
                </summary>
                <div className="plugin-maintenance-content">
                  <h5>{t('sourcePlugins.upgradeTitle', { name: p.name })}</h5>
                  <p className="muted">{t('sourcePlugins.upgradeDescription')}</p>
                  <PluginZipUpload
                    inputLabel={t('sourcePlugins.upgradeZipInput', { name: p.name })}
                    actionLabel={t('sourcePlugins.confirmUpgrade')}
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
                        t('sourcePlugins.upgradeSuccess'),
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
                      {t('sourcePlugins.exportZip')}
                    </a>
                    <div>
                      <button
                        className="plugin-uninstall"
                        aria-label={t('sourcePlugins.uninstallPluginAria', { name: p.name })}
                        disabled={p.enabled || dirty(p)}
                        onClick={() =>
                          void run(
                            () =>
                              api(`/manage/source-plugins/${p.id}?version=${p.version}`, {
                                method: 'DELETE',
                              }),
                            t('sourcePlugins.uninstallSuccess', { name: p.name }),
                            `uninstall:${p.id}`,
                          )
                        }
                      >
                        {t('sourcePlugins.uninstallPlugin')}
                      </button>
                      <small>
                        {p.enabled || dirty(p)
                          ? t('sourcePlugins.uninstallDisabledHint')
                          : t('sourcePlugins.uninstallHint')}
                      </small>
                    </div>
                  </div>
                </div>
              </details>
            </fieldset>
          </article>
        ))}
      </div>
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

function candidateQualityLabel(
  quality: { word_timed: boolean; bilingual: boolean; level: number; lines: number },
  t: TFunction,
) {
  if (quality.word_timed) {
    return quality.bilingual
      ? t('sourcePlugins.qualityBilingualWordTimed')
      : t('sourcePlugins.qualityWordTimed');
  }
  if (quality.level >= 2) {
    return quality.bilingual
      ? t('sourcePlugins.qualityBilingualLineTimed')
      : t('sourcePlugins.qualityLineTimed');
  }
  if (quality.lines > 0 || quality.level === 1) {
    return t('sourcePlugins.qualityStatic');
  }
  return t('sourcePlugins.qualityNone');
}

function inferCandidateQuality(
  candidate: LyricCandidate,
  t: TFunction | ((key: string) => string) = i18n.t.bind(i18n),
) {
  const hasRoman = candidate.normalized.lines.some((line) => Boolean(line.romanization?.trim()));
  if (candidate.quality) {
    return {
      ...candidate.quality,
      label: candidateQualityLabel(
        { ...candidate.quality, lines: candidate.quality.lines ?? 0 },
        t as TFunction,
      ),
      romanized: hasRoman,
    };
  }
  const lines = candidate.normalized.lines.filter((line) => line.text.trim().length > 0);
  const count = Math.max(1, lines.length);
  const timedRatio = lines.filter((line) => line.time_ms !== null).length / count;
  const wordRatio = lines.filter((line) => (line.words?.length ?? 0) > 0).length / count;
  const transRatio = lines.filter((line) => Boolean(line.translation?.trim())).length / count;
  const synced = candidate.normalized.kind === 'synced' && timedRatio >= 0.8;
  const wordTimed = synced && wordRatio >= 0.8;
  const bilingual = synced && transRatio >= 0.8;
  const level = wordTimed
    ? bilingual
      ? 5
      : 4
    : synced
      ? bilingual
        ? 3
        : 2
      : lines.length > 0
        ? 1
        : 0;
  const label = candidateQualityLabel(
    { word_timed: wordTimed, bilingual, level, lines: lines.length },
    t as TFunction,
  );
  return {
    level,
    label,
    word_timed: wordTimed,
    bilingual,
    word_coverage: wordRatio,
    translation_coverage: transRatio,
    lines: lines.length,
    romanized: hasRoman,
  };
}

function formatCandidateMs(ms: number | null): string {
  if (ms === null || ms === undefined) return '--:--';
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(2);
  return `${String(minutes).padStart(2, '0')}:${seconds.padStart(5, '0')}`;
}

function InteractiveCandidateAudition({
  candidate,
  hasWords,
  showWordSplits,
  offset,
  onOffsetChange,
  trackId,
  track,
  player,
}: {
  candidate: LyricCandidate;
  hasWords: boolean;
  showWordSplits: boolean;
  offset: number;
  onOffsetChange: (offset: number) => void;
  trackId: string;
  track?: Track;
  player?: Player;
}) {
  const { t } = useTranslation();
  const isPlayingThisTrack = player && player.current?.id === trackId;
  const currentPosMs = isPlayingThisTrack ? player.position * 1000 - offset : null;

  const activeIndex = useMemo(() => {
    if (currentPosMs === null) return -1;
    let found = -1;
    for (let i = 0; i < candidate.normalized.lines.length; i++) {
      const line = candidate.normalized.lines[i];
      if (line.time_ms !== null && line.time_ms <= currentPosMs) {
        found = i;
      } else if (line.time_ms !== null && line.time_ms > currentPosMs) {
        break;
      }
    }
    return found;
  }, [currentPosMs, candidate.normalized.lines]);

  const activeRowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (activeIndex >= 0 && activeRowRef.current) {
      activeRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeIndex]);

  function handleSeek(lineTimeMs: number | null) {
    if (lineTimeMs === null || !player) return;
    const targetSeconds = Math.max(0, (lineTimeMs + offset) / 1000);
    if (player.current?.id !== trackId) {
      if (track) {
        player.start([track], 0);
        setTimeout(() => player.seek(targetSeconds), 250);
      } else {
        api<Track>(`/tracks/${trackId}`)
          .then((t) => {
            player.start([t], 0);
            setTimeout(() => player.seek(targetSeconds), 250);
          })
          .catch(() => {});
      }
      return;
    }
    player.seek(targetSeconds);
    if (!player.playing) {
      player.toggle();
    }
  }

  function handleStartTrack() {
    if (!player) return;
    if (track) {
      player.start([track], 0);
    } else {
      api<Track>(`/tracks/${trackId}`)
        .then((t) => player.start([t], 0))
        .catch(() => {});
    }
  }

  return (
    <div className="candidate-audition-container">
      <div className="candidate-audition-bar">
        <div className="audition-player-status">
          {isPlayingThisTrack ? (
            <div className="status-playing-pill">
              <span className={`audition-dot ${player.playing ? 'playing' : 'paused'}`} />
              <span>
                {player.playing
                  ? t('sourcePlugins.auditionPlaying')
                  : t('sourcePlugins.auditionPaused')}
              </span>
              <span className="audition-time">({time(player.position)})</span>
              <button
                type="button"
                className="text-button audition-ctrl-btn"
                onClick={player.toggle}
              >
                {player.playing ? t('sourcePlugins.pause') : t('sourcePlugins.play')}
              </button>
            </div>
          ) : player ? (
            <button
              type="button"
              className="text-button audition-start-btn"
              onClick={handleStartTrack}
            >
              {t('sourcePlugins.startAudition')}
            </button>
          ) : null}
        </div>

        <div className="audition-offset-controls">
          <span className="offset-label">{t('sourcePlugins.fineTune')}</span>
          <div className="nudge-btn-group">
            <button
              type="button"
              onClick={() => onOffsetChange(offset - 500)}
              title={t('sourcePlugins.earlier500ms')}
            >
              -500ms
            </button>
            <button
              type="button"
              onClick={() => onOffsetChange(offset - 200)}
              title={t('sourcePlugins.earlier200ms')}
            >
              -200ms
            </button>
            <button
              type="button"
              className={offset === 0 ? 'nudge-zero-active' : ''}
              onClick={() => onOffsetChange(0)}
              title={t('sourcePlugins.resetOffset')}
            >
              0
            </button>
            <button
              type="button"
              onClick={() => onOffsetChange(offset + 200)}
              title={t('sourcePlugins.later200ms')}
            >
              +200ms
            </button>
            <button
              type="button"
              onClick={() => onOffsetChange(offset + 500)}
              title={t('sourcePlugins.later500ms')}
            >
              +500ms
            </button>
          </div>
          <label className="manual-offset-input">
            <input
              type="number"
              min="-60000"
              max="60000"
              step="50"
              value={offset}
              onChange={(e) => onOffsetChange(Number(e.target.value))}
            />
            <span>ms</span>
          </label>
        </div>
      </div>

      <p className="audition-hint">{t('sourcePlugins.auditionTip')}</p>

      <pre className="candidate-lyric-list" role="list">
        {candidate.normalized.lines.slice(0, 300).map((line, idx) => {
          const isActive = idx === activeIndex;
          return (
            <div
              key={idx}
              ref={isActive ? activeRowRef : null}
              className={`candidate-lyric-row ${isActive ? 'active' : ''}`}
              onClick={() => handleSeek(line.time_ms)}
              title={line.time_ms !== null ? t('sourcePlugins.seekLineTitle') : undefined}
            >
              <span className="candidate-lyric-time">{formatCandidateMs(line.time_ms)}</span>
              <div className="candidate-lyric-body">
                <div className="candidate-lyric-text">
                  {hasWords && showWordSplits && line.words && line.words.length > 0
                    ? line.words.map((w, wIdx) => (
                        <span key={wIdx} className="word-chunk">
                          {w.text}
                          {w.start_ms !== undefined && w.start_ms !== null && (
                            <span className="word-split-chip">
                              ⟨{(w.start_ms / 1000).toFixed(2)}s⟩
                            </span>
                          )}
                        </span>
                      ))
                    : line.text || t('sourcePlugins.interlude')}
                </div>
                {line.translation && (
                  <div className="candidate-lyric-trans">{line.translation}</div>
                )}
                {line.romanization && (
                  <div className="candidate-lyric-roman">{line.romanization}</div>
                )}
              </div>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

export function OnlineLyrics({
  trackId,
  track,
  player,
  applied,
}: {
  trackId: string;
  track?: Track;
  player?: Player;
  applied: () => void;
}) {
  const { t } = useTranslation();
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
    void load().catch(() => setMessage(t('sourcePlugins.loadLyricsError')));
  }, [trackId, t]);
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
      setMessage(error instanceof Error ? error.message : t('sourcePlugins.lyricsActionFailed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="online-lyrics">
      <h3>{t('sourcePlugins.onlineLyricsTitle')}</h3>
      <p className="muted">{t('sourcePlugins.onlineLyricsDescription')}</p>
      <button
        disabled={busy || running}
        onClick={() =>
          void run(() => api(`/manage/tracks/${trackId}/online-lyrics`, { method: 'POST' }))
        }
      >
        {t('sourcePlugins.searchOnlineLyrics')}
      </button>
      {running && (
        <progress
          className="query-progress"
          style={{ width: '100%', height: '4px', margin: '8px 0', display: 'block' }}
        />
      )}
      <p role="status">
        {message ||
          (running
            ? t('sourcePlugins.queryingLyrics')
            : result?.jobs[0]?.status === 'no_match'
              ? t('sourcePlugins.noLyricsFound')
              : '')}
      </p>
      {result?.jobs[0]?.warnings?.map((value) => (
        <p className="muted" key={value}>
          {value}
        </p>
      ))}
      {result && result.items.length > 1 && (
        <div
          className="button-row"
          style={{
            marginBottom: 8,
            overflowX: 'auto',
            display: 'flex',
            gap: '8px',
            flexWrap: 'nowrap',
          }}
        >
          <button
            type="button"
            style={{ whiteSpace: 'nowrap' }}
            aria-pressed={filterMode === 'all'}
            onClick={() => setFilterMode('all')}
          >
            {t('sourcePlugins.filterAll', { count: result.items.length })}
          </button>
          <button
            type="button"
            style={{ whiteSpace: 'nowrap' }}
            aria-pressed={filterMode === 'word'}
            onClick={() => setFilterMode('word')}
          >
            {t('sourcePlugins.filterWord', {
              count: result.items.filter((item) => inferCandidateQuality(item).word_timed).length,
            })}
          </button>
          <button
            type="button"
            style={{ whiteSpace: 'nowrap' }}
            aria-pressed={filterMode === 'bilingual'}
            onClick={() => setFilterMode('bilingual')}
          >
            {t('sourcePlugins.filterBilingual', {
              count: result.items.filter((item) => inferCandidateQuality(item).bilingual).length,
            })}
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
          const q = inferCandidateQuality(candidate, t);
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
                    color: q.word_timed ? 'var(--on-accent)' : 'inherit',
                  }}
                >
                  {q.word_timed
                    ? t('sourcePlugins.badgeWordTimed', {
                        pct: Math.round(q.word_coverage * 100),
                      })
                    : q.level >= 2
                      ? t('sourcePlugins.badgeLineTimed')
                      : t('sourcePlugins.badgeStatic')}
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
                    {t('sourcePlugins.badgeBilingual', {
                      pct: Math.round(q.translation_coverage * 100),
                    })}
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
                    {t('sourcePlugins.badgeRomanized')}
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
                {t('sourcePlugins.candidateSummary', {
                  artists: candidate.match.artists.join(' / '),
                  label: q.label,
                  format: candidate.normalized.format.toUpperCase(),
                  count: candidate.line_count,
                  score: Math.round(candidate.match.score * 100),
                })}
              </p>
              {candidate.match.version_mismatch && (
                <p>{t('sourcePlugins.versionMismatchNotice')}</p>
              )}
              <p>
                {candidate.match.duration_difference_ms === null
                  ? t('sourcePlugins.durationDiffUnknown', { id: candidate.source_id })
                  : t('sourcePlugins.durationDiff', {
                      diff: (candidate.match.duration_difference_ms / 1000).toFixed(1),
                      id: candidate.source_id,
                    })}
              </p>
              <button
                disabled={busy}
                onClick={() => {
                  setSelected(candidate);
                  setOffset(0);
                }}
              >
                {t('sourcePlugins.previewAndSelect')}
              </button>
            </article>
          );
        })}
      {selected &&
        (() => {
          const selectedQuality = inferCandidateQuality(selected, t);
          const hasWords = selected.normalized.lines.some((line) => (line.words?.length ?? 0) > 0);
          return (
            <div className="management-card">
              <h4>{t('sourcePlugins.reviewTitle')}</h4>
              <p>
                {selected.match.title} · {selected.plugin_id} ·{' '}
                <strong>{selectedQuality.label}</strong>
                {selectedQuality.word_timed &&
                  t('sourcePlugins.selectedQualityWord', {
                    pct: Math.round(selectedQuality.word_coverage * 100),
                  })}
                {selectedQuality.bilingual &&
                  t('sourcePlugins.selectedQualityTrans', {
                    pct: Math.round(selectedQuality.translation_coverage * 100),
                  })}
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
                  {t('sourcePlugins.showWordSplits')}
                </label>
              )}
              <InteractiveCandidateAudition
                candidate={selected}
                hasWords={hasWords}
                showWordSplits={showWordSplits}
                offset={offset}
                onOffsetChange={setOffset}
                trackId={trackId}
                track={track}
                player={player}
              />
              <div className="button-row" style={{ marginTop: 12 }}>
                <button
                  className="primary"
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
                      setMessage(t('sourcePlugins.lyricsSavedNotice'));
                    })
                  }
                >
                  {t('sourcePlugins.confirmLyrics')}
                </button>
                <button type="button" onClick={() => setSelected(null)}>
                  {t('sourcePlugins.cancelSelection')}
                </button>
              </div>
            </div>
          );
        })()}
    </section>
  );
}
