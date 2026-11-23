import { hints } from './help-content';
import { HelpLabel } from './desktop-help';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePlaybackPosition } from './playback-state';
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

function inferCandidateQuality(candidate: LyricCandidate) {
  const romanized = candidate.normalized.lines.some((line) => Boolean(line.romanization?.trim()));
  if (candidate.quality) return { ...candidate.quality, romanized };

  const lines = candidate.normalized.lines.filter((line) => line.text.trim().length > 0);
  const count = Math.max(1, lines.length);
  const timedRatio = lines.filter((line) => line.time_ms !== null).length / count;
  const wordRatio = lines.filter((line) => (line.words?.length ?? 0) > 0).length / count;
  const transRatio = lines.filter((line) => Boolean(line.translation?.trim())).length / count;
  const synced = candidate.normalized.kind === 'synced' && timedRatio >= 0.8;
  return {
    word_timed: synced && wordRatio >= 0.8,
    bilingual: synced && transRatio >= 0.8,
    level: synced ? 2 : 1,
    word_coverage: wordRatio,
    translation_coverage: transRatio,
    romanized,
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
  offset,
  onOffsetChange,
  trackId,
  track,
  player,
}: {
  candidate: LyricCandidate;
  offset: number;
  onOffsetChange: (offset: number) => void;
  trackId: string;
  track?: Track;
  player?: Player;
}) {
  const { t } = useTranslation();
  const isCurrentTrack = player && player.current?.id === trackId;
  const position = usePlaybackPosition(player?.position, isCurrentTrack);
  const currentPosMs = isCurrentTrack ? position * 1000 - offset : null;

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

  const listRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLDivElement>(null);
  const following = isCurrentTrack && player.playing;

  useEffect(() => {
    const list = listRef.current;
    const row = activeRowRef.current;
    if (!following || !list || !row) return;
    const rowTop = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.scrollTop += rowTop - (list.clientHeight - row.offsetHeight) / 2;
  }, [activeIndex, following]);

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
      {isCurrentTrack ? (
        <div className="status-playing-pill">
          <span
            aria-hidden="true"
            className={`audition-dot ${player.playing ? 'playing' : 'paused'}`}
          />
          <span>
            {player.playing
              ? t('sourcePlugins.auditionPlaying')
              : t('sourcePlugins.auditionPaused')}
          </span>
          <span className="audition-time">({time(position)})</span>
          <button type="button" className="text-button" onClick={player.toggle}>
            {player.playing ? t('sourcePlugins.pause') : t('sourcePlugins.play')}
          </button>
        </div>
      ) : player ? (
        <button type="button" className="text-button" onClick={handleStartTrack}>
          {t('sourcePlugins.startAudition')}
        </button>
      ) : null}

      <div
        ref={listRef}
        className="candidate-lyric-list"
        role="list"
        aria-label={t('sourcePlugins.previewLyrics')}
        tabIndex={0}
      >
        {candidate.normalized.lines.slice(0, 300).map((line, idx) => {
          const isActive = idx === activeIndex;
          const seekable = player && line.time_ms !== null;
          const RowContent = seekable ? 'button' : 'div';
          return (
            <div
              key={idx}
              ref={isActive ? activeRowRef : null}
              role="listitem"
              aria-current={isActive ? 'true' : undefined}
              className={`candidate-lyric-row ${isActive ? 'active' : ''}`}
            >
              <RowContent
                className="candidate-lyric-content"
                type={seekable ? 'button' : undefined}
                onClick={seekable ? () => handleSeek(line.time_ms) : undefined}
                title={seekable ? t('sourcePlugins.seekLineTitle') : undefined}
              >
                <span className="candidate-lyric-time">{formatCandidateMs(line.time_ms)}</span>
                <span className="candidate-lyric-body">
                  <span className="candidate-lyric-text">
                    {line.text || t('sourcePlugins.interlude')}
                  </span>
                  {line.translation && (
                    <span className="candidate-lyric-trans">{line.translation}</span>
                  )}
                  {line.romanization && (
                    <span className="candidate-lyric-roman">{line.romanization}</span>
                  )}
                </span>
              </RowContent>
            </div>
          );
        })}
      </div>
      <div
        className="audition-offset-controls"
        role="group"
        aria-label={t('sourcePlugins.fineTune')}
      >
        <label className="manual-offset-input">
          <span>{t('sourcePlugins.fineTune')}</span>
          <span className="manual-offset-value">
            <input
              type="number"
              aria-label={t('sourcePlugins.offsetMilliseconds')}
              min="-60000"
              max="60000"
              step="50"
              value={offset}
              onChange={(e) => onOffsetChange(Number(e.target.value))}
            />
            <span aria-hidden="true">ms</span>
          </span>
        </label>
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
            onClick={() => onOffsetChange(0)}
            title={t('sourcePlugins.resetOffset')}
            aria-label={t('sourcePlugins.resetOffset')}
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
      </div>
    </div>
  );
}

export function OnlineLyrics({
  trackId,
  track,
  player,
  applied,
  showHeading = true,
}: {
  trackId: string;
  track?: Track;
  player?: Player;
  applied: () => void;
  showHeading?: boolean;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{
    items: LyricCandidate[];
    jobs: { status: string; warnings: string[] }[];
  } | null>(null);
  const previewId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(null),
    [offset, setOffset] = useState(0);
  const [filterMode, setFilterMode] = useState<'all' | 'word' | 'bilingual'>('all');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [candidateMessageId, setCandidateMessageId] = useState<string | null>(null);
  const candidates = (result?.items ?? []).map((candidate) => ({
    candidate,
    quality: inferCandidateQuality(candidate),
  }));
  const words = candidates.filter(({ quality }) => quality.word_timed);
  const bilingual = candidates.filter(({ quality }) => quality.bilingual);
  const filters = { all: candidates, word: words, bilingual };
  const visibleCandidates = filters[filterMode];

  function changeFilter(mode: typeof filterMode) {
    setFilterMode(mode);
    if (!filters[mode].some(({ candidate }) => candidate.id === selectedId)) {
      setSelectedId(null);
    }
  }

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
  async function run(work: () => Promise<unknown>, candidateId: string | null = null) {
    setCandidateMessageId(candidateId);
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
      {showHeading && <h3>{t('sourcePlugins.onlineLyricsTitle')}</h3>}
      <button
        type="button"
        disabled={busy || running}
        onClick={() =>
          void run(() => api(`/manage/tracks/${trackId}/online-lyrics`, { method: 'POST' }))
        }
      >
        {t('sourcePlugins.searchOnlineLyrics')}
      </button>
      {running && <progress className="query-progress" />}
      {!candidateMessageId &&
        (message || !result || running || result.jobs[0]?.status === 'no_match') && (
          <p role="status">
            {message ||
              (running || !result
                ? t('sourcePlugins.queryingLyrics')
                : t('sourcePlugins.noLyricsFound'))}
          </p>
        )}
      {result?.jobs[0]?.warnings?.map((value) => (
        <p className="muted" key={value}>
          {value}
        </p>
      ))}
      {candidates.length > 1 && (
        <div className="button-row lyric-candidate-filters">
          <button
            type="button"
            aria-pressed={filterMode === 'all'}
            onClick={() => changeFilter('all')}
          >
            {t('sourcePlugins.filterAll', { count: candidates.length })}
          </button>
          <button
            type="button"
            aria-pressed={filterMode === 'word'}
            onClick={() => changeFilter('word')}
          >
            {t('sourcePlugins.filterWord', { count: words.length })}
          </button>
          <button
            type="button"
            aria-pressed={filterMode === 'bilingual'}
            onClick={() => changeFilter('bilingual')}
          >
            {t('sourcePlugins.filterBilingual', { count: bilingual.length })}
          </button>
        </div>
      )}
      {candidates.length > 0 && visibleCandidates.length === 0 && (
        <p className="muted">{t('sourcePlugins.noFilteredCandidates')}</p>
      )}
      {visibleCandidates.map(({ candidate, quality }) => {
        const expanded = selectedId === candidate.id;
        const match = candidate.match;
        // Use the same match criteria as the automatic lyric scan.
        const verifyVersion =
          match.version_mismatch ||
          match.score < 0.9 ||
          match.duration_difference_ms === null ||
          match.duration_difference_ms > 2500;
        const panelId = `${previewId}-${candidate.id}`;

        return (
          <article className="suggestion-card lyric-candidate" key={candidate.id}>
            <div className="lyric-candidate-heading">
              <div>
                <h4>
                  <a href={candidate.source_url} target="_blank" rel="noreferrer">
                    {match.title}
                  </a>
                </h4>
                <p className="lyric-candidate-identity muted">
                  {match.artists.join(' / ')} · {candidate.plugin_id}
                </p>
              </div>
              {verifyVersion && (
                <span className="lyric-candidate-badge lyric-candidate-warning">
                  {t('sourcePlugins.verifyVersion')}
                </span>
              )}
            </div>
            <div className="lyric-candidate-match">
              <strong>
                {t('sourcePlugins.candidateMatch', { score: Math.round(match.score * 100) })}
              </strong>
              <span>
                {match.duration_difference_ms === null
                  ? t('sourcePlugins.durationDiffUnknown')
                  : t('sourcePlugins.durationDiff', {
                      diff: (match.duration_difference_ms / 1000).toFixed(1),
                    })}
              </span>
            </div>
            <div className="lyric-candidate-quality muted">
              <span>
                {quality.word_timed
                  ? t('sourcePlugins.badgeWordTimed', {
                      pct: Math.round(quality.word_coverage * 100),
                    })
                  : quality.level >= 2
                    ? t('sourcePlugins.badgeLineTimed')
                    : t('sourcePlugins.badgeStatic')}
              </span>
              {quality.bilingual && (
                <span>
                  {t('sourcePlugins.badgeBilingual', {
                    pct: Math.round(quality.translation_coverage * 100),
                  })}
                </span>
              )}
              {quality.romanized && <span>{t('sourcePlugins.badgeRomanized')}</span>}
              <span>{candidate.normalized.format.toUpperCase()}</span>
            </div>
            <button
              type="button"
              disabled={busy}
              aria-expanded={expanded}
              aria-controls={expanded ? panelId : undefined}
              onClick={() => {
                setSelectedId(expanded ? null : candidate.id);
                setOffset(0);
              }}
            >
              {t(expanded ? 'sourcePlugins.collapsePreview' : 'sourcePlugins.previewLyrics')}
            </button>
            {expanded && (
              <div className="lyric-candidate-preview" id={panelId}>
                {match.version_mismatch && (
                  <p className="lyric-candidate-mismatch">
                    {t('sourcePlugins.versionMismatchNotice')}
                  </p>
                )}
                <InteractiveCandidateAudition
                  candidate={candidate}
                  offset={offset}
                  onOffsetChange={setOffset}
                  trackId={trackId}
                  track={track}
                  player={player}
                />
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`/manage/lyric-candidates/${candidate.id}/apply`, {
                        method: 'POST',
                        body: JSON.stringify({
                          version: candidate.lyrics_version,
                          file_version: candidate.file_version,
                          offset_ms: offset,
                        }),
                      });
                      setSelectedId(null);
                      applied();
                      window.dispatchEvent(
                        new CustomEvent('wildstring:lyrics-updated', { detail: trackId }),
                      );
                      setMessage(t('sourcePlugins.lyricsSavedNotice'));
                    }, candidate.id)
                  }
                >
                  {t('sourcePlugins.confirmLyrics')}
                </button>
              </div>
            )}
            {candidateMessageId === candidate.id && message && <p role="status">{message}</p>}
          </article>
        );
      })}
    </section>
  );
}
