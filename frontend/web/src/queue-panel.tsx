import { useId } from 'react';
import { artist } from './api';
import type { Player } from './player';
import { PlaybackIndicator } from './playback-indicator';
import type { PodcastOrder } from './podcast-continuation';

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
  const isPodcast = Boolean(player.current?.podcast_id) && !embedded && !upNextOnly;
  const preview = isPodcast ? player.podcastPreview : [];
  const preference = player.podcastPreference;
  const auto = preference.order !== 'off' && preference.autoContinue !== false;
  const manualAfterCurrent = player.queue
    .slice(player.index + 1)
    .some((track) => track.podcast_queue_origin !== 'auto');

  function move(from: number, to: number) {
    if (from === to) return;
    player.move(from, to);
    onNotice('已调整播放顺序');
  }
  return (
    <aside className={`queue-panel ${embedded ? 'embedded-queue' : ''}`} aria-label="播放队列">
      <div className="queue-heading">
        <div>
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
      {isPodcast && (
        <div className="queue-podcast-continuation" role="group" aria-label="自动续播">
          <div className="queue-continuation-header">
            <strong>自动续播</strong>
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
          </div>
          {preview.length > 0 ? (
            <div className="queue-continuation-list">
              {preview.map((track, idx) => (
                <div className="queue-continuation-item" key={`${track.id}-${idx}`}>
                  <span className="queue-index">{entries.length + idx + 1}</span>
                  <button
                    type="button"
                    className="track-title"
                    onClick={() =>
                      manualAfterCurrent
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
                    <small>自动续播 · {artist(track)}</small>
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => {
                      player.enqueue(track);
                      onNotice('已加入手动待播清单');
                    }}
                    aria-label={`加入待播 ${track.title}`}
                    title="加入手动待播清单"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => player.dismissPodcastPreview(track.id)}
                    aria-label={`不再预览 ${track.title}`}
                    title="不再预览"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted queue-continuation-empty">
              {!auto ? '已关闭自动续播，播完待播即停。' : '当前节目没有更多可自动续播的单集。'}
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
