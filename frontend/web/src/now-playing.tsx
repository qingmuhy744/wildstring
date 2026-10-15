import { useEffect, useRef, useState } from 'react';
import { api, artist, time, type Lyrics } from './api';
import { Cover, coverUrl } from './cover';
import { PlaybackControls, PlaybackError, VolumeControl, type Player } from './player';

export function NowPlaying({ player, onClose }: { player: Player; onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const current = player.current;

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
            'button:not(:disabled), input:not(:disabled)',
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
        <span className="fullscreen-mode">NOW PLAYING</span>
      </header>
      {current ? (
        <div className="fullscreen-content">
          <div className="fullscreen-record">
            <Cover
              trackId={current.id}
              title={current.album || current.title}
              size={768}
              className="fullscreen-cover"
            />
            <div className="fullscreen-metadata">
              <h1>{current.title}</h1>
              <p>{artist(current)}</p>
              <span>{current.album || '未知专辑'}</span>
            </div>
          </div>
          <LyricsPanel key={current.id} player={player} />
        </div>
      ) : (
        <p className="lyric-empty">先播放一首喜欢的歌。</p>
      )}
      <footer className="fullscreen-controls">
        <div className="fullscreen-quality">
          {current && <span className="format">{current.format.toUpperCase()}</span>}
          <span>
            原音直放
            <small>
              第 {player.index + 1} 首 / 共 {player.queue.length} 首
            </small>
          </span>
        </div>
        <PlaybackControls player={player} />
        <VolumeControl player={player} />
        <PlaybackError player={player} />
      </footer>
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
        : '内嵌歌词';
  return (
    <div className="fullscreen-lyrics">
      <div className="lyrics-toolbar">
        <span>
          {lyrics && lyrics.kind !== 'none'
            ? `${source} · ${lyrics.kind === 'synced' ? '逐行同步' : '纯文本'}`
            : '歌词'}
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
