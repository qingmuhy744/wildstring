import { useState, type CSSProperties } from 'react';
import { time } from './api';
import { Cover } from './cover';
import { PodcastSkipButton, type Player } from './player';
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
        <div>
          <strong>WILDSTRING</strong>
          <span>野弦 · 随身电台</span>
        </div>
        <span className="retro-model">
          MEMPHIS FM · '56
          <br />
          STEREO RECEIVER
        </span>
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
        <div className="retro-speaker" aria-hidden="true">
          <span>HI-FI SOUND</span>
        </div>
      </div>
      <div className="retro-tuner">
        <div className="retro-tuner-label">
          <span>FM</span>
          <span>88</span>
          <span>92</span>
          <span>96</span>
          <span>100</span>
          <span>104</span>
          <span>
            108 <small>MHz</small>
          </span>
        </div>
        <div className="retro-tuner-track">
          <i />
          <input
            type="range"
            aria-label="收音机调谐进度"
            min="0"
            max={player.duration || 1}
            step="1"
            disabled={!player.duration}
            value={Math.min(player.position, player.duration || 0)}
            onChange={(event) => player.seek(Number(event.target.value))}
          />
        </div>
        <div className="retro-am-scale" aria-hidden="true">
          <span>AM</span>
          <span>530</span>
          <span>800</span>
          <span>1000</span>
          <span>1400</span>
          <span>1600 kHz</span>
        </div>
      </div>
      <div className="retro-deck">
        <div className="retro-keys">
          <span className="retro-caption">TRANSPORT</span>
          <div className="retro-key-grid">
            <div className="retro-key">
              <PodcastSkipButton
                player={player}
                seconds={15}
                direction="backward"
                variant="retro"
              />
              <span className="retro-key-caption" aria-hidden="true">
                后退 15s
              </span>
            </div>
            <div className="retro-key">
              <button
                className="retro-power"
                onClick={player.toggle}
                aria-label={player.playing ? '收音机暂停' : '收音机播放'}
                aria-pressed={player.playing}
              >
                <span aria-hidden="true">{player.playing ? 'Ⅱ' : '▶'}</span>
              </button>
              <span className="retro-key-caption" aria-hidden="true">
                {player.playing ? '暂停' : '播放'}
              </span>
            </div>
            <div className="retro-key">
              <PodcastSkipButton player={player} seconds={30} direction="forward" variant="retro" />
              <span className="retro-key-caption" aria-hidden="true">
                前进 30s
              </span>
            </div>
          </div>
        </div>
        <div className="retro-vu" aria-hidden="true">
          <span className="retro-caption">STEREO · LEVEL</span>
          <div className="retro-vu-window">
            <span>L</span>
            <i />
            <span>R</span>
            <i />
          </div>
          <span className="retro-caption">WILDSTRING FM</span>
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
          <span className="retro-caption">− &nbsp; {Math.round(player.volume * 100)} &nbsp; +</span>
        </label>
      </div>
      <div className="retro-footnote" aria-hidden="true">
        <span>MEMPHIS PORTABLE / WS-56</span>
        <span>让声音，慢下来。</span>
      </div>
      <span className="retro-screw screw-left" aria-hidden="true" />
      <span className="retro-screw screw-right" aria-hidden="true" />
    </section>
  );
}

function Upcoming({ player }: { player: Player }) {
  const [expanded, setExpanded] = useState(false);
  const entries = player.queue.slice(player.index + 1);
  const preference = player.podcastPreference;
  const direction =
    preference.order === 'follow' ? player.current?.podcast_list_order || 'desc' : preference.order;
  return (
    <aside className="radio-programme" aria-label="接下来播放">
      <header className="programme-heading">
        <div className="programme-heading-main">
          <span className="print-kicker">UP NEXT</span>
          <h2>
            接下来播放 <small>{entries.length}</small>
          </h2>
        </div>
        <span className="programme-status">
          {direction === 'off' ? '自动续播关闭' : direction === 'asc' ? '从旧到新' : '从新到旧'}
        </span>
      </header>
      <div className="programme-settings">
        <label>
          <span className="sr-only">播客续播顺序</span>
          <select
            aria-label="播客续播顺序"
            value={preference.order}
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
      <ol className="programme-list">
        {(expanded ? entries : entries.slice(0, 3)).map((track, i) => (
          <li key={`${track.id}-${i}`}>
            <span className="programme-number">{String(i + 1).padStart(2, '0')}</span>
            <button
              className="programme-track"
              onClick={() => player.start(player.queue, player.index + 1 + i)}
            >
              <strong>{track.title}</strong>
              <span>
                {track.podcast_queue_origin === 'auto' ? '自动续播' : '手动添加'} ·{' '}
                {time(track.duration_ms / 1000)}
                {track.podcast_position_seconds
                  ? ` · 已听 ${time(track.podcast_position_seconds)}`
                  : ` · ${date(track.release_date)}`}
              </span>
            </button>
            <button
              className="programme-remove"
              aria-label={`移除待播 ${track.title}`}
              onClick={() => player.remove(player.index + 1 + i)}
            >
              ×
            </button>
          </li>
        ))}
      </ol>
      {!entries.length && (
        <p className="programme-empty">
          {preference.order === 'off'
            ? '听完这一集，让耳朵休息一下。'
            : player.podcastQueueStatus === 'loading'
              ? '正在整理接下来的节目…'
              : player.podcastQueueStatus === 'error'
                ? '暂时无法读取后续单集，当前播放不受影响。'
                : '这个方向的未听单集已播完，可以换个顺序。'}
        </p>
      )}
      <footer>
        <span>手动添加优先 · 每个节目记住偏好</span>
        {entries.length > 3 && (
          <button onClick={() => setExpanded(!expanded)}>
            {expanded ? '收起' : `查看全部 ${entries.length} 集`}
          </button>
        )}
      </footer>
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
                {Math.round(track.duration_ms / 60000)} 分钟 · {track.format.toUpperCase()}
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
