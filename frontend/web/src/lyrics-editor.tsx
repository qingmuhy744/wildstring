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
        setError(reason instanceof Error ? reason.message : '无法读取歌词。');
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
      setError('时间早于上一句，请先试听或调整上一句。');
      return;
    }
    const nextTime = lines[selected + 1]?.time_ms;
    if (nextTime !== null && nextTime !== undefined && milliseconds > nextTime) {
      setError('时间晚于下一句，请先调整下一句。');
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
      setError(reason instanceof Error ? reason.message : '操作未完成，请重试。');
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
        setError('请先填写歌词，每句一行。');
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
      setNotice('歌词已保存。');
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
      aria-label="歌词编辑器"
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
          {error || '读取歌词…'}
          {error && <button onClick={() => void load()}>重新读取歌词</button>}
        </p>
      ) : (
        <>
          <div className="lyrics-edit-heading">
            <div>
              <h3>
                {mode === 'timing'
                  ? '跟着音乐，逐句打点'
                  : mode === 'preview'
                    ? '歌词预览'
                    : '编辑歌词'}
              </h3>
              <p className="muted">
                {mode === 'timing'
                  ? '听到下一句开始时按空格，记录时间并切到这一句。第一下从第一句开始。'
                  : '每句一行，可粘贴纯文本或 LRC。保存后所有播放器都能读取。'}
              </p>
            </div>
            <span className="metadata-source">
              {record.override !== null ? '人工编辑' : '文件歌词'}
            </span>
          </div>
          <div className="lyric-editor-player">
            <button
              type="button"
              disabled={busy}
              onClick={play}
              aria-label={mine && player.playing ? '暂停打点歌曲' : '播放打点歌曲'}
            >
              {mine && player.playing ? 'Ⅱ 暂停' : '▶ 播放这首歌'}
            </button>
            <span>
              {time(mine ? player.position : 0)} /{' '}
              {time(mine ? player.duration : track.duration_ms / 1000)}
            </span>
            <input
              type="range"
              aria-label="歌词制作播放进度"
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
              歌词内容
              <textarea
                aria-label="歌词内容"
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
                placeholder="把歌词放在这里，每句一行。"
              />
            </label>
          )}
          {mode === 'timing' && (
            <div
              ref={workspace}
              className="lyric-timing-workspace"
              tabIndex={0}
              aria-label="逐行打点工作区"
            >
              <div className="lyric-cue" aria-live="polite">
                <small>当前句</small>
                <p>{selected > 0 ? lines[selected - 1].text || '♪' : '前奏，准备第一句'}</p>
                <small>下一句</small>
                <p className="lyric-cue-next">
                  {lines[selected]?.text || (selected >= lines.length ? '全部完成' : '♪')}
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
                  下一句（空格）
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
                  撤销打点
                </button>
                <span role="status">
                  {lines.filter((line) => line.time_ms !== null).length} / {lines.length} 句已标记
                </span>
              </div>
              <ol className="lyric-timing-lines" aria-label="打点歌词">
                {lines.map((line, index) => (
                  <li
                    key={index}
                    ref={index === selected ? selectedRow : null}
                    className={index === selected ? 'timing-current' : ''}
                  >
                    <button
                      className="lyric-select"
                      aria-current={index === selected ? 'step' : undefined}
                      aria-label={`选择第 ${index + 1} 句：${line.text || '间奏'}`}
                      onClick={() => setSelected(index)}
                    >
                      <small>{String(index + 1).padStart(2, '0')}</small>
                      <span>{line.text || '♪'}</span>
                    </button>
                    <input
                      type="number"
                      aria-label={`第 ${index + 1} 句时间（秒）`}
                      min={0}
                      step={0.01}
                      placeholder="未标记"
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
                      aria-label={`试听第 ${index + 1} 句`}
                      disabled={!mine || !player.duration || line.time_ms === null}
                      onClick={() => {
                        player.seek(line.time_ms! / 1000);
                        if (!player.playing) player.toggle();
                      }}
                    >
                      试听
                    </button>
                  </li>
                ))}
              </ol>
              <div className="lyric-shift">
                <label>
                  整体偏移（秒）
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
                      setError('偏移后时间不能小于 0。');
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
                  应用偏移
                </button>
              </div>
            </div>
          )}
          {mode === 'preview' && (
            <div className="lyric-edit-preview" aria-label="歌词修改预览">
              <p className="muted">
                {restore
                  ? '将恢复文件中的歌词。'
                  : preview?.kind === 'synced'
                    ? '同步歌词，可边播放边核对。'
                    : preview?.kind === 'plain'
                      ? '纯文本歌词，尚未打点。'
                      : '将不显示歌词。'}
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
                重新读取歌词
              </button>
            </p>
          )}
          {notice && (
            <p className="ai-status" role="status">
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
              文本编辑
            </button>
            <button disabled={busy || !text.trim()} onClick={prepare}>
              逐行打点
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
                恢复文件歌词
              </button>
            )}
            {mode === 'preview' && preview?.kind === 'synced' && (
              <button disabled={busy} onClick={exportLrc}>
                导出 LRC
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
              {busy ? '处理中…' : mode === 'preview' ? '保存歌词' : '预览歌词'}
            </button>
          </div>
        </>
      )}
      <OnlineLyrics
        trackId={track.id}
        applied={() => {
          void load();
        }}
      />
    </section>
  );
}
