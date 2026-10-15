import { useEffect, useRef, useState } from 'react';
import { artist, streamUrl, time, type Track } from './api';
import { Cover } from './cover';
import { FavoriteButton, type Favorites } from './favorites';
import { ListeningTracker } from './listening';

export function usePlayer() {
  const audio = useRef<HTMLAudioElement>(null);
  const tracker = useRef(new ListeningTracker());
  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [error, setError] = useState('');
  const [buffering, setBuffering] = useState(false);
  const generation = useRef(0);
  const current = queue[index];

  useEffect(() => {
    if (audio.current) audio.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    const element = audio.current;
    const currentTracker = tracker.current;
    const flush = () => {
      if (element) {
        currentTracker.sample(element);
        currentTracker.report();
      }
    };
    const timer = setInterval(flush, 5000);
    window.addEventListener('pagehide', flush);
    const visibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', visibility);
      if (element) currentTracker.finish(element);
      element?.pause();
      element?.removeAttribute('src');
      element?.load();
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
      }
    };
  }, []);

  useEffect(() => {
    if (!buffering || !current) return;
    const timer = setTimeout(() => setError('音频加载较慢或连接已中断，可重试或切换歌曲。'), 15000);
    return () => clearTimeout(timer);
  }, [buffering, current]);

  function play() {
    const element = audio.current;
    if (!element) return;
    if (element.ended && queue[index]) {
      start(queue, index);
      return;
    }
    const attempt = generation.current;
    element.play().catch((reason: DOMException) => {
      if (attempt !== generation.current || reason.name === 'AbortError') return;
      setBuffering(false);
      setError(
        reason.name === 'NotAllowedError' ? '请点击播放继续。' : '无法播放，请重试或换一首。',
      );
    });
  }

  function start(tracks: Track[], target: number) {
    const element = audio.current;
    const track = tracks[target];
    if (!element || !track) return;
    tracker.current.start(track, element);
    generation.current += 1;
    setQueue(tracks);
    setIndex(target);
    setError('');
    setPosition(0);
    setDuration(0);
    setPlaying(false);
    setBuffering(true);
    element.src = streamUrl(track);
    element.load();
    play();
  }

  function step(direction: number) {
    const target = index + direction;
    if (target >= 0 && target < queue.length) start(queue, target);
  }

  function seek(value: number) {
    if (audio.current && duration > 0) {
      tracker.current.beforeSeek(audio.current);
      audio.current.currentTime = value;
      setPosition(value);
    }
  }

  function toggle() {
    if (!current || !audio.current) return;
    if (!audio.current.paused) audio.current.pause();
    else {
      setError('');
      if (audio.current.error) start(queue, index);
      else play();
    }
  }

  async function mediaError() {
    const attempt = generation.current;
    const code = audio.current?.error?.code;
    setBuffering(false);
    setPlaying(false);
    if (!current) return;
    try {
      // HEAD diagnoses expired sessions, missing files and changed sources without downloading audio.
      const response = await fetch(streamUrl(current), { method: 'HEAD' });
      if (attempt !== generation.current) return;
      if (response.status === 401) {
        window.dispatchEvent(new Event('wildstring:unauthorized'));
        return;
      }
      if (response.status === 404 || response.status === 409) {
        setError('音频文件已变化或不可读，请在服务端重新扫描曲库。');
        return;
      }
      setError(
        code === 3 || code === 4
          ? '浏览器无法解码这首原始音频，可换个浏览器或播放其他曲目。'
          : '音频连接中断，请点击播放重试。',
      );
    } catch {
      if (attempt === generation.current) setError('无法连接音乐服务，请检查连接后重试。');
    }
  }

  useEffect(() => {
    if (!current || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: artist(current),
      album: current.album || '',
    });
    const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', play],
      ['pause', () => audio.current?.pause()],
      ['previoustrack', () => step(-1)],
      ['nexttrack', () => step(1)],
      [
        'seekto',
        (details) => {
          if (details.seekTime !== undefined) seek(details.seekTime);
        },
      ],
    ];
    for (const [action, handler] of actions) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        /* optional browser feature */
      }
    }
    return () => {
      for (const [action] of actions) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          /* optional */
        }
      }
    };
    // Handlers are refreshed whenever the selected track or its seekable duration changes.
  }, [current, index, queue, duration]);

  useEffect(() => {
    if ('mediaSession' in navigator)
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }, [playing]);

  return {
    audio,
    queue,
    index,
    current,
    playing,
    position,
    duration,
    volume,
    error,
    buffering,
    start,
    step,
    seek,
    toggle,
    setVolume,
    playNext: (track: Track) => {
      if (index < 0) {
        start([track], 0);
        return;
      }
      setQueue((items) => [...items.slice(0, index + 1), track, ...items.slice(index + 1)]);
    },
    move: (from: number, to: number) => {
      if (from < 0 || to < 0 || from >= queue.length || to >= queue.length || from === to) return;
      const next = [...queue];
      next.splice(to, 0, next.splice(from, 1)[0]);
      setQueue(next);
      if (from === index) setIndex(to);
      else if (from < index && to >= index) setIndex(index - 1);
      else if (from > index && to <= index) setIndex(index + 1);
    },
    enqueue: (track: Track) => {
      setQueue((items) => [...items, track]);
    },
    remove: (target: number) => {
      if (target === index) return;
      setQueue((items) => items.filter((_, i) => i !== target));
      if (target < index) setIndex(index - 1);
    },
    audioEvents: {
      onPlay: () => setPlaying(true),
      onPause: () => {
        if (audio.current) tracker.current.playing(audio.current, false);
        setPlaying(false);
      },
      onSeeking: () => {
        if (audio.current) tracker.current.beforeSeek(audio.current);
      },
      onSeeked: () => {
        if (audio.current) tracker.current.afterSeek(audio.current);
      },
      onPlaying: () => {
        if (audio.current) tracker.current.playing(audio.current, true);
        setBuffering(false);
        setError('');
      },
      onWaiting: () => {
        if (audio.current) tracker.current.playing(audio.current, false);
        setBuffering(true);
      },
      onTimeUpdate: () => {
        if (audio.current) tracker.current.sample(audio.current);
        setPosition(audio.current?.currentTime || 0);
      },
      onDurationChange: () => {
        const value = audio.current?.duration;
        setDuration(value && Number.isFinite(value) ? value : 0);
      },
      onEnded: () => {
        if (audio.current) tracker.current.finish(audio.current);
        setPlaying(false);
        setBuffering(false);
        step(1);
      },
      onError: mediaError,
    },
  };
}

export type Player = ReturnType<typeof usePlayer>;

export function PlayerBar({
  player,
  onQueue,
  queueOpen,
  onLyrics,
  lyricsOpen,
  favorites,
}: {
  player: Player;
  onQueue: () => void;
  queueOpen: boolean;
  onLyrics: () => void;
  lyricsOpen: boolean;
  favorites: Favorites;
}) {
  const { current, queue } = player;
  return (
    <section className="player" aria-label="音乐播放器">
      <audio ref={player.audio} preload="metadata" {...player.audioEvents} />
      <div className="now-playing">
        <button
          className="playing-art"
          onClick={onLyrics}
          disabled={!current}
          aria-label="全屏播放"
          aria-haspopup="dialog"
          aria-expanded={lyricsOpen}
        >
          {current ? (
            <Cover trackId={current.id} title={current.album || current.title} />
          ) : (
            <span className="record" aria-hidden="true">
              ≋
            </span>
          )}
          {current && (
            <span className="expand-art" aria-hidden="true">
              ⌃
            </span>
          )}
        </button>
        <div>
          <strong>{current?.title || '等一首，喜欢的歌'}</strong>
          <small>{current ? artist(current) : '从你的曲库开始播放'}</small>
        </div>
        {current && <span className="format">{current.format.toUpperCase()}</span>}
      </div>
      <PlaybackControls player={player} />
      <div className="player-options">
        {current && <FavoriteButton track={current} favorites={favorites} />}
        <button
          className={`lyrics-toggle icon-button ${lyricsOpen ? 'active' : ''}`}
          onClick={onLyrics}
          aria-expanded={lyricsOpen}
          disabled={!current}
          aria-label="显示歌词"
        >
          词
        </button>
        <VolumeControl player={player} />
        <button
          className={`icon-button ${queueOpen ? 'active' : ''}`}
          onClick={onQueue}
          aria-expanded={queueOpen}
          aria-label="播放队列"
        >
          ☷ <small>{queue.length}</small>
        </button>
      </div>
      <PlaybackError player={player} />
    </section>
  );
}

export function PlaybackControls({ player }: { player: Player }) {
  const { current, playing, index, queue, duration, position } = player;
  return (
    <div className="transport">
      <div className="transport-buttons">
        <button
          className="icon-button"
          onClick={() => player.step(-1)}
          disabled={index <= 0}
          aria-label="上一首"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 5h2v14H5zm14 0v14L8 12z" />
          </svg>
        </button>
        <button
          className="play-button"
          onClick={player.toggle}
          disabled={!current}
          aria-label={playing ? '暂停' : '播放'}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={playing ? 'M7 5h4v14H7zm6 0h4v14h-4z' : 'M8 5l11 7-11 7z'} />
          </svg>
        </button>
        <button
          className="icon-button"
          onClick={() => player.step(1)}
          disabled={index < 0 || index >= queue.length - 1}
          aria-label="下一首"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M17 5h2v14h-2zM5 5l11 7-11 7z" />
          </svg>
        </button>
        <span className="play-state" role="status">
          {player.buffering ? '缓冲中…' : playing ? '原音直放' : current ? '已暂停' : ''}
        </span>
      </div>
      <div className="timeline">
        <time>{time(position)}</time>
        <input
          type="range"
          aria-label="播放进度"
          min="0"
          max={duration || 1}
          step="0.1"
          value={Math.min(position, duration || 0)}
          disabled={!duration}
          onChange={(event) => player.seek(Number(event.target.value))}
        />
        <time>{time(duration)}</time>
      </div>
    </div>
  );
}

export function VolumeControl({ player }: { player: Player }) {
  return (
    <label className="volume">
      音量
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        aria-label="音量"
        value={player.volume}
        onChange={(event) => player.setVolume(Number(event.target.value))}
      />
    </label>
  );
}

export function PlaybackError({ player }: { player: Player }) {
  return player.error ? (
    <div className="player-error" role="alert">
      {player.error}
      <button onClick={() => player.start(player.queue, player.index)}>重试</button>
    </div>
  ) : null;
}
