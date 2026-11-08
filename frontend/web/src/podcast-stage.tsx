import { useEffect, useRef, type CSSProperties } from 'react';
import { time } from './api';
import { Cover } from './cover';
import { readAudioPeak } from './playback-gain';
import { PodcastSkipButton, type Player } from './player';
import { maybePlayRadioClick } from './radio-click';
import type { PodcastOrder } from './podcast-continuation';
import { renderPodcastDescription } from './podcast-description';

function date(value?: string | null) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(parsed)
    : '日期未提供';
}

function Radio({ player, onPreview }: { player: Player; onPreview: () => void }) {
  const track = player.current!;
  const live = player.playing && !player.buffering && !player.error;
  const progress = player.duration > 0 ? player.position / player.duration : 0;
  const vu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = vu.current;
    if (!element) return;
    const set = (level: number, peak: number, clipped = false) => {
      element.style.setProperty('--level-current', level.toFixed(3));
      element.style.setProperty('--level-peak', peak.toFixed(3));
      element.dataset.clipped = String(clipped);
    };
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0,
      level = 0,
      peak = 0,
      lastTime = 0,
      holdUntil = 0,
      clippedUntil = 0;
    const tick = (time: number) => {
      const elapsed = lastTime ? (time - lastTime) / 1000 : 0;
      lastTime = time;
      const [instantaneous, clipped] = readAudioPeak();
      // The bar attacks instantly and releases smoothly toward the current sample peak.
      level =
        instantaneous > level
          ? instantaneous
          : instantaneous + (level - instantaneous) * Math.pow(0.9, elapsed * 60);
      // Hold the bar's high point, then decay without crossing into the bar.
      if (level >= peak) {
        peak = level;
        holdUntil = time + 500;
      } else if (time > holdUntil) {
        peak = Math.max(
          level,
          peak * Math.pow(0.995, Math.min(elapsed, (time - holdUntil) / 1000) * 60),
        );
      }
      if (clipped) clippedUntil = time + 1000;
      set(level, peak, time < clippedUntil);
      frame = requestAnimationFrame(tick);
    };
    const update = () => {
      cancelAnimationFrame(frame);
      level = 0;
      peak = 0;
      lastTime = 0;
      holdUntil = 0;
      clippedUntil = 0;
      set(0, 0);
      if (live && !motion.matches) frame = requestAnimationFrame(tick);
    };
    motion.addEventListener('change', update);
    update();
    return () => {
      motion.removeEventListener('change', update);
      cancelAnimationFrame(frame);
      set(0, 0);
    };
  }, [live]);
  return (
    <section
      className="retro-radio"
      aria-label="野弦复古收音机"
      data-live={live}
      style={
        {
          '--tuning': `${Math.min(100, Math.max(0, progress * 100))}%`,
          '--volume-angle': `${-130 + player.volume * 260}deg`,
        } as CSSProperties
      }
    >
      <header className="retro-brand">
        <strong>WILDSTRING</strong>
        <span className="retro-lamp" aria-hidden="true" />
      </header>
      <div className="retro-main">
        <button className="retro-screen" onClick={onPreview} aria-label="查看播客封面大图">
          <Cover
            trackId={track.id}
            title={track.album || track.title}
            source={track.cover_url}
            size={320}
          />
          <span className="retro-screen-copy">
            <span className="retro-on-air">
              <i aria-hidden="true" />
              {player.buffering ? '正在调谐' : live ? '正在播出' : '已暂停'}
            </span>
            <strong>{track.album || '播客节目'}</strong>
            <span className="retro-time">
              {time(player.position)}
              <small> / {time(player.duration)}</small>
            </span>
          </span>
        </button>
        <div className="retro-speaker" aria-hidden="true" />
      </div>
      <div className="retro-tuner">
        <div className="retro-tuner-label" aria-hidden="true">
          <span>
            FM <small className="retro-tuner-hint">· 拖动跳转</small>
          </span>
          <span>88</span>
          <span>92</span>
          <span>96</span>
          <span>100</span>
          <span>104</span>
          <span>
            108 <small>MHz</small>
          </span>
        </div>
        <div className="retro-tuner-track" title="拖动刻度跳转">
          <i />
          <input
            type="range"
            aria-label="收音机调谐进度"
            min="0"
            max={player.duration || 1}
            step="1"
            disabled={!player.duration}
            value={Math.min(player.position, player.duration || 0)}
            aria-valuetext={`${time(player.position)} / ${time(player.duration)}`}
            onChange={(event) => player.seek(Number(event.target.value))}
          />
        </div>
      </div>
      <div className="retro-deck">
        <div className="retro-keys">
          <PodcastSkipButton player={player} seconds={15} direction="backward" variant="retro" />
          <button
            className="retro-power"
            onClick={() => {
              maybePlayRadioClick();
              player.toggle();
            }}
            aria-label={player.playing ? '收音机暂停' : '收音机播放'}
            aria-pressed={player.playing}
          >
            <span aria-hidden="true">{player.playing ? 'Ⅱ' : '▶'}</span>
          </button>
          <PodcastSkipButton player={player} seconds={30} direction="forward" variant="retro" />
        </div>
        <div className="retro-vu" aria-hidden="true">
          <div className="retro-vu-window" ref={vu}>
            <div className="retro-vu-heading">
              <span>LEVEL</span>
              <span>dBFS</span>
            </div>
            <div className="retro-vu-meter">
              <div className="retro-vu-scale">
                <span className="retro-vu-tick">
                  <span>−40</span>
                </span>
                <span className="retro-vu-tick">
                  <span>−20</span>
                </span>
                <span className="retro-vu-tick">
                  <span>−10</span>
                </span>
                <span className="retro-vu-tick" />
                <span className="retro-vu-tick">
                  <span>0</span>
                </span>
              </div>
              <div className="retro-vu-track">
                <i />
                <b />
              </div>
            </div>
          </div>
        </div>
        <label className="retro-volume">
          <span className="retro-caption">VOLUME</span>
          <span className="retro-knob">
            <i />
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={player.volume}
              aria-label="收音机音量"
              onChange={(event) => player.setVolume(Number(event.target.value))}
            />
          </span>
          <span className="retro-caption">{Math.round(player.volume * 100)}%</span>
        </label>
      </div>
      <div className="retro-footnote" aria-hidden="true">
        <span className="retro-screw screw-left" />
        <span>WS-56 · PORTABLE</span>
        <span className="retro-screw screw-right" />
      </div>
    </section>
  );
}

function Upcoming({ player }: { player: Player }) {
  const queued = player.queue
    .map((track, index) => ({ track, index }))
    .filter((entry) => entry.index > player.index && entry.track.podcast_queue_origin !== 'auto');
  const preview = player.podcastPreview;
  const preference = player.podcastPreference;
  const auto = preference.order !== 'off' && preference.autoContinue !== false;
  const direction =
    preference.order === 'follow' ? player.current?.podcast_list_order || 'desc' : preference.order;
  return (
    <aside className="radio-programme" aria-label="接下来播放">
      <header className="programme-heading">
        <div className="programme-heading-main">
          <h2>
            接下来播放 <small>{queued.length + preview.length}</small>
          </h2>
          <span className="programme-status">
            {direction === 'off' || !auto
              ? '自动续播关闭'
              : direction === 'asc'
                ? '从旧到新'
                : '从新到旧'}
          </span>
        </div>
        <div className="programme-settings">
          <label>
            <span className="sr-only">播客续播顺序</span>
            <select
              aria-label="播客续播顺序"
              value={!auto ? 'off' : preference.order}
              onChange={(event) =>
                player.setPodcastPreference({
                  ...preference,
                  order: event.target.value as PodcastOrder,
                })
              }
            >
              <option value="follow">跟随列表顺序</option>
              <option value="asc">从旧到新</option>
              <option value="desc">从新到旧</option>
              <option value="off">关闭自动续播</option>
            </select>
          </label>
          <label className="programme-unplayed">
            <input
              type="checkbox"
              checked={preference.skipCompleted}
              onChange={(event) =>
                player.setPodcastPreference({ ...preference, skipCompleted: event.target.checked })
              }
            />
            跳过已听完
          </label>
        </div>
      </header>
      {player.podcastSync === 'error' && (
        <div className="programme-sync" role="status">
          <p>暂时无法同步，本机播放不受影响</p>
          <button type="button" onClick={() => player.retryPodcastQueue()}>
            重试
          </button>
        </div>
      )}
      {player.podcastSync === 'conflict' && (
        <div className="programme-sync" role="status">
          <p>队列已在其他设备更新，本机队列仍保留。</p>
          <div className="programme-sync-actions">
            <button type="button" onClick={() => void player.useServerPodcastQueue()}>
              使用服务器上的队列
            </button>
            <button type="button" onClick={() => void player.overwritePodcastQueue()}>
              用本机队列覆盖
            </button>
          </div>
        </div>
      )}
      <div className="programme-list">
        {queued.length > 0 && (
          <ol>
            {queued.map(({ track, index }, i) => (
              <li
                key={`${track.id}-${index}`}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('text/plain', String(index));
                  event.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const from = Number(event.dataTransfer.getData('text/plain'));
                  if (Number.isInteger(from)) player.move(from, index);
                }}
              >
                <span className="programme-number">{String(i + 1).padStart(2, '0')}</span>
                <button
                  className="programme-track"
                  onClick={() => player.start(player.queue, index)}
                >
                  <strong>{track.title}</strong>
                  <span>
                    {track.podcast_queue_origin === 'rule' ? '新集规则' : '手动添加'} ·{' '}
                    {time(track.duration_ms / 1000)}
                    {track.podcast_position_seconds
                      ? ` · 已听 ${time(track.podcast_position_seconds)}`
                      : ` · ${date(track.release_date)}`}
                  </span>
                </button>
                <span
                  className="programme-reorder"
                  role="group"
                  aria-label={`调整待播 ${track.title}`}
                >
                  <button
                    type="button"
                    aria-label={`上移待播 ${track.title}`}
                    disabled={i === 0}
                    onClick={() => player.move(index, queued[i - 1].index)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`下移待播 ${track.title}`}
                    disabled={i === queued.length - 1}
                    onClick={() => player.move(index, queued[i + 1].index)}
                  >
                    ↓
                  </button>
                </span>
                <button
                  className="programme-remove"
                  aria-label={`移除待播 ${track.title}`}
                  onClick={() => player.remove(index)}
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
        )}
        {preview.length > 0 && (
          <section aria-label="自动续播">
            <h3>自动续播</h3>
            {!queued.length && <p>播完会接下一集</p>}
            <ol>
              {preview.map((track, i) => (
                <li key={`${track.id}-${i}`}>
                  <span className="programme-number">
                    {String(queued.length + i + 1).padStart(2, '0')}
                  </span>
                  <button
                    className="programme-track"
                    onClick={() =>
                      queued.length
                        ? player.playNext(track)
                        : player.start(
                            [{ ...track, podcast_queue_origin: 'auto' }],
                            0,
                            undefined,
                            true,
                            true,
                          )
                    }
                  >
                    <strong>{track.title}</strong>
                    <span>
                      自动续播 · {time(track.duration_ms / 1000)}
                      {track.podcast_position_seconds
                        ? ` · 已听 ${time(track.podcast_position_seconds)}`
                        : ` · ${date(track.release_date)}`}
                    </span>
                  </button>
                  <button
                    className="programme-remove"
                    aria-label={`不再预览 ${track.title}`}
                    onClick={() => player.dismissPodcastPreview(track.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ol>
          </section>
        )}
        {!queued.length && !preview.length && (
          <p className="programme-empty">
            {!auto
              ? '已关闭，播完即停'
              : player.podcastQueueStatus === 'loading'
                ? '正在读取后续单集'
                : player.podcastQueueStatus === 'error'
                  ? '暂时无法读取后续单集，当前播放不受影响。'
                  : '这个方向没有未听的下一集，播完即停'}
          </p>
        )}
      </div>
    </aside>
  );
}

export function PodcastStage({
  player,
  showQueue,
  onPreview,
}: {
  player: Player;
  showQueue: boolean;
  onPreview: () => void;
}) {
  const track = player.current!;
  const listeningStatus = player.buffering ? '正在调谐' : player.playing ? '正在播出' : '已暂停';
  return (
    <div className="podcast-stage">
      <div className="podcast-device-column">
        <Radio player={player} onPreview={onPreview} />
        {showQueue && <Upcoming player={player} />}
      </div>
      <article className="radio-newspaper" aria-label="播客广播报">
        <div className="newspaper-masthead">
          <span>THE WILDSTRING JOURNAL</span>
          <strong>野弦广播报</strong>
          <span>
            声音有故事
            <br />
            收听无边界
          </span>
        </div>
        <div className="newspaper-edition">
          <span>播客手记 / {track.album || '独立声音'}</span>
          <span>{date(track.release_date)}</span>
        </div>
        <div className="newspaper-reader" key={track.id} tabIndex={0} aria-label="单集简介">
          <header className="newspaper-article-header">
            <span className="print-kicker">{listeningStatus} · 本期节目</span>
            <h1>{track.title}</h1>
            <div className="newspaper-byline">
              <span>{track.album || '播客节目'}</span>
              <span>
                {time(track.duration_ms / 1000)} · {track.format.toUpperCase()}
              </span>
            </div>
          </header>
          <div className="newspaper-body">
            {track.description ? (
              renderPodcastDescription(track.description, {
                onTimecode: (seconds) => player.seek(seconds),
              })
            ) : (
              <p>这一集还没有文字简介。调好音量，听听声音里的故事。</p>
            )}
          </div>
          <div className="newspaper-end" aria-hidden="true">
            ◆
          </div>
        </div>
        <footer className="newspaper-footer">
          <span>WILDSTRING · 私人收听时光</span>
          <span>滚动阅读{track.description?.match(/\d+:\d{2}/) ? ' · 点击时间码跳转' : ''}</span>
        </footer>
      </article>
    </div>
  );
}
