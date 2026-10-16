import { useEffect, useRef, useState } from 'react';
import { api, artist, streamUrl, time, type PlaybackPlan, type Track } from './api';
import { Cover } from './cover';
import { FavoriteButton, type Favorites } from './favorites';
import { ListeningTracker } from './listening';

export function usePlayer() {
  const audio = useRef<HTMLAudioElement>(null);
  const visualPhase = useRef(0);
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
  const [quality, setQuality] = useState('original');
  const qualityRef = useRef('original');
  const [plan, setPlan] = useState<PlaybackPlan | null>(null);
  const planRef = useRef<PlaybackPlan | null>(null);
  const offset = useRef(0);
  const loading = useRef(false);
  const desiredPlay = useRef(false);
  const sourceRequest = useRef<AbortController | null>(null);
  const pendingSeek = useRef<number | null>(null);
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
      sourceRequest.current?.abort();
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
    if (loading.current) {
      desiredPlay.current = true;
      return;
    }
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

  async function loadSource(track: Track, seconds: number, autoplay: boolean, delay = 0) {
    const element = audio.current;
    if (!element) return;
    const attempt = ++generation.current;
    sourceRequest.current?.abort();
    const controller = new AbortController();
    sourceRequest.current = controller;
    tracker.current.beforeSeek(element);
    desiredPlay.current = autoplay;
    loading.current = true;
    element.pause();
    setError('');
    setPlaying(false);
    setBuffering(true);
    setPosition(seconds);
    try {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (controller.signal.aborted || attempt !== generation.current) return;
      let next: PlaybackPlan | null = null;
      if (qualityRef.current !== 'original') {
        const query = new URLSearchParams({
          format: 'aac',
          bitrate_kbps: qualityRef.current,
          start_ms: String(Math.round(seconds * 1000)),
        });
        next = await api<PlaybackPlan>(
          `/tracks/${encodeURIComponent(track.id)}/playback?${query}`,
          { signal: controller.signal },
        );
      }
      if (controller.signal.aborted || attempt !== generation.current) return;
      planRef.current = next;
      setPlan(next);
      offset.current = next?.mode === 'transcode' ? next.start_ms / 1000 : 0;
      setDuration(next ? next.duration_ms / 1000 : track.duration_ms / 1000);
      const url = next?.stream_url || streamUrl(track);
      // Switching AAC preferences on a lossy source should keep the same audio element loaded.
      if (element.getAttribute('src') === url && next?.mode === 'original' && !element.error) {
        loading.current = false;
        setBuffering(false);
        if (desiredPlay.current) play();
        return;
      }
      pendingSeek.current = next?.mode !== 'transcode' && seconds > 0 ? seconds : null;
      element.src = url;
      element.load();
      loading.current = false;
      if (desiredPlay.current) play();
      else setBuffering(false);
    } catch (reason) {
      if (controller.signal.aborted || attempt !== generation.current) return;
      loading.current = false;
      // Never leave the previous song resumable after a failed source change.
      element.removeAttribute('src');
      element.load();
      setBuffering(false);
      setError(reason instanceof Error ? reason.message : '无法加载音频，请重试。');
    }
  }

  function start(tracks: Track[], target: number) {
    const element = audio.current;
    const track = tracks[target];
    if (!element || !track) return;
    tracker.current.start(track, element);
    setQueue(tracks);
    setIndex(target);
    void loadSource(track, 0, true);
  }

  function step(direction: number) {
    const target = index + direction;
    if (target >= 0 && target < queue.length) start(queue, target);
  }

  function seek(value: number) {
    if (!audio.current || !current || !duration) return;
    const target = Math.max(0, Math.min(value, duration - 0.05));
    if (
      planRef.current?.mode === 'transcode' ||
      (loading.current && qualityRef.current !== 'original')
    ) {
      void loadSource(
        current,
        target,
        loading.current ? desiredPlay.current : !audio.current.paused,
        150,
      );
    } else {
      tracker.current.beforeSeek(audio.current);
      audio.current.currentTime = target;
      setPosition(target);
    }
  }

  function toggle() {
    if (!current || !audio.current) return;
    if (loading.current) {
      desiredPlay.current = !desiredPlay.current;
      return;
    }
    if (!audio.current.paused) audio.current.pause();
    else {
      setError('');
      if (audio.current.error || !audio.current.getAttribute('src')) start(queue, index);
      else play();
    }
  }

  function changeQuality(value: string) {
    qualityRef.current = value;
    setQuality(value);
    if (current && audio.current) {
      const seconds =
        planRef.current?.mode === 'transcode'
          ? offset.current + audio.current.currentTime
          : audio.current.currentTime;
      void loadSource(
        current,
        loading.current ? position : seconds,
        loading.current ? desiredPlay.current : !audio.current.paused,
      );
    }
  }

  async function mediaError() {
    const attempt = generation.current;
    const code = audio.current?.error?.code;
    setBuffering(false);
    setPlaying(false);
    if (!current || loading.current || !audio.current?.getAttribute('src')) return;
    try {
      // HEAD diagnoses expired sessions, missing files and changed sources without downloading audio.
      const response = await fetch(audio.current.currentSrc, { method: 'HEAD' });
      if (attempt !== generation.current) return;
      if (response.status === 401) {
        window.dispatchEvent(new Event('wildstring:unauthorized'));
        return;
      }
      if (response.status === 404 || response.status === 409) {
        setError('音频文件已变化或不可读，请在服务端重新扫描曲库。');
        return;
      }
      if (planRef.current?.mode === 'transcode') {
        setError('AAC 转码失败或服务繁忙，请重试或切换原音。');
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
      [
        'pause',
        () => {
          desiredPlay.current = false;
          audio.current?.pause();
        },
      ],
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
    visualPhase,
    queue,
    index,
    current,
    playing,
    position,
    duration,
    volume,
    error,
    buffering,
    quality,
    changeQuality,
    playbackTime: () => offset.current + (audio.current?.currentTime || 0),
    playbackLabel: plan?.mode === 'transcode' ? `AAC ${plan.output.bitrate_kbps} kbps` : '原音直放',
    start,
    step,
    seek,
    toggle,
    setVolume,
    refreshTrack: (track: Track) => {
      setQueue((items) => items.map((item) => (item.id === track.id ? track : item)));
    },
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
      onLoadedMetadata: () => {
        if (audio.current && pendingSeek.current !== null) {
          audio.current.currentTime = pendingSeek.current;
          pendingSeek.current = null;
        }
      },
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
        if (loading.current) return;
        if (audio.current) tracker.current.sample(audio.current);
        setPosition(offset.current + (audio.current?.currentTime || 0));
      },
      onDurationChange: () => {
        if (loading.current || planRef.current?.mode === 'transcode') return;
        const value = audio.current?.duration;
        setDuration(value && Number.isFinite(value) ? value : 0);
      },
      onEnded: () => {
        if (loading.current) return;
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
        <QualityControl player={player} />
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
          {player.buffering ? '缓冲中…' : playing ? player.playbackLabel : current ? '已暂停' : ''}
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

export function QualityControl({ player }: { player: Player }) {
  return (
    <label className="quality-control">
      <span>音质</span>
      <select
        aria-label="播放音质"
        value={player.quality}
        onChange={(event) => player.changeQuality(event.target.value)}
      >
        <option value="original">原音</option>
        {[128, 192, 256, 320].map((rate) => (
          <option key={rate} value={rate}>
            AAC {rate}k
          </option>
        ))}
      </select>
    </label>
  );
}
