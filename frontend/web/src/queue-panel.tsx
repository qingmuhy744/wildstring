import { useId } from 'react';
import { artist } from './api';
import type { Player } from './player';
import { PlaybackIndicator } from './playback-indicator';

export function QueuePanel({
  player,
  onClose,
  onNotice,
  embedded = false,
  upNextOnly = false,
  upNextPodcastId,
}: {
  player: Player;
  onClose: () => void;
  onNotice: (message: string) => void;
  embedded?: boolean;
  upNextOnly?: boolean;
  upNextPodcastId?: string;
}) {
  const instruction = useId();
  const entries = player.queue
    .map((track, index) => ({ track, index }))
    .filter(
      ({ track, index }) =>
        !upNextOnly ||
        (index > player.index && (!upNextPodcastId || track.podcast_id === upNextPodcastId)),
    );

  function move(from: number, to: number) {
    if (from === to) return;
    player.move(from, to);
    onNotice('已调整播放顺序');
  }
  return (
    <aside className={`queue-panel ${embedded ? 'embedded-queue' : ''}`} aria-label="播放队列">
      <div className="queue-heading">
        <div>
          <span className="eyebrow">UP NEXT</span>
          <h2>
            {upNextOnly ? '下一集' : '播放队列'} <small>{entries.length}</small>
          </h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="关闭队列">
          ×
        </button>
      </div>
      <p className="sr-only" id={instruction}>
        使用每首歌曲右侧的上移和下移按钮调整播放顺序。
      </p>
      {entries.length ? (
        <ol>
          {entries.map(({ track, index: i }, entryIndex) => (
            <li
              key={`${track.id}-${i}`}
              aria-current={i === player.index ? 'true' : undefined}
              className={i === player.index ? 'selected' : ''}
            >
              <span className="queue-index">
                {i === player.index ? (
                  <PlaybackIndicator playing={player.playing} buffering={player.buffering} />
                ) : upNextOnly ? (
                  entryIndex + 1
                ) : (
                  i + 1
                )}
              </span>
              <button className="track-title" onClick={() => player.start(player.queue, i)}>
                <strong>{track.title}</strong>
                <small>{artist(track)}</small>
              </button>
              <span className="queue-reorder" role="group" aria-label={`调整队列第 ${i + 1} 首`}>
                <button
                  className="icon-button"
                  disabled={i === 0}
                  onClick={() => move(i, i - 1)}
                  aria-label={`上移队列第 ${i + 1} 首`}
                  aria-describedby={instruction}
                >
                  ↑
                </button>
                <button
                  className="icon-button"
                  disabled={i === player.queue.length - 1}
                  onClick={() => move(i, i + 1)}
                  aria-label={`下移队列第 ${i + 1} 首`}
                  aria-describedby={instruction}
                >
                  ↓
                </button>
              </span>
              <button
                className="icon-button"
                disabled={i === player.index}
                onClick={() => player.remove(i)}
                aria-label={`移除队列第 ${i + 1} 首`}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">从歌曲操作中加入队列，或直接播放曲库。</p>
      )}
    </aside>
  );
}
