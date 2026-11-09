import { useId } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
    onNotice(t('queuePanel.orderAdjusted'));
  }
  return (
    <aside
      className={`queue-panel ${embedded ? 'embedded-queue' : ''}`}
      aria-label={t('queuePanel.ariaLabel')}
    >
      <div className="queue-heading">
        <div>
          <h2>
            {upNextOnly ? t('queuePanel.nextEpisode') : t('queuePanel.title')}{' '}
            <small>{entries.length}</small>
          </h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label={t('queuePanel.close')}>
          ×
        </button>
      </div>
      <p className="sr-only" id={instruction}>
        {t('queuePanel.reorderInstruction')}
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
              <span
                className="queue-reorder"
                role="group"
                aria-label={t('queuePanel.adjustIndex', { index: i + 1 })}
              >
                <button
                  className="icon-button"
                  disabled={i === 0}
                  onClick={() => move(i, i - 1)}
                  aria-label={t('queuePanel.moveUpIndex', { index: i + 1 })}
                  aria-describedby={instruction}
                >
                  ↑
                </button>
                <button
                  className="icon-button"
                  disabled={i === player.queue.length - 1}
                  onClick={() => move(i, i + 1)}
                  aria-label={t('queuePanel.moveDownIndex', { index: i + 1 })}
                  aria-describedby={instruction}
                >
                  ↓
                </button>
              </span>
              <button
                className="icon-button"
                disabled={i === player.index}
                onClick={() => player.remove(i)}
                aria-label={t('queuePanel.removeIndex', { index: i + 1 })}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">{t('queuePanel.emptyHint')}</p>
      )}
      {isPodcast && (
        <div
          className="queue-podcast-continuation"
          role="group"
          aria-label={t('queuePanel.autoContinueAria')}
        >
          <div className="queue-continuation-header">
            <strong>{t('queuePanel.autoContinue')}</strong>
            <select
              aria-label={t('queuePanel.orderAria')}
              value={!auto ? 'off' : preference.order}
              onChange={(event) =>
                player.setPodcastPreference({
                  ...preference,
                  order: event.target.value as PodcastOrder,
                })
              }
            >
              <option value="follow">{t('queuePanel.orderFollow')}</option>
              <option value="asc">{t('queuePanel.orderAsc')}</option>
              <option value="desc">{t('queuePanel.orderDesc')}</option>
              <option value="off">{t('queuePanel.orderOff')}</option>
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
                    <small>
                      {t('queuePanel.autoContinueArtist', {
                        artist: artist(track),
                      })}
                    </small>
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => {
                      player.enqueue(track);
                      onNotice(t('queuePanel.addedToQueueNotice'));
                    }}
                    aria-label={t('queuePanel.addToQueueAria', {
                      title: track.title,
                    })}
                    title={t('queuePanel.addToQueueTitle')}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => player.dismissPodcastPreview(track.id)}
                    aria-label={t('queuePanel.dismissPreviewAria', {
                      title: track.title,
                    })}
                    title={t('queuePanel.dismissPreviewTitle')}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted queue-continuation-empty">
              {!auto ? t('queuePanel.autoContinueDisabled') : t('queuePanel.noMoreEpisodes')}
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
