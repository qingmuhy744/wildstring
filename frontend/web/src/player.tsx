import { hints } from './help-content';
import { useEffect, useId, useRef, useState } from 'react';
import { api, eventId, artist, streamUrl, time, type PlaybackPlan, type Track } from './api';
import { Cover } from './cover';
import { Icon } from './icons';
import { FavoriteButton, type Favorites } from './favorites';
import { ListeningTracker } from './listening';
import {
  modeNames,
  readPlayback,
  savePlayback,
  QUEUE_LIMIT,
  type PlaybackMode,
} from './playback-state';
import { offlineAudio, usingOfflineAccess } from './offline';
import { GainControls, usePlaybackGain } from './playback-gain';

export function usePlayer(userId: string) {
  const saved = useRef(readPlayback(userId));
  const [mode, setMode] = useState<PlaybackMode>(saved.current?.mode || 'sequential');
  const [sleep, setSleep] = useState<number | 'track' | null>(null);
  const [clock, setClock] = useState(Date.now());
  const objectUrl = useRef<string | null>(null);
  const restored = useRef(false);
  const shuffleHistory = useRef<number[]>([]);
  const shuffleBag = useRef<number[]>([]);
  const audio = useRef<HTMLAudioElement>(null);
  const visualPhase = useRef(0);
  const tracker = useRef(new ListeningTracker());
  const [queue, setQueue] = useState<Track[]>(saved.current?.tracks || []);
  const [index, setIndex] = useState(saved.current?.index ?? -1);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(saved.current?.position || 0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(saved.current?.volume ?? 0.8);
  const [error, setError] = useState('');
  const [buffering, setBuffering] = useState(false);
  const generation = useRef(0);
  const [quality, setQuality] = useState(saved.current?.quality || 'original');
  const qualityRef = useRef(saved.current?.quality || 'original');
  const [plan, setPlan] = useState<PlaybackPlan | null>(null);
  const planRef = useRef<PlaybackPlan | null>(null);
  const offset = useRef(0);
  const loading = useRef(false);
  const desiredPlay = useRef(false);
  const sourceRequest = useRef<AbortController | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const current = queue[index];
  const playbackGain = usePlaybackGain(audio, current?.id, userId, volume);

  const saveRef = useRef(() => {});
  saveRef.current = () => {
    if (queue.length)
      savePlayback(userId, {
        tracks: queue,
        index,
        position: offset.current + (audio.current?.currentTime || position),
        quality,
        volume,
        mode,
      });
  };
  useEffect(() => {
    saveRef.current();
  }, [queue, index, quality, volume, mode, playing]);
  useEffect(() => {
    const save = () => saveRef.current();
    window.addEventListener('pagehide', save);
    const timer = setInterval(save, 5000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', save);
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, []);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const state = saved.current;
    if (!state) return;
    const controller = new AbortController();
    const restore = async () => {
      const track = state.tracks[state.index];
      // A saved queue restores paused, with a fresh authorization check while online.
      if (navigator.onLine && !usingOfflineAccess())
        await api<Track>(`/tracks/${encodeURIComponent(track.id)}`, { signal: controller.signal });
      if (!controller.signal.aborted) {
        tracker.current.start(track, audio.current!);
        await loadSource(track, state.position, false);
      }
    };
    void restore().catch(() => {
      if (!controller.signal.aborted) setError('未能恢复上次播放，可以重新选择歌曲。');
    });
    return () => {
      controller.abort();
      restored.current = false;
    };
  }, []);
  useEffect(() => {
    if (sleep === null || sleep === 'track') return;
    const check = () => {
      setClock(Date.now());
      if (Date.now() >= sleep) {
        desiredPlay.current = false;
        audio.current?.pause();
        setSleep(null);
      }
    };
    check();
    const timer = setInterval(check, 500);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [sleep]);
  useEffect(() => {
    shuffleHistory.current = [];
    shuffleBag.current = [];
  }, [mode, queue]);

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
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
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
    desiredPlay.current = true;
    playbackGain.prepare();
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
      const offline = await offlineAudio(track.id, controller.signal);
      if (!navigator.onLine && !offline) throw new Error('这首歌尚未完整离线保存。');
      let next: PlaybackPlan | null = null;
      if (!offline && qualityRef.current !== 'original') {
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
      const previousUrl = objectUrl.current;
      objectUrl.current = offline ? URL.createObjectURL(offline) : null;
      const url = objectUrl.current || next?.stream_url || streamUrl(track);
      if (previousUrl) URL.revokeObjectURL(previousUrl);
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

  function start(tracks: Track[], target: number, seconds = 0, autoplay = true) {
    const element = audio.current;
    const track = tracks[target];
    if (!element || !track) return;
    if (tracks.length > QUEUE_LIMIT) {
      setError(`播放队列最多 ${QUEUE_LIMIT} 首。`);
      return;
    }
    tracker.current.start(track, element);
    setQueue(tracks);
    setIndex(target);
    void loadSource(track, seconds, autoplay);
  }

  function feedback(action: 'skip' | 'complete') {
    if (current && navigator.onLine)
      void api('/recommendations/feedback', {
        method: 'POST',
        body: JSON.stringify({ event_id: eventId(), track_id: current.id, action }),
      }).catch(() => {});
  }
  function step(direction: number, automatic = false) {
    if (!queue.length) return;
    let target = index + direction;
    if (automatic && sleep === 'track') {
      setSleep(null);
      desiredPlay.current = false;
      audio.current?.pause();
      return;
    }
    if (automatic && mode === 'repeat_one') target = index;
    else if (mode === 'shuffle') {
      if (direction < 0) target = shuffleHistory.current.pop() ?? index;
      else {
        if (!shuffleBag.current.length)
          shuffleBag.current = queue.map((_, i) => i).filter((i) => i !== index);
        if (!shuffleBag.current.length) target = index;
        else {
          target = shuffleBag.current.splice(
            Math.floor(Math.random() * shuffleBag.current.length),
            1,
          )[0];
          shuffleHistory.current.push(index);
        }
      }
    } else if (mode === 'repeat_all') target = (target + queue.length) % queue.length;
    if (target >= 0 && target < queue.length) {
      if (!automatic && direction > 0) feedback('skip');
      start(queue, target);
    }
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
    if (!audio.current.paused) {
      desiredPlay.current = false;
      audio.current.pause();
      setBuffering(false);
    } else {
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
    mode,
    setMode,
    sleep,
    sleepLabel:
      sleep === 'track'
        ? '本曲结束停止'
        : typeof sleep === 'number'
          ? `约 ${Math.max(1, Math.ceil((sleep - clock) / 60000))} 分钟后停止`
          : '睡眠定时',
    setSleepTimer: (minutes: number | 'track' | null) => {
      setClock(Date.now());
      setSleep(minutes === 'track' || minutes === null ? minutes : Date.now() + minutes * 60000);
    },
    playbackTime: () => offset.current + (audio.current?.currentTime || 0),
    playbackLabel: objectUrl.current
      ? '离线播放'
      : plan?.mode === 'transcode'
        ? `AAC ${plan.output.bitrate_kbps} kbps`
        : '原音直放',
    start,
    step,
    seek,
    toggle,
    setVolume,
    refreshTrack: (track: Track) => {
      setQueue((items) => items.map((item) => (item.id === track.id ? track : item)));
    },
    playNext: (track: Track) => {
      if (queue.length >= QUEUE_LIMIT) {
        setError(`播放队列最多 ${QUEUE_LIMIT} 首。`);
        return false;
      }
      if (index < 0) {
        start([track], 0);
        return true;
      }
      setQueue((items) =>
        items.length < QUEUE_LIMIT
          ? [...items.slice(0, index + 1), track, ...items.slice(index + 1)]
          : items,
      );
      return true;
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
      if (queue.length >= QUEUE_LIMIT) {
        setError(`播放队列最多 ${QUEUE_LIMIT} 首。`);
        return false;
      }
      setQueue((items) => (items.length < QUEUE_LIMIT ? [...items, track] : items));
      return true;
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
        if (!loading.current || !desiredPlay.current) setBuffering(false);
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
        if (!audio.current?.paused || (loading.current && desiredPlay.current)) setBuffering(true);
      },
      onTimeUpdate: () => {
        if (loading.current) return;
        if (typeof sleep === 'number' && Date.now() >= sleep) {
          desiredPlay.current = false;
          audio.current?.pause();
          setSleep(null);
        }
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
        feedback('complete');
        step(1, true);
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
        <SleepControl player={player} />
        <QualityControl player={player} />
        <GainControls trackId={current?.id} />
        {current && <FavoriteButton track={current} favorites={favorites} />}
        <button
          className={`lyrics-toggle icon-button ${lyricsOpen ? 'active' : ''}`}
          onClick={onLyrics}
          aria-expanded={lyricsOpen}
          disabled={!current}
          aria-label="显示歌词"
          data-help="查看同步歌词"
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
          className="icon-button playback-mode"
          aria-label={`播放模式：${modeNames[player.mode]}`}
          data-help={`播放模式：${modeNames[player.mode]}`}
          onClick={() => {
            const modes = Object.keys(modeNames) as PlaybackMode[];
            player.setMode(modes[(modes.indexOf(player.mode) + 1) % modes.length]);
          }}
        >
          <Icon
            name={
              player.mode === 'shuffle'
                ? 'shuffle'
                : player.mode === 'repeat_one'
                  ? 'repeatOne'
                  : player.mode === 'repeat_all'
                    ? 'repeat'
                    : 'sequential'
            }
          />
        </button>
        <button
          className="icon-button"
          onClick={() => player.step(-1)}
          disabled={!current || (index <= 0 && player.mode === 'sequential')}
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
          disabled={!current || (index >= queue.length - 1 && player.mode === 'sequential')}
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
        data-help={hints.playbackQuality}
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

export function SleepControl({ player }: { player: Player }) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  return (
    <div className="sleep-setting">
      <button
        className={`icon-button sleep-trigger ${player.sleep !== null ? 'active' : ''}`}
        aria-label="睡眠定时设置"
        title={player.sleepLabel}
        data-help={player.sleepLabel}
        popoverTarget={id}
        onClick={(event) => {
          if (panel.current) {
            const box = event.currentTarget.getBoundingClientRect();
            panel.current.style.left = `${Math.max(12, Math.min(innerWidth - 232, box.right - 220))}px`;
            panel.current.style.top = `${Math.max(12, box.top - 145)}px`;
          }
        }}
      >
        ☾
      </button>
      <div id={id} ref={panel} popover="auto" className="sleep-popover">
        <p>{player.sleepLabel}</p>
        <label>
          停止时间
          <select
            aria-label="睡眠定时"
            value={player.sleep === 'track' ? 'track' : player.sleep === null ? '' : 'active'}
            onChange={(event) => {
              const value = event.target.value;
              player.setSleepTimer(
                value === '' ? null : value === 'track' ? 'track' : Number(value),
              );
              panel.current?.hidePopover();
            }}
          >
            <option value="">关闭</option>
            {typeof player.sleep === 'number' && (
              <option value="active" disabled>
                定时中
              </option>
            )}
            <option value="15">15 分钟</option>
            <option value="30">30 分钟</option>
            <option value="60">60 分钟</option>
            <option value="track">播完本曲停止</option>
          </select>
        </label>
      </div>
    </div>
  );
}
