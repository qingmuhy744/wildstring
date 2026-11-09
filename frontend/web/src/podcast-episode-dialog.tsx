import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { DialogCloseButton } from './dialog-close';
import { Icon } from './icons';
import { renderPodcastDescription } from './podcast-description';
import type { PodcastEpisode, PodcastSummary } from './podcasts';
import './podcast-episode-dialog.css';

export function PodcastEpisodeDialog({
  episode,
  podcast,
  date,
  duration,
  onClose,
  onPlay,
  onQueue,
  onSave,
  onToggleFavorite,
}: {
  episode: PodcastEpisode;
  podcast: PodcastSummary;
  date: string;
  duration: string;
  onClose: () => void;
  onPlay: () => void;
  onQueue: (next: boolean) => void;
  onSave: () => void;
  onToggleFavorite?: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      previous?.focus({ preventScroll: true });
    };
  }, []);
  const extension = new URL(episode.audio_url).pathname.match(
    /\.(mp3|m4a|aac|ogg|opus|flac|wav|webm)$/i,
  )?.[1];
  const isFavorited = Boolean(episode.favorite || episode.favorited || episode.loved);
  return (
    <dialog
      ref={dialog}
      className="podcast-episode-dialog"
      aria-labelledby="podcast-episode-heading"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            onClose();
        }
      }}
    >
      <header className="episode-dialog-header">
        <div className="episode-dialog-identity">
          <div className="episode-dialog-cover" aria-hidden="true">
            {podcast.cover_url ? <img src={podcast.cover_url} alt="" /> : <Icon name="podcast" />}
          </div>
          <div className="episode-dialog-heading">
            <span className="episode-dialog-programme">{podcast.title}</span>
            <h2 id="podcast-episode-heading">{episode.title}</h2>
          </div>
        </div>
        <DialogCloseButton aria-label={t('podcastEpisodeDialog.closeDetails')} onClick={onClose} />
        <div className="episode-dialog-meta">
          {date && <span>{t('podcastEpisodeDialog.publishedAt', { date })}</span>}
          {duration && <span>{t('podcastEpisodeDialog.duration', { duration })}</span>}
          <span className="episode-dialog-availability">
            {episode.download_status === 'downloaded'
              ? t('podcastEpisodeDialog.serverDownloaded')
              : t('podcastEpisodeDialog.onlineAudio')}
          </span>
        </div>
      </header>
      <section
        className="episode-dialog-description"
        aria-label={t('podcastEpisodeDialog.descriptionAriaLabel')}
        tabIndex={0}
      >
        <h3>{t('podcastEpisodeDialog.descriptionHeading')}</h3>
        {renderPodcastDescription(episode.description) || (
          <p>{t('podcastEpisodeDialog.noDescription')}</p>
        )}
      </section>
      <footer className="episode-dialog-footer">
        <div className="episode-dialog-playback">
          <button type="button" className="primary" onClick={onPlay}>
            <Icon name="play" />
            {t('podcastEpisodeDialog.playEpisode')}
          </button>
          <button type="button" onClick={() => onQueue(true)}>
            <Icon name="next" />
            {t('podcastEpisodeDialog.playNext')}
          </button>
          <button type="button" onClick={() => onQueue(false)}>
            <Icon name="queue" />
            {t('podcastEpisodeDialog.addToQueue')}
          </button>
        </div>
        <div className="episode-dialog-files">
          <a
            href={`/api/v1/podcasts/episodes/${encodeURIComponent(episode.id)}/stream?download=1`}
            download
            title={t('podcastEpisodeDialog.downloadTooltip')}
          >
            <Icon name="download" />
            {extension
              ? t('podcastEpisodeDialog.downloadExtension', { extension: extension.toUpperCase() })
              : t('podcastEpisodeDialog.downloadAudio')}
          </a>
          <span>{t('podcastEpisodeDialog.saveToDevice')}</span>
          {onToggleFavorite && (
            <button
              type="button"
              className={`episode-favorite-btn${isFavorited ? ' active' : ''}`}
              onClick={onToggleFavorite}
              title={
                isFavorited
                  ? t('podcastEpisodeDialog.unfavoriteTooltip')
                  : t('podcastEpisodeDialog.favoriteTooltip')
              }
            >
              <Icon name="heart" />
              {isFavorited
                ? t('podcastEpisodeDialog.unfavorite')
                : t('podcastEpisodeDialog.favorite')}
            </button>
          )}
          <button type="button" className="episode-save-btn" onClick={onSave}>
            {episode.resource_saved
              ? t('podcastEpisodeDialog.unsaveResource')
              : t('podcastEpisodeDialog.saveToServer')}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
