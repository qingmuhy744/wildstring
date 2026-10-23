import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { api, artist, time, type Lyrics } from './api';
import { Cover, coverUrl } from './cover';
import { PlaybackVisual, usePlaybackStyle } from './playback-style';
import { FavoriteButton, type Favorites } from './favorites';
import {
  PlaybackControls,
  PlaybackError,
  QualityControl,
  SleepControl,
  VolumeControl,
  type Player,
} from './player';
import { QueuePanel } from './queue-panel';

function coverPalette(image: HTMLImageElement): string[] | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, 32, 32);
    const pixels = context.getImageData(0, 0, 32, 32).data;
    const buckets = new Map<string, { color: number[]; weight: number }>();
    for (let index = 0; index < pixels.length; index += 4) {
      const color = [pixels[index], pixels[index + 1], pixels[index + 2]];
      const high = Math.max(...color),
        low = Math.min(...color);
      if (pixels[index + 3] < 128 || high < 25 || low > 235) continue;
      const key = color.map((value) => Math.floor(value / 32)).join(',');
      const bucket = buckets.get(key) || { color: [0, 0, 0], weight: 0 };
      const weight = 1 + (high - low) / 128;
      bucket.weight += weight;
      color.forEach((value, channel) => {
        bucket.color[channel] += value * weight;
      });
      buckets.set(key, bucket);
    }
    const ranked = [...buckets.values()]
      .sort((a, b) => b.weight - a.weight)
      .map((bucket) => bucket.color.map((value) => Math.round(value / bucket.weight)));
    if (!ranked.length) return null;
    const main = ranked[0];
    const accent =
      ranked.find(
        (color) =>
          color.reduce((distance, value, channel) => distance + (value - main[channel]) ** 2, 0) >
          12000,
      ) || main;
    return [main, accent].map((color) => `rgb(${color.join(' ')})`);
  } catch {
    return null;
  }
}

export function NowPlaying({
  active = true,
  player,
  onClose,
  favorites,
  onOpenAlbum,
  onOpenArtist,
  statusMessage,
}: {
  active?: boolean;
  player: Player;
  onClose: () => void;
  favorites: Favorites;
  onOpenAlbum: (track: NonNullable<Player['current']>) => void;
  onOpenArtist: (name: string) => void;
  statusMessage: string;
}) {
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const queueToggle = useRef<HTMLButtonElement>(null);
  const gesture = useRef<{
    x: number;
    y: number;
    moved: boolean;
    held: boolean;
    pointer: number;
    blank: boolean;
  }>({ x: 0, y: 0, moved: false, held: false, pointer: -1, blank: false });
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const artworkDialog = useRef<HTMLDialogElement>(null);
  const [artwork, setArtwork] = useState(false);
  const cancelHold = () => {
    clearTimeout(holdTimer.current);
    gesture.current.held = false;
  };
  const canPreview = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest('.playback-visual, .lyric-scroll');
  const isBlank = (target: EventTarget | null) =>
    target instanceof Element &&
    !!target.closest('.fullscreen-content') &&
    !target.closest(
      'button, a, input, select, textarea, .playback-visual, .lyric-scroll, .fullscreen-controls',
    );
  const [landscape, setLandscape] = useState(
    () => matchMedia('(orientation: landscape) and (max-height: 540px)').matches,
  );
  const [panel, setPanel] = useState<'lyrics' | 'queue' | null>(() =>
    landscape ? null : 'lyrics',
  );
  const [notice, setNotice] = useState('');
  const current = player.current;
  const style = usePlaybackStyle();
  const [palette, setPalette] = useState<{ track: string; colors: string[] } | null>(null);
  const colors = palette?.track === current?.id ? palette?.colors : null;
  useEffect(() => () => clearTimeout(holdTimer.current), []);
  useEffect(() => {
    if (!artwork) return;
    const preview = artworkDialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    preview?.showModal();
    return () => {
      preview?.close();
      previous?.focus({ preventScroll: true });
    };
  }, [artwork]);
  useEffect(() => {
    const query = matchMedia('(orientation: landscape) and (max-height: 540px)');
    const changed = () => setLandscape(query.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!active) {
      setArtwork(false);
      return;
    }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    close.current?.focus({ preventScroll: true });
    const handleKey = (event: KeyboardEvent) => {
      if (artworkDialog.current?.open) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Tab') {
        const controls = Array.from(
          dialog.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
          ) || [],
        ).filter((node) => node.getClientRects().length > 0);
        const first = controls[0],
          last = controls.at(-1);
        if (!dialog.current?.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = overflow;
      previous?.focus({ preventScroll: true });
    };
  }, [onClose, active]);

  useEffect(() => {
    if (!active) return;
    // A track change can disable the focused next/previous button or replace a lyric.
    if (
      !artworkDialog.current?.open &&
      (!dialog.current?.contains(document.activeElement) ||
        document.activeElement?.matches(':disabled'))
    ) {
      close.current?.focus({ preventScroll: true });
    }
  }, [current?.id, active]);

  return (
    <>
      <section
        className="fullscreen-player"
        hidden={!active}
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="全屏播放"
        data-panel={panel || 'cover'}
        onPointerDown={(event) => {
          cancelHold();
          if (!event.isPrimary || event.button !== 0) return;
          gesture.current = {
            x: event.clientX,
            y: event.clientY,
            moved: false,
            held: false,
            pointer: event.pointerId,
            blank: isBlank(event.target),
          };
          if (current && canPreview(event.target)) {
            holdTimer.current = setTimeout(() => {
              gesture.current.held = true;
              setArtwork(true);
            }, 500);
          }
        }}
        onPointerMove={(event) => {
          if (
            event.pointerId === gesture.current.pointer &&
            Math.hypot(event.clientX - gesture.current.x, event.clientY - gesture.current.y) > 8
          ) {
            gesture.current.moved = true;
            cancelHold();
          }
        }}
        onPointerUp={(event) => {
          const currentGesture = gesture.current;
          cancelHold();
          if (
            event.pointerId === currentGesture.pointer &&
            currentGesture.blank &&
            currentGesture.moved &&
            event.clientY - currentGesture.y > 72 &&
            event.clientY - currentGesture.y > Math.abs(event.clientX - currentGesture.x) * 1.15
          ) {
            onClose();
          }
        }}
        onPointerCancel={cancelHold}
        onPointerLeave={cancelHold}
        onTouchEnd={cancelHold}
        onTouchCancel={cancelHold}
        onContextMenu={(event) => {
          if (canPreview(event.target)) event.preventDefault();
        }}
        onClickCapture={(event) => {
          if (
            event.detail > 0 &&
            ((gesture.current.blank && gesture.current.moved) || gesture.current.held)
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        style={
          {
            '--cover-primary': colors?.[0] || '#35373f',
            '--cover-accent': colors?.[1] || '#262a31',
            display: active ? undefined : 'none',
          } as CSSProperties
        }
      >
        {current && (
          <div
            className="player-atmosphere"
            style={{ backgroundImage: `url("${coverUrl(current.id, 768)}")` }}
            aria-hidden="true"
          />
        )}
        <header className="fullscreen-header">
          <button
            ref={close}
            className="collapse-player"
            aria-label="收起全屏播放"
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m5 9 7 7 7-7" />
            </svg>
            <span>收起</span>
          </button>
          <span className="eyebrow">
            野弦 <span aria-hidden="true">/</span> WILDSTRING
          </span>
        </header>
        {current ? (
          <div className={`fullscreen-content ${panel ? '' : 'is-cover-only'}`}>
            <div className="fullscreen-record">
              <PlaybackVisual
                track={current}
                style={style}
                playing={
                  active &&
                  player.playing &&
                  !player.buffering &&
                  !player.error &&
                  !(landscape && panel) &&
                  !artwork
                }
                position={player.position}
                duration={player.duration}
                phase={player.visualPhase}
                onPreview={() => setArtwork(true)}
                onImage={(image) => {
                  if (image.currentSrc !== new URL(coverUrl(current.id, 768), location.href).href)
                    return;
                  const colors = coverPalette(image);
                  if (colors) setPalette({ track: current.id, colors });
                }}
              />
              <div className="fullscreen-metadata">
                <FavoriteButton track={current} favorites={favorites} />
                <h1>{current.title}</h1>
                <div className="fullscreen-subtitles">
                  <span className="fullscreen-artists">
                    {current.artists.map((name, index) => (
                      <span key={`${name}-${index}`}>
                        {index > 0 && <span aria-hidden="true"> / </span>}
                        <button
                          type="button"
                          className="player-meta-link player-artist-link"
                          onClick={() => onOpenArtist(name)}
                        >
                          {name}
                        </button>
                      </span>
                    ))}
                  </span>
                  {current.album && (
                    <span aria-hidden="true" className="meta-dot">
                      {' '}
                      ·{' '}
                    </span>
                  )}
                  <span className="fullscreen-album">
                    {current.album_id ? (
                      <button
                        type="button"
                        className="player-meta-link player-album-link"
                        aria-label={`查看所属专辑 ${current.album || '未知专辑'}`}
                        onClick={() => onOpenAlbum(current)}
                      >
                        {current.album}
                      </button>
                    ) : (
                      <span>{current.album || '未知专辑'}</span>
                    )}
                  </span>
                </div>
              </div>
            </div>
            {panel === 'lyrics' && (
              <LyricsPanel key={current.id} player={player} onTogglePanel={() => setPanel(null)} />
            )}
            {panel === 'queue' && (
              <QueuePanel
                player={player}
                embedded
                onNotice={setNotice}
                onClose={() => {
                  setPanel(null);
                  queueToggle.current?.focus({ preventScroll: true });
                }}
              />
            )}
          </div>
        ) : (
          <p className="lyric-empty">先播放一首喜欢的歌。</p>
        )}
        <footer className="fullscreen-controls">
          <div className="fullscreen-quality">
            {current && <span className="format">{current.format.toUpperCase()}</span>}
            <span>
              {player.playbackLabel}
              <small>
                第 {player.index + 1} 首 / 共 {player.queue.length} 首
              </small>
            </span>
          </div>
          <PlaybackControls player={player} />
          <div className="fullscreen-options">
            <SleepControl player={player} />
            <QualityControl player={player} />
            <VolumeControl player={player} />
            <div className="fullscreen-panel-switches" role="group" aria-label="全屏显示内容">
              <button
                aria-label="显示歌词"
                aria-pressed={panel === 'lyrics'}
                data-help="查看同步歌词"
                onClick={() => setPanel((current) => (current === 'lyrics' ? null : 'lyrics'))}
              >
                词
              </button>
              <button
                ref={queueToggle}
                aria-label="显示播放队列"
                aria-pressed={panel === 'queue'}
                data-help="查看播放队列"
                onClick={() => setPanel((current) => (current === 'queue' ? null : 'queue'))}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  aria-hidden="true"
                >
                  <path d="M8 6h12M8 12h12M8 18h12M3 6h1M3 12h1M3 18h1" strokeLinecap="round" />
                </svg>
                <span>{player.queue.length}</span>
              </button>
            </div>
          </div>
          <PlaybackError player={player} />
        </footer>
        {(statusMessage || notice) && (
          <p className="fullscreen-notice" role="status">
            {statusMessage || notice}
          </p>
        )}
      </section>
      {artwork && current && (
        <dialog
          ref={artworkDialog}
          className="artwork-preview"
          aria-label="大封面"
          onPointerDown={() => {
            gesture.current.held = false;
          }}
          onClickCapture={(event) => {
            if (event.detail > 0 && gesture.current.held) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onCancel={(event) => {
            event.preventDefault();
            setArtwork(false);
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setArtwork(false);
          }}
        >
          {current.has_cover && (
            <a
              className="artwork-preview-download"
              href={coverUrl(current.id, 768)}
              download={`${current.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100) || 'WildString'}-封面.jpg`}
            >
              下载封面
            </a>
          )}
          <button
            autoFocus
            className="artwork-preview-close"
            aria-label="关闭大封面"
            onClick={() => setArtwork(false)}
          >
            ×
          </button>
          <Cover trackId={current.id} title={current.title} size={768} />
        </dialog>
      )}
    </>
  );
}

type LyricSize = 'small' | 'medium' | 'large';

function LyricsPanel({ player, onTogglePanel }: { player: Player; onTogglePanel: () => void }) {
  const current = player.current;
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [follow, setFollow] = useState(true);
  const [coarse, setCoarse] = useState(() => matchMedia('(pointer: coarse)').matches);
  const [preview, setPreview] = useState<number | null>(null);
  const [showTranslation, setShowTranslation] = useState(true);
  const [showRomanization, setShowRomanization] = useState(false);
  const [lyricSize, setLyricSize] = useState<LyricSize>(() => {
    try {
      const value = localStorage.getItem('wildstring-lyric-size');
      return value === 'small' || value === 'large' ? value : 'medium';
    } catch {
      return 'medium';
    }
  });
  const scroll = useRef<HTMLDivElement>(null);
  const lines = useRef<(HTMLButtonElement | null)[]>([]);
  const drag = useRef<{ pointer: number; y: number; scrollTop: number; moved: boolean } | null>(
    null,
  );
  const [displayPosition, setDisplayPosition] = useState(player.position);
  useEffect(() => {
    try {
      localStorage.setItem('wildstring-lyric-size', lyricSize);
    } catch {
      /* Private browsing may deny local storage; the in-session value still works. */
    }
  }, [lyricSize]);
  useEffect(() => {
    if (!player.playing) {
      setDisplayPosition(player.position);
      return;
    }
    const anchor = player.position;
    const started = performance.now();
    let frame = 0;
    const tick = () => {
      setDisplayPosition(anchor + (performance.now() - started) / 1000);
      frame = requestAnimationFrame(tick);
    };
    setDisplayPosition(anchor);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [current?.id, player.playing, player.position]);
  useEffect(() => {
    const query = matchMedia('(pointer: coarse)');
    const changed = () => setCoarse(query.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  function selectCentered() {
    const container = scroll.current;
    if (!container) return;
    let closest: number | null = null;
    let distance = Infinity;
    lines.current.forEach((line, index) => {
      if (!line) return;
      const delta = Math.abs(
        line.offsetTop + line.clientHeight / 2 - container.scrollTop - container.clientHeight / 2,
      );
      if (delta < distance) {
        closest = index;
        distance = delta;
      }
    });
    setPreview(closest);
  }
  function startPointerDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    drag.current = {
      pointer: event.pointerId,
      y: event.clientY,
      scrollTop: event.currentTarget.scrollTop,
      moved: false,
    };
    setFollow(false);
  }
  function movePointerDrag(event: PointerEvent<HTMLDivElement>) {
    const currentDrag = drag.current;
    if (!currentDrag || currentDrag.pointer !== event.pointerId) return;
    const delta = event.clientY - currentDrag.y;
    if (Math.abs(delta) < 4) return;
    if (!currentDrag.moved) {
      currentDrag.moved = true;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* Ignore if pointer cannot be captured */
      }
    }
    event.currentTarget.scrollTop = Math.max(0, currentDrag.scrollTop - delta);
    selectCentered();
    event.preventDefault();
  }
  function endPointerDrag(event: PointerEvent<HTMLDivElement>) {
    const currentDrag = drag.current;
    if (!currentDrag || currentDrag.pointer !== event.pointerId) return;
    if (currentDrag.moved) {
      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* Ignore */
      }
    }
    drag.current = null;
  }
  useEffect(() => {
    const changed = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === current?.id)
        setRevision((value) => value + 1);
    };
    window.addEventListener('wildstring:lyrics-updated', changed);
    return () => window.removeEventListener('wildstring:lyrics-updated', changed);
  }, [current?.id]);
  useEffect(() => {
    if (!current) return;
    const controller = new AbortController();
    setLyrics(null);
    setError(false);
    api<Lyrics>(`/tracks/${encodeURIComponent(current.id)}/lyrics`, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setLyrics(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [current?.id, revision]);

  let active = -1;
  if (lyrics?.kind === 'synced') {
    let low = 0,
      high = lyrics.lines.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if ((lyrics.lines[middle].time_ms ?? Infinity) <= displayPosition * 1000) {
        active = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
  }
  useEffect(() => {
    const container = scroll.current,
      line = lines.current[active];
    if (!container) return;
    const center = () => {
      container.style.setProperty('--lyric-padding', `${container.clientHeight / 2}px`);
      if (follow && line)
        container.scrollTo({
          top: Math.max(0, line.offsetTop - container.clientHeight / 2 + line.clientHeight / 2),
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
    };
    center();
    const observer = new ResizeObserver(center);
    observer.observe(container);
    return () => observer.disconnect();
  }, [active, follow, lyrics, showTranslation, showRomanization, lyricSize]);

  const source =
    lyrics?.source === 'sidecar_lrc'
      ? '同名 LRC'
      : lyrics?.source === 'sidecar_text'
        ? '同名文本'
        : lyrics?.source === 'user'
          ? '自定义歌词'
          : lyrics?.source_url
            ? `歌词 · ${lyrics.source}`
            : '内嵌歌词';
  return (
    <div className={`fullscreen-lyrics lyric-size-${lyricSize}`}>
      <div className="lyrics-toolbar">
        {lyrics?.source_url ? (
          <a className="lyrics-source" href={lyrics.source_url} target="_blank" rel="noreferrer">
            {source}
          </a>
        ) : (
          <span className="lyrics-source">
            {lyrics && lyrics.kind !== 'none' ? source : '歌词'}
          </span>
        )}
        {lyrics?.lines.some((line) => line.translation) && (
          <button
            className="text-button"
            aria-pressed={showTranslation}
            onClick={() => setShowTranslation((value) => !value)}
          >
            译文
          </button>
        )}
        {lyrics?.lines.some((line) => line.romanization) && (
          <button
            className="text-button"
            aria-pressed={showRomanization}
            onClick={() => setShowRomanization((value) => !value)}
          >
            音译
          </button>
        )}
        <span className="lyrics-size-control" role="group" aria-label="歌词大小">
          {(['small', 'medium', 'large'] as LyricSize[]).map((size) => (
            <button
              key={size}
              className="text-button"
              aria-label={`歌词大小：${size === 'small' ? '小' : size === 'medium' ? '中' : '大'}`}
              aria-pressed={lyricSize === size}
              onClick={() => setLyricSize(size)}
            >
              {size === 'small' ? '小' : size === 'medium' ? '中' : '大'}
            </button>
          ))}
        </span>
        <button
          className="text-button"
          onClick={() => setFollow(true)}
          disabled={lyrics?.kind !== 'synced' || follow}
        >
          跟随播放
        </button>
        <button
          className="text-button"
          aria-label="重新读取歌词"
          onClick={() => setRevision((value) => value + 1)}
        >
          ↻
        </button>
      </div>
      <div className="lyric-viewport">
        <div
          className="lyric-scroll"
          ref={scroll}
          onPointerDown={startPointerDrag}
          onPointerMove={movePointerDrag}
          onPointerUp={endPointerDrag}
          onPointerCancel={endPointerDrag}
          onWheel={() => {
            setFollow(false);
            requestAnimationFrame(selectCentered);
          }}
          onTouchMove={() => {
            setFollow(false);
            selectCentered();
          }}
          onScroll={() => {
            if (!follow) selectCentered();
          }}
        >
          {error ? (
            <p className="lyric-empty" role="status">
              暂时无法读取歌词。播放不受影响，可点击上方 ↻ 重试。
            </p>
          ) : !lyrics ? (
            <p className="lyric-empty" role="status">
              正在读取歌词…
            </p>
          ) : lyrics.kind === 'none' ? (
            <div className="lyric-empty">
              <span>让旋律先说话。</span>
              <p>暂无本地歌词。支持音频内嵌歌词，或在同目录放入同名 .lrc 文件。</p>
            </div>
          ) : (
            <ol aria-label="歌词" className={lyrics.kind === 'plain' ? 'plain-lyrics' : ''}>
              {lyrics.lines.map((line, index) => (
                <li key={index}>
                  {line.time_ms === null ? (
                    <p className="lyric-line">
                      {line.text}
                      {showTranslation && line.translation && (
                        <span className="lyric-translation">{line.translation}</span>
                      )}
                      {showRomanization && line.romanization && (
                        <span className="lyric-romanization">{line.romanization}</span>
                      )}
                    </p>
                  ) : (
                    <button
                      ref={(node) => {
                        lines.current[index] = node;
                      }}
                      className={`lyric-line ${active === index ? 'active-line' : ''}`}
                      aria-current={active === index ? 'true' : undefined}
                      aria-label={
                        coarse
                          ? `切换到封面 ${time(line.time_ms / 1000)}：${line.text || '间奏'}`
                          : `跳转到 ${time(line.time_ms / 1000)}：${line.text || '间奏'}`
                      }
                      disabled={!player.duration}
                      onClick={() => {
                        if (coarse) {
                          onTogglePanel();
                        } else if (line.time_ms !== null) {
                          player.seek(line.time_ms / 1000);
                          setFollow(true);
                          setPreview(null);
                        }
                      }}
                    >
                      {line.words?.length
                        ? line.words.map((word, wordIndex) => {
                            const progress =
                              Math.max(
                                0,
                                Math.min(
                                  1,
                                  (displayPosition * 1000 - word.start_ms) /
                                    Math.max(1, word.end_ms - word.start_ms),
                                ),
                              ) * 100;
                            return (
                              <span
                                key={wordIndex}
                                className="lyric-word"
                                style={{
                                  backgroundImage: `linear-gradient(90deg, var(--accent) ${progress}%, var(--muted) ${progress}%)`,
                                }}
                              >
                                {word.text}
                              </span>
                            );
                          })
                        : line.text || '♪'}
                      {showTranslation && line.translation && (
                        <span className="lyric-translation">{line.translation}</span>
                      )}
                      {showRomanization && line.romanization && (
                        <span className="lyric-romanization">{line.romanization}</span>
                      )}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
        {!follow && preview !== null && lyrics?.lines[preview]?.time_ms != null && (
          <div className="lyric-seek-preview" role="group" aria-label="歌词跳转预览">
            <span>{time(lyrics.lines[preview].time_ms! / 1000)}</span>
            <hr />
            <button
              aria-label={`确认跳转到 ${time(lyrics.lines[preview].time_ms! / 1000)}`}
              onClick={() => {
                player.seek(lyrics.lines[preview!].time_ms! / 1000);
                setPreview(null);
                setFollow(true);
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m8 5 11 7-11 7z" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
