import { useTranslation } from 'react-i18next';
import { HelpLabel } from './desktop-help';
import { useEffect, useRef, useState } from 'react';
import { api, time, type Lyrics, type Track } from './api';
import type { Player } from './player';
import { OnlineLyrics } from './source-plugins';

type Line = Lyrics['lines'][number];
interface Record {
  track_id: string;
  version: number;
  file_version: string;
  override: string | null;
  observed_text: string;
  text: string;
  effective: Lyrics;
}
function lrc(lines: Line[]) {
  return lines
    .map((line) => {
      const value = Math.round(line.time_ms ?? 0);
      return `[${Math.floor(value / 60000)
        .toString()
        .padStart(2, '0')}:${Math.floor((value % 60000) / 1000)
        .toString()
        .padStart(2, '0')}.${(value % 1000).toString().padStart(3, '0')}]${line.text}`;
    })
    .join('\n');
}
export function LyricsEditor({
  track,
  player,
  active,
}: {
  track: Track;
  player: Player;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [record, setRecord] = useState<Record | null>(null),
    [text, setText] = useState('');
  const [restore, setRestore] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [mode, setMode] = useState<'text' | 'timing' | 'preview'>('text');
  const [lines, setLines] = useState<Line[]>([]),
    [selected, setSelected] = useState(0),
    [preview, setPreview] = useState<Lyrics | null>(null);
  const [history, setHistory] = useState<{ lines: Line[]; selected: number }[]>([]),
    [shift, setShift] = useState('0');
  const workspace = useRef<HTMLDivElement>(null),
    selectedRow = useRef<HTMLLIElement>(null);
  const mine = player.current?.id === track.id;
  const endpoint = `/manage/tracks/${encodeURIComponent(track.id)}/lyrics`;
  const allTimed = lines.length > 0 && lines.every((line) => line.time_ms !== null);
  const request = useRef<AbortController | null>(null);
  async function load() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError('');
    try {
      const result = await api<Record>(endpoint, { signal: controller.signal });
      if (!controller.signal.aborted) {
        setRecord(result);
        setText(result.text);
        setRestore(false);
        setMode('text');
        setLines([]);
        setHistory([]);
        setPreview(null);
      }
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : t('lyricsEditor.loadError'));
    }
  }
  useEffect(() => {
    if (active && !record) void load();
    return () => {
      request.current?.abort();
    };
  }, [active, track.id]);
  useEffect(() => {
    if (mode === 'timing') selectedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [selected, mode]);
  const content = mode === 'timing' ? lrc(lines) : text;
  function change(next: Line[], target: number) {
    setHistory((items) => [...items.slice(-19), { lines, selected }]);
    setLines(next);
    setSelected(target);
    setNotice('');
    setError('');
    setRestore(false);
  }
  function stamp() {
    const audio = player.audio.current;
    if (
      !mine ||
      !audio ||
      audio.paused ||
      audio.seeking ||
      player.buffering ||
      selected >= lines.length
    )
      return;
    const milliseconds = Math.round(player.playbackTime() * 1000);
    const previous = selected > 0 ? lines[selected - 1].time_ms : null;
    if (previous !== null && milliseconds < previous) {
      setError(t('lyricsEditor.timeEarlierThanPrev'));
      return;
    }
    const nextTime = lines[selected + 1]?.time_ms;
    if (nextTime !== null && nextTime !== undefined && milliseconds > nextTime) {
      setError(t('lyricsEditor.timeLaterThanNext'));
      return;
    }
    change(
      lines.map((line, index) => (index === selected ? { ...line, time_ms: milliseconds } : line)),
      selected + 1,
    );
  }
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('lyricsEditor.actionFailed'));
    } finally {
      setBusy(false);
    }
  }
  function prepare() {
    void perform(async () => {
      const parsed = await api<Lyrics>(`${endpoint}/preview`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      const next = lines.length
        ? lines
        : parsed.kind === 'plain'
          ? text
              .trim()
              .split(/\r?\n/)
              .map((text) => ({ time_ms: null, text: text.trim() }))
          : parsed.lines.flatMap((line) =>
              line.text.split('\n').map((text) => ({ time_ms: line.time_ms, text })),
            );
      if (!next.length) {
        setError(t('lyricsEditor.emptyLyricsError'));
        return;
      }
      setLines(next);
      setSelected(
        Math.max(
          0,
          next.findIndex((line) => line.time_ms === null),
        ),
      );
      setMode('timing');
      setRestore(false);
      requestAnimationFrame(() => workspace.current?.focus());
    });
  }
  function checkPreview() {
    void perform(async () => {
      setPreview(
        await api<Lyrics>(`${endpoint}/preview`, {
          method: 'POST',
          body: JSON.stringify({ text: restore ? null : content }),
        }),
      );
      setMode('preview');
      if (!restore) setText(content);
    });
  }
  async function save() {
    if (!record) return;
    await perform(async () => {
      const result = await api<Record>(endpoint, {
        method: 'PUT',
        body: JSON.stringify({
          version: record.version,
          file_version: record.file_version,
          text: restore ? null : text,
        }),
      });
      setRecord(result);
      setText(result.text);
      setPreview(result.effective);
      setNotice(t('lyricsEditor.savedNotice'));
      window.dispatchEvent(new CustomEvent('wildstring:lyrics-updated', { detail: track.id }));
    });
  }
  function exportLrc() {
    if (!preview || preview.kind !== 'synced') return;
    const url = URL.createObjectURL(
      new Blob(
        [
          lrc(
            preview.lines.flatMap((line) =>
              line.text.split('\n').map((text) => ({ ...line, text })),
            ),
          ),
        ],
        { type: 'text/plain;charset=utf-8' },
      ),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${track.title.replace(/[\\/:*?"<>|]/g, '_')}.lrc`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function play() {
    if (mine) player.toggle();
    else player.start([track], 0);
  }
  let activeLine = -1;
  if (preview?.kind === 'synced' && mine)
    preview.lines.forEach((line, index) => {
      if (line.time_ms! <= player.position * 1000) activeLine = index;
    });
  return (
    <section
      hidden={!active}
      className="lyrics-editor"
      aria-label={t('lyricsEditor.sectionAria')}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (
          active &&
          mode === 'timing' &&
          event.code === 'Space' &&
          !event.nativeEvent.isComposing &&
          !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) &&
          !target.isContentEditable
        ) {
          event.preventDefault();
          if (!event.repeat) stamp();
        }
      }}
    >
      {!record ? (
        <p role={error ? 'alert' : 'status'}>
          {error || t('lyricsEditor.loading')}
          {error && <button onClick={() => void load()}>{t('lyricsEditor.reloadLyrics')}</button>}
        </p>
      ) : (
        <>
          <div className="lyrics-edit-heading">
            <div>
              <h3>
                {mode === 'timing'
                  ? t('lyricsEditor.modeTimingTitle')
                  : mode === 'preview'
                    ? t('lyricsEditor.modePreviewTitle')
                    : t('lyricsEditor.modeTextTitle')}
              </h3>
              <p className="muted">
                {mode === 'timing'
                  ? t('lyricsEditor.modeTimingHelp')
                  : t('lyricsEditor.modeTextHelp')}
              </p>
            </div>
            <span className="metadata-source">
              {record.override !== null
                ? t('lyricsEditor.sourceManual')
                : t('lyricsEditor.sourceFile')}
            </span>
          </div>
          <div className="lyric-editor-player">
            <button
              type="button"
              disabled={busy}
              onClick={play}
              aria-label={
                mine && player.playing
                  ? t('lyricsEditor.pauseTrackAria')
                  : t('lyricsEditor.playTrackAria')
              }
            >
              {mine && player.playing ? t('lyricsEditor.pauseLabel') : t('lyricsEditor.playLabel')}
            </button>
            <span>
              {time(mine ? player.position : 0)} /{' '}
              {time(mine ? player.duration : track.duration_ms / 1000)}
            </span>
            <input
              type="range"
              aria-label={t('lyricsEditor.progressAria')}
              min={0}
              max={mine ? player.duration || 0 : 0}
              step={0.01}
              value={mine ? player.position : 0}
              disabled={!mine || !player.duration}
              onChange={(event) => player.seek(Number(event.target.value))}
            />
          </div>
          {mine && player.error && (
            <p className="error" role="alert">
              {player.error}
            </p>
          )}
          {mode === 'text' && (
            <label className="metadata-field">
              {t('lyricsEditor.fieldContent')}
              <textarea
                aria-label={t('lyricsEditor.fieldContent')}
                rows={11}
                maxLength={524288}
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setRestore(false);
                  setLines([]);
                  setHistory([]);
                  setPreview(null);
                  setNotice('');
                }}
                placeholder={t('lyricsEditor.contentPlaceholder')}
              />
            </label>
          )}
          {mode === 'timing' && (
            <div
              ref={workspace}
              className="lyric-timing-workspace"
              tabIndex={0}
              aria-label={t('lyricsEditor.timingWorkspaceAria')}
            >
              <div className="lyric-cue" aria-live="polite">
                <small>{t('lyricsEditor.currentLine')}</small>
                <p>{selected > 0 ? lines[selected - 1].text || '♪' : t('lyricsEditor.introCue')}</p>
                <small>{t('lyricsEditor.nextLine')}</small>
                <p className="lyric-cue-next">
                  {lines[selected]?.text ||
                    (selected >= lines.length ? t('lyricsEditor.allCompleted') : '♪')}
                </p>
              </div>
              <div className="lyric-timing-actions">
                <button
                  className="primary"
                  disabled={
                    busy || !mine || !player.playing || player.buffering || selected >= lines.length
                  }
                  onClick={stamp}
                >
                  {t('lyricsEditor.stampNext')}
                </button>
                <button
                  disabled={!history.length || busy}
                  onClick={() => {
                    const previous = history.at(-1)!;
                    setLines(previous.lines);
                    setSelected(previous.selected);
                    setHistory((items) => items.slice(0, -1));
                    setError('');
                  }}
                >
                  {t('lyricsEditor.undoStamp')}
                </button>
                <span role="status">
                  {t('lyricsEditor.markedCount', {
                    timed: lines.filter((line) => line.time_ms !== null).length,
                    total: lines.length,
                  })}
                </span>
              </div>
              <ol className="lyric-timing-lines" aria-label={t('lyricsEditor.timingLinesAria')}>
                {lines.map((line, index) => (
                  <li
                    key={index}
                    ref={index === selected ? selectedRow : null}
                    className={index === selected ? 'timing-current' : ''}
                  >
                    <button
                      className="lyric-select"
                      aria-current={index === selected ? 'step' : undefined}
                      aria-label={t('lyricsEditor.selectLineAria', {
                        index: index + 1,
                        text: line.text || t('lyricsEditor.interlude'),
                      })}
                      onClick={() => setSelected(index)}
                    >
                      <small>{String(index + 1).padStart(2, '0')}</small>
                      <span>{line.text || '♪'}</span>
                    </button>
                    <input
                      type="number"
                      aria-label={t('lyricsEditor.lineTimeAria', { index: index + 1 })}
                      min={0}
                      step={0.01}
                      placeholder={t('lyricsEditor.unmarked')}
                      value={line.time_ms === null ? '' : line.time_ms / 1000}
                      onChange={(event) => {
                        const raw = event.target.value,
                          value = raw === '' ? null : Math.round(Number(raw) * 1000);
                        if (value !== null && (!Number.isFinite(value) || value < 0)) return;
                        change(
                          lines.map((item, i) =>
                            i === index ? { ...item, time_ms: value } : item,
                          ),
                          selected,
                        );
                      }}
                    />
                    <button
                      className="text-button"
                      aria-label={t('lyricsEditor.previewLineAria', { index: index + 1 })}
                      disabled={!mine || !player.duration || line.time_ms === null}
                      onClick={() => {
                        player.seek(line.time_ms! / 1000);
                        if (!player.playing) player.toggle();
                      }}
                    >
                      {t('lyricsEditor.previewLine')}
                    </button>
                  </li>
                ))}
              </ol>
              <div className="lyric-shift">
                <label>
                  <HelpLabel hint="lyricOffset">{t('lyricsEditor.shiftLabel')}</HelpLabel>
                  <input
                    type="number"
                    step={0.1}
                    value={shift}
                    onChange={(event) => setShift(event.target.value)}
                  />
                </label>
                <button
                  disabled={!lines.some((line) => line.time_ms !== null) || busy}
                  onClick={() => {
                    const offset = Number(shift) * 1000;
                    if (
                      !Number.isFinite(offset) ||
                      lines.some((line) => line.time_ms !== null && line.time_ms + offset < 0)
                    ) {
                      setError(t('lyricsEditor.negativeTimeError'));
                      return;
                    }
                    change(
                      lines.map((line) => ({
                        ...line,
                        time_ms: line.time_ms === null ? null : Math.round(line.time_ms + offset),
                      })),
                      selected,
                    );
                  }}
                >
                  {t('lyricsEditor.applyShift')}
                </button>
              </div>
            </div>
          )}
          {mode === 'preview' && (
            <div className="lyric-edit-preview" aria-label={t('lyricsEditor.previewAria')}>
              <p className="muted">
                {restore
                  ? t('lyricsEditor.previewRestore')
                  : preview?.kind === 'synced'
                    ? t('lyricsEditor.previewSynced')
                    : preview?.kind === 'plain'
                      ? t('lyricsEditor.previewPlain')
                      : t('lyricsEditor.previewEmpty')}
              </p>
              <ol>
                {preview?.lines.map((line, index) => (
                  <li key={index} className={index === activeLine ? 'timing-current' : ''}>
                    <span>{line.time_ms === null ? '—' : time(line.time_ms / 1000)}</span>
                    <p>{line.text || '♪'}</p>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {error && (
            <p className="error" role="alert">
              {error}{' '}
              <button className="text-button" disabled={busy} onClick={() => void load()}>
                {t('lyricsEditor.reloadLyrics')}
              </button>
            </p>
          )}
          {notice && (
            <p className="ai-status" role="status" aria-label={t('lyricsEditor.statusAria')}>
              {notice}
            </p>
          )}
          <div className="editor-footer lyric-editor-footer">
            <button
              disabled={busy}
              onClick={() => {
                if (mode === 'timing' && allTimed) setText(lrc(lines));
                setMode('text');
                setError('');
              }}
            >
              {t('lyricsEditor.textEditMode')}
            </button>
            <button disabled={busy || !text.trim()} onClick={prepare}>
              {t('lyricsEditor.timingMode')}
            </button>
            {mode === 'text' && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setText(record.observed_text);
                  setRestore(true);
                  setLines([]);
                  setHistory([]);
                  setNotice('');
                }}
              >
                {t('lyricsEditor.restoreFileLyrics')}
              </button>
            )}
            {mode === 'preview' && preview?.kind === 'synced' && (
              <button disabled={busy} onClick={exportLrc}>
                {t('lyricsEditor.exportLrc')}
              </button>
            )}
            <button
              className="primary"
              disabled={
                busy ||
                (mode === 'timing' &&
                  (!allTimed ||
                    lines.some(
                      (line, index) => index > 0 && line.time_ms! < lines[index - 1].time_ms!,
                    )))
              }
              onClick={() => (mode === 'preview' ? void save() : checkPreview())}
            >
              {busy
                ? t('lyricsEditor.processing')
                : mode === 'preview'
                  ? t('lyricsEditor.saveLyrics')
                  : t('lyricsEditor.previewLyrics')}
            </button>
          </div>
        </>
      )}
      <OnlineLyrics
        trackId={track.id}
        track={track}
        player={player}
        applied={() => {
          void load();
        }}
      />
    </section>
  );
}
