import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, artist, time, type Lyrics } from './api';
import { coverUrl } from './cover';
import { PlaybackStyleControl, PlaybackVisual, usePlaybackStyle } from './playback-style';
import { FavoriteButton, type Favorites } from './favorites';
import {
  PlaybackControls,
  PlaybackError,
  QualityControl,
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
  player,
  onClose,
  favorites,
}: {
  player: Player;
  onClose: () => void;
  favorites: Favorites;
}) {
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const queueToggle = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState<'lyrics' | 'queue' | null>('lyrics');
  const [notice, setNotice] = useState('');
  const current = player.current;
  const style = usePlaybackStyle();
  const [palette, setPalette] = useState<{ track: string; colors: string[] } | null>(null);
  const colors = palette?.track === current?.id ? palette?.colors : null;
  useEffect(() => {
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    close.current?.focus({ preventScroll: true });
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Tab') {
        const controls = Array.from(
          dialog.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
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
  }, [onClose]);

  useEffect(() => {
    // A track change can disable the focused next/previous button or replace a lyric.
    if (
      !dialog.current?.contains(document.activeElement) ||
      document.activeElement?.matches(':disabled')
    ) {
      close.current?.focus({ preventScroll: true });
    }
  }, [current?.id]);

  return (
    <section
      className="fullscreen-player"
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label="全屏播放"
      style={
        {
          '--cover-primary': colors?.[0] || '#35373f',
          '--cover-accent': colors?.[1] || '#262a31',
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
        <button ref={close} className="collapse-player" aria-label="收起全屏播放" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m5 9 7 7 7-7" />
          </svg>
          <span>收起</span>
        </button>
        <span className="eyebrow">
          野弦 <span aria-hidden="true">/</span> WILDSTRING
        </span>
        <PlaybackStyleControl />
      </header>
      {current ? (
        <div className={`fullscreen-content ${panel ? '' : 'is-cover-only'}`}>
          <div className="fullscreen-record">
            <PlaybackVisual
              track={current}
              style={style}
              playing={player.playing && !player.buffering && !player.error}
              position={player.position}
              duration={player.duration}
              phase={player.visualPhase}
              onLyrics={() => setPanel((value) => (value === 'lyrics' ? null : 'lyrics'))}
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
              <p>{artist(current)}</p>
              <span>{current.album || '未知专辑'}</span>
            </div>
          </div>
          {panel === 'lyrics' && <LyricsPanel key={current.id} player={player} />}
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
          <QualityControl player={player} />
          <VolumeControl player={player} />
          <div className="fullscreen-panel-switches" role="group" aria-label="全屏显示内容">
            <button
              aria-label="显示歌词"
              aria-pressed={panel === 'lyrics'}
              title="歌词"
              onClick={() => setPanel((current) => (current === 'lyrics' ? null : 'lyrics'))}
            >
              词
            </button>
            <button
              ref={queueToggle}
              aria-label="显示播放队列"
              aria-pressed={panel === 'queue'}
              title="播放队列"
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
      {notice && (
        <p className="fullscreen-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}

function LyricsPanel({ player }: { player: Player }) {
  const current = player.current;
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [follow, setFollow] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const lines = useRef<(HTMLButtonElement | null)[]>([]);
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
      if ((lyrics.lines[middle].time_ms ?? Infinity) <= player.position * 1000) {
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
  }, [active, follow, lyrics]);

  const source =
    lyrics?.source === 'sidecar_lrc'
      ? '同名 LRC'
      : lyrics?.source === 'sidecar_text'
        ? '同名文本'
        : lyrics?.source === 'user'
          ? '自定义歌词'
          : '内嵌歌词';
  return (
    <div className="fullscreen-lyrics">
      <div className="lyrics-toolbar">
        <span>{lyrics && lyrics.kind !== 'none' ? source : '歌词'}</span>
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
      <div
        className="lyric-scroll"
        ref={scroll}
        onWheel={() => setFollow(false)}
        onTouchMove={() => setFollow(false)}
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
                  <p className="lyric-line">{line.text}</p>
                ) : (
                  <button
                    ref={(node) => {
                      lines.current[index] = node;
                    }}
                    className={`lyric-line ${active === index ? 'active-line' : ''}`}
                    aria-current={active === index ? 'true' : undefined}
                    aria-label={`跳转到 ${time(line.time_ms / 1000)}：${line.text || '间奏'}`}
                    disabled={!player.duration}
                    onClick={() => {
                      player.seek(line.time_ms! / 1000);
                      setFollow(true);
                    }}
                  >
                    {line.text || '♪'}
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
