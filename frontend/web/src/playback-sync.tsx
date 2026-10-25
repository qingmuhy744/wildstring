import { episodeId, episodeResumeMode } from './podcast-progress';
import { HelpLabel } from './desktop-help';
import { Icon } from './icons';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, eventId, time, type Track } from './api';
import { QUEUE_LIMIT, type PlaybackMode } from './playback-state';
import type { Player } from './player';

type SyncMode = 'off' | 'ask' | 'auto';
interface SharedPlayback {
  version: number;
  device_id: string;
  track_ids: string[];
  index: number;
  position_ms: number;
  mode: PlaybackMode;
  updated_at: string | null;
  playback_state?: 'unknown' | 'playing' | 'paused' | 'ended';
  paused_at?: string | null;
  handoff_supported?: boolean;
  handoff_eligible?: boolean;
}
function pauseEvent(state: SharedPlayback): string | null {
  return state.device_id && state.paused_at ? `${state.device_id}:${state.paused_at}` : null;
}
function isRecentPause(state: SharedPlayback): boolean {
  return (
    state.handoff_eligible === true &&
    state.playback_state === 'paused' &&
    state.track_ids.length > 0 &&
    pauseEvent(state) !== null
  );
}
const optionsEvent = 'wildstring:playback-sync-options';
const modeKey = (id: string) => `wildstring:playback-sync:${id}`;
export function playbackSyncMode(id: string): SyncMode {
  const mode = localStorage.getItem(modeKey(id));
  return mode === 'off' || mode === 'auto' ? mode : 'ask';
}
export function SyncModeControl({ userId }: { userId: string }) {
  const [mode, setMode] = useState(() => playbackSyncMode(userId));
  const [podcastMode, setPodcastMode] = useState(() => episodeResumeMode(userId));
  return (
    <>
      <label>
        <HelpLabel hint="handoff">音乐跨设备接续</HelpLabel>
        <select
          aria-label="跨设备接续方式"
          value={mode}
          onChange={(event) => {
            const value = event.target.value as SyncMode;
            setMode(value);
            localStorage.setItem(modeKey(userId), value);
            window.dispatchEvent(new Event(optionsEvent));
          }}
        >
          <option value="off">关闭</option>
          <option value="ask">轻提示（默认）</option>
          <option value="auto">自动恢复</option>
        </select>
      </label>
      <label>
        播客单集接续
        <select
          aria-label="播客单集接续"
          value={podcastMode}
          onChange={(event) => {
            const value = event.target.value as typeof podcastMode;
            setPodcastMode(value);
            localStorage.setItem(`wildstring:podcast-resume:${userId}`, value);
          }}
        >
          <option value="ask">询问（默认）</option>
          <option value="auto">自动继续</option>
          <option value="restart">从头播放</option>
        </select>
      </label>
      <p className="muted">播客按单集保存进度；以上选择只影响开始收听的位置，进度始终自动保存。</p>
    </>
  );
}

const COUNTDOWN_MS = 8000;

export function PlaybackSync({ player, userId }: { player: Player; userId: string }) {
  const latest = useRef(player);
  latest.current = player;
  const [offer, setOffer] = useState<SharedPlayback | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [isClosing, setIsClosing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const remainingRef = useRef(COUNTDOWN_MS);
  const closingTimer = useRef<number | null>(null);
  const prevVersionRef = useRef<number | null>(null);
  const accept = useRef<(saved: SharedPlayback) => Promise<void>>(async () => {});
  const dismiss = useRef<(version: number) => void>(() => {});

  const triggerAutoDismiss = (version: number) => {
    if (isClosing) return;
    setIsClosing(true);
    closingTimer.current = window.setTimeout(() => {
      dismiss.current(version);
      setIsClosing(false);
    }, 220);
  };

  useEffect(() => {
    if (offer && offer.version !== prevVersionRef.current) {
      prevVersionRef.current = offer.version;
      remainingRef.current = COUNTDOWN_MS;
      setIsClosing(false);
    } else if (!offer) {
      prevVersionRef.current = null;
      setIsClosing(false);
    }
  }, [offer]);

  useEffect(() => {
    if (!offer || isClosing || isHovered) return;
    const start = Date.now();
    const currentRemaining = remainingRef.current;
    const timer = window.setTimeout(() => {
      triggerAutoDismiss(offer.version);
    }, currentRemaining);
    return () => {
      window.clearTimeout(timer);
      remainingRef.current = Math.max(0, currentRemaining - (Date.now() - start));
    };
  }, [offer?.version, isHovered, isClosing]);

  useEffect(() => {
    return () => {
      if (closingTimer.current !== null) {
        window.clearTimeout(closingTimer.current);
      }
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const deviceKey = `wildstring:device:${userId}`;
    const device = localStorage.getItem(deviceKey) || eventId();
    localStorage.setItem(deviceKey, device);
    const seenKey = `wildstring:playback-seen:${userId}`;
    let seen = Number(localStorage.getItem(seenKey)) || 0;
    const pauseKey = `wildstring:playback-pause-seen:${userId}`;
    let lastOfferedPause = localStorage.getItem(pauseKey);
    let offeredPause: string | null = null;
    let supportsPausedHandoff = false;
    const rememberPause = (state: SharedPlayback) => {
      const key = pauseEvent(state);
      if (key) {
        lastOfferedPause = key;
        localStorage.setItem(pauseKey, key);
      }
    };
    let version: number | null = null;
    let armed = false,
      reading = false,
      writing = false,
      applying = false,
      offered = 0,
      epoch = 0;
    let serial = Promise.resolve();
    const seenVersion = (value: number) => {
      seen = Math.max(seen, value);
      localStorage.setItem(seenKey, String(seen));
    };
    dismiss.current = (value) => {
      if (closingTimer.current !== null) {
        window.clearTimeout(closingTimer.current);
        closingTimer.current = null;
      }
      seenVersion(value);
      offered = 0;
      offeredPause = null;
      setOffer(null);
      setError('');
      setIsClosing(false);
    };
    accept.current = async (saved) => {
      if (applying) return;
      applying = true;
      setBusy(true);
      setError('');
      const originalEpoch = epoch;
      const original = latest.current;
      try {
        const state = await api<SharedPlayback>('/playback/state', { signal: controller.signal });
        if (!isRecentPause(state) || pauseEvent(state) !== pauseEvent(saved)) {
          offered = 0;
          offeredPause = null;
          setOffer(null);
          return;
        }
        if (state.track_ids.length > QUEUE_LIMIT)
          throw new Error(`共享队列超过网页 ${QUEUE_LIMIT} 首上限。`);
        const tracks: Track[] = [];
        for (let offset = 0; offset < state.track_ids.length; offset += 10)
          tracks.push(
            ...(await Promise.all(
              state.track_ids
                .slice(offset, offset + 10)
                .map((id) =>
                  api<Track>(`/tracks/${encodeURIComponent(id)}`, { signal: controller.signal }),
                ),
            )),
          );
        if (
          controller.signal.aborted ||
          epoch !== originalEpoch ||
          latest.current.playing ||
          original.queue !== latest.current.queue ||
          original.index !== latest.current.index ||
          original.mode !== latest.current.mode
        )
          return;
        const verified = await api<SharedPlayback>('/playback/state', {
          signal: controller.signal,
        });
        if (
          !isRecentPause(verified) ||
          pauseEvent(verified) !== pauseEvent(saved) ||
          playbackSyncMode(userId) === 'off'
        ) {
          offered = 0;
          offeredPause = null;
          setOffer(null);
          return;
        }
        if (
          controller.signal.aborted ||
          epoch !== originalEpoch ||
          latest.current.playing ||
          original.queue !== latest.current.queue ||
          original.index !== latest.current.index ||
          original.mode !== latest.current.mode
        )
          return;
        if (verified.version !== state.version) {
          offered = verified.version;
          offeredPause = pauseEvent(verified);
          setOffer(verified);
          setError('其他设备的进度已更新，请重新核对后载入。');
          return;
        }
        if (!tracks.length) throw new Error('共享队列已经不可用。');
        armed = false;
        version = state.version;
        seenVersion(state.version);
        rememberPause(state);
        offeredPause = null;
        offered = 0;
        latest.current.setMode(state.mode);
        latest.current.start(tracks, state.index, state.position_ms / 1000, false);
        setOffer(null);
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : '进度未载入，请重试。');
          setOffer(saved);
        }
      } finally {
        applying = false;
        if (!controller.signal.aborted) setBusy(false);
      }
    };
    const publish = (claim = false) => {
      serial = serial.then(async () => {
        if (!armed || controller.signal.aborted || playbackSyncMode(userId) === 'off' || applying)
          return;
        writing = true;
        try {
          if (claim || version === null) {
            const remote = await api<SharedPlayback>('/playback/state', {
              signal: controller.signal,
            });
            version = remote.version;
            supportsPausedHandoff = remote.handoff_supported === true;
          }
          if (controller.signal.aborted) return;
          const current = latest.current;
          if (
            !current.current ||
            !current.queue.length ||
            current.queue.some((track) => episodeId(track.id))
          )
            return;
          const result = await api<SharedPlayback>('/playback/state', {
            method: 'PUT',
            signal: controller.signal,
            body: JSON.stringify({
              version,
              device_id: device,
              track_ids: current.queue.map((track) => track.id),
              index: current.index,
              position_ms: Math.min(
                current.current.duration_ms,
                Math.round(current.playbackTime() * 1000),
              ),
              mode: current.mode,
              ...(supportsPausedHandoff
                ? {
                    playback_state: current.audio.current?.ended
                      ? 'ended'
                      : current.audio.current?.paused === false
                        ? 'playing'
                        : 'paused',
                  }
                : {}),
            }),
          });
          version = result.version;
          seenVersion(result.version);
        } catch (reason) {
          // A conflict stops publishing until the user explicitly starts local playback again.
          if (reason instanceof ApiError && reason.status === 409) {
            armed = false;
            version = null;
          }
        } finally {
          writing = false;
        }
      });
    };
    const read = async () => {
      if (
        reading ||
        writing ||
        applying ||
        playbackSyncMode(userId) === 'off' ||
        document.visibilityState !== 'visible' ||
        latest.current.playing ||
        episodeId(latest.current.current?.id)
      )
        return;
      reading = true;
      const originalEpoch = epoch;
      try {
        const state = await api<SharedPlayback>('/playback/state', { signal: controller.signal });
        if (
          controller.signal.aborted ||
          originalEpoch !== epoch ||
          latest.current.playing ||
          !isRecentPause(state) ||
          state.device_id === device ||
          state.version <= seen
        ) {
          if (offered) {
            offered = 0;
            offeredPause = null;
            setOffer(null);
          }
          return;
        }
        const event = pauseEvent(state);
        if (event === lastOfferedPause && event !== offeredPause) return;
        offered = state.version;
        offeredPause = event;
        if (playbackSyncMode(userId) === 'auto') await accept.current(state);
        else {
          if (closingTimer.current !== null) {
            window.clearTimeout(closingTimer.current);
            closingTimer.current = null;
          }
          setIsClosing(false);
          rememberPause(state);
          setOffer(state);
        }
      } catch {
        /* Retry on the next foreground check without interrupting local playback. */
      } finally {
        reading = false;
      }
    };
    const element = latest.current.audio.current;
    const play = () => {
      epoch++;
      offered = 0;
      offeredPause = null;
      setOffer(null);
      armed = !latest.current.queue.some((track) => episodeId(track.id));
      if (armed) publish(true);
    };
    const pause = () => {
      epoch++;
      publish();
    };
    const seek = () => {
      epoch++;
    };
    element?.addEventListener('play', play);
    element?.addEventListener('pause', pause);
    element?.addEventListener('seeking', seek);
    const foreground = () => {
      void read();
    };
    const online = () => void read();
    const visibility = () => {
      if (document.visibilityState === 'visible') foreground();
    };
    const options = () => {
      if (playbackSyncMode(userId) === 'off') {
        offered = 0;
        offeredPause = null;
        setOffer(null);
      } else void read();
    };
    window.addEventListener('focus', foreground);
    window.addEventListener('online', online);
    window.addEventListener(optionsEvent, options);
    document.addEventListener('visibilitychange', visibility);
    const timer = setInterval(() => {
      if (latest.current.playing) publish();
      else void read();
    }, 15000);
    void read();
    return () => {
      controller.abort();
      clearInterval(timer);
      element?.removeEventListener('play', play);
      element?.removeEventListener('pause', pause);
      element?.removeEventListener('seeking', seek);
      window.removeEventListener('focus', foreground);
      window.removeEventListener('online', online);
      window.removeEventListener(optionsEvent, options);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [userId]);
  return offer ? (
    <aside
      className={`device-resume-notice ${isClosing ? 'is-closing' : ''}`}
      role="region"
      aria-label="跨设备接续"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="device-resume-header">
        <strong>其他设备有可接续的进度</strong>
        <button
          type="button"
          className="device-resume-close"
          aria-label="关闭提示"
          disabled={busy}
          onClick={() => dismiss.current(offer.version)}
        >
          <Icon name="close" />
        </button>
      </div>
      <p>
        {offer.track_ids.length} 首队列 · 第 {offer.index + 1} 首 · {time(offer.position_ms / 1000)}
      </p>
      <small className="muted">其他设备最近暂停 · 载入后保持暂停</small>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button disabled={busy} onClick={() => dismiss.current(offer.version)}>
          暂不
        </button>
        <button className="primary" disabled={busy} onClick={() => void accept.current(offer)}>
          {busy ? '正在载入…' : '载入进度'}
        </button>
      </footer>
      <div className="device-resume-progress" aria-hidden="true">
        <div
          key={offer.version}
          className="device-resume-progress-bar"
          style={{ animationDuration: `${COUNTDOWN_MS}ms` }}
        />
      </div>
    </aside>
  ) : null;
}
