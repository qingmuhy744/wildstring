import { useEffect, useRef, useState } from 'react';
import { api, artist, time, type Lyrics } from './api';
import { Cover } from './cover';
import type { Player } from './player';

export function NowPlaying({ player, onClose }: { player: Player; onClose: () => void }) {
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
    if (!follow || !container || !line) return;
    const center = () =>
      container.scrollTo({
        top: Math.max(0, line.offsetTop - container.clientHeight / 2 + line.clientHeight / 2),
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
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
    <aside className="now-playing-panel" aria-label="正在播放与歌词">
      <div className="queue-heading">
        <div>
          <span className="eyebrow">NOW PLAYING</span>
          <h2>这一刻的声音</h2>
        </div>
        <button className="icon-button" aria-label="关闭播放详情" onClick={onClose}>
          ×
        </button>
      </div>
      {current ? (
        <>
          <div className="playing-summary">
            <Cover trackId={current.id} title={current.album || current.title} size={320} />
            <div>
              <h3>{current.title}</h3>
              <p>{artist(current)}</p>
              <small>{current.album || '未知专辑'}</small>
            </div>
          </div>
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
        </>
      ) : (
        <p className="lyric-empty">先播放一首喜欢的歌。</p>
      )}
    </aside>
  );
}
