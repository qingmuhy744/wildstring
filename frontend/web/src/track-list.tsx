import { Fragment, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { trackUnavailableReason, listeningTime, time, type TrackPage } from './api';
import { TrackActions, type TrackOperations } from './track-actions';
import { Cover } from './cover';
import type { Player } from './player';
import { AlbumLink } from './album-link';
import { beforeTrackListSizeChange, useTrackListSize } from './track-list-size';
import { PlaybackIndicator } from './playback-indicator';

export function TrackList({
  page,
  player,
  onNotice,
  revision,
  operations,
  showStats = false,
  statsSort = 'last_played_at',
  albumTracks = false,
  groupDiscs = false,
  onPlay,
  onOpenArtist,
}: {
  page: TrackPage;
  player: Player;
  onNotice: (notice: string) => void;
  revision: number;
  operations: TrackOperations;
  showStats?: boolean;
  statsSort?: string;
  albumTracks?: boolean;
  groupDiscs?: boolean;
  onPlay?: (track: TrackPage['items'][number]) => void;
  onOpenArtist?: (name: string) => void;
}) {
  const { t } = useTranslation();
  const listSize = useTrackListSize();
  const root = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  useLayoutEffect(
    () =>
      beforeTrackListSizeChange(() => {
        const edge = Math.min(
          innerHeight,
          document.querySelector('.player')?.getBoundingClientRect().top ?? innerHeight,
        );
        const rows = Array.from(
          root.current?.querySelectorAll<HTMLElement>('[data-browse-id]') || [],
        );
        // A mostly clipped row may become entirely invisible when shrinking.
        // Prefer the first complete song so the visible reading anchor stays put.
        const row =
          rows.find((row) => {
            const box = row.getBoundingClientRect();
            return box.height > 0 && box.top >= 0 && box.bottom <= edge;
          }) ||
          rows.find((row) => {
            const box = row.getBoundingClientRect();
            return box.height > 0 && box.bottom > 0 && box.top < edge;
          });
        anchor.current = row
          ? { id: row.dataset.browseId!, top: row.getBoundingClientRect().top }
          : null;
      }),
    [],
  );
  useLayoutEffect(() => {
    if (!anchor.current) return;
    const previous = anchor.current;
    anchor.current = null;
    const row = Array.from(
      root.current?.querySelectorAll<HTMLElement>('[data-browse-id]') || [],
    ).find((row) => row.dataset.browseId === previous.id);
    if (row) window.scrollBy(0, row.getBoundingClientRect().top - previous.top);
  }, [listSize]);
  const multiDisc = (page.discs?.length || 0) > 1;
  const boundaries = new Map(
    groupDiscs && multiDisc ? page.discs?.map((disc) => [disc.offset, disc]) : [],
  );
  const playTrack = (track: TrackPage['items'][number], index: number) =>
    onPlay ? onPlay(track) : player.start(page.items, index);
  return (
    <div
      className={`track-list ${albumTracks ? 'album-tracks' : ''}`}
      data-list-size={listSize}
      ref={root}
      role="table"
      aria-label={t('trackList.ariaLabel')}
    >
      <div className="track-header" role="row">
        <span role="columnheader">#</span>
        <span role="columnheader">{t('trackList.headerTitleArtist')}</span>
        <span className="album-column" role="columnheader">
          {t('trackList.headerAlbum')}
        </span>
        <span className="quality-column" role="columnheader">
          {t('trackList.headerFormat')}
        </span>
        <span role="columnheader">{t('trackList.headerDuration')}</span>
        <span role="columnheader">
          <span className="sr-only">{t('trackList.headerActions')}</span>
        </span>
      </div>
      {page.items.map((track, i) => (
        <Fragment key={track.id}>
          {boundaries.has(page.offset + i) &&
            (() => {
              const disc = boundaries.get(page.offset + i)!;
              return (
                <div className="disc-heading" role="row" aria-label={`Disc ${disc.number}`}>
                  <div role="cell" className="disc-heading-content">
                    <strong>DISC {String(disc.number).padStart(2, '0')}</strong>
                    <small>{t('trackList.discTrackCount', { count: disc.track_count })}</small>
                    <span className="disc-rule" />
                  </div>
                </div>
              );
            })()}
          <div
            className={`track-row ${player.current?.id === track.id ? 'current' : ''} ${trackUnavailableReason(track) ? 'track-unavailable' : ''}`}
            role="row"
            aria-current={player.current?.id === track.id ? 'true' : undefined}
            key={track.id}
            data-browse-id={track.id}
            onClick={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest('button, a, input, select, summary, label')
              )
                return;
              playTrack(track, i);
            }}
          >
            <span role="cell" className="track-number">
              {player.current?.id === track.id ? (
                <PlaybackIndicator playing={player.playing} buffering={player.buffering} />
              ) : (
                String(
                  albumTracks ? track.track_number || page.offset + i + 1 : page.offset + i + 1,
                ).padStart(2, '0')
              )}
            </span>
            <div role="cell" className="track-identity">
              {!albumTracks && (
                <Cover
                  key={`${track.id}-${revision}`}
                  trackId={track.id}
                  title={track.album || track.title}
                />
              )}
              <div className="track-title-group">
                <button
                  className="track-title"
                  onClick={() => playTrack(track, i)}
                  aria-label={t('trackList.playTrackAria', { title: track.title })}
                >
                  <strong>{track.title}</strong>
                  {trackUnavailableReason(track) && (
                    <span className="track-unavailable-label">{trackUnavailableReason(track)}</span>
                  )}
                </button>
                <small className="track-artist-row">
                  {albumTracks && multiDisc && !groupDiscs && (
                    <span className="disc-chip">Disc {track.disc_number || 1}</span>
                  )}
                  {track.artists.length
                    ? track.artists.map((name, artistIndex) => (
                        <Fragment key={`${name}-${artistIndex}`}>
                          {artistIndex > 0 && <span aria-hidden="true"> / </span>}
                          {onOpenArtist ? (
                            <button
                              className="track-artist-link"
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                onOpenArtist(name);
                              }}
                            >
                              {name}
                            </button>
                          ) : (
                            name
                          )}
                        </Fragment>
                      ))
                    : t('trackList.unknownArtist')}
                  {showStats && (
                    <span className="track-stat">
                      {' '}
                      ·{' '}
                      {statsSort === 'play_count'
                        ? t('trackList.playCount', { count: track.play_count })
                        : statsSort === 'listened_ms'
                          ? t('trackList.listenedTime', { time: listeningTime(track.listened_ms) })
                          : track.last_played_at
                            ? t('trackList.playedAt', {
                                date: new Date(track.last_played_at).toLocaleDateString(),
                              })
                            : t('trackList.neverPlayed')}
                    </span>
                  )}
                </small>
              </div>
            </div>
            <span className="album-column ellipsis" role="cell" title={track.album || ''}>
              {operations.onOpenAlbum && track.album_id ? (
                <AlbumLink track={track} onOpen={operations.onOpenAlbum} />
              ) : (
                track.album || t('trackList.unknownAlbum')
              )}
            </span>
            <span className="quality-column" role="cell">
              <span className="format">{track.format.toUpperCase()}</span>
            </span>
            <time role="cell">{time(track.duration_ms / 1000)}</time>
            <span role="cell">
              <TrackActions
                track={track}
                player={player}
                operations={operations}
                onNotice={onNotice}
              />
            </span>
          </div>
        </Fragment>
      ))}
    </div>
  );
}
export function Pagination({
  page,
  onOffset,
  unit,
}: {
  page: { total: number; limit: number; offset: number; items: unknown[] };
  onOffset: (offset: number) => void;
  unit: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="pagination">
      <span>
        {t('trackList.paginationRange', {
          start: page.offset + 1,
          end: page.offset + page.items.length,
          total: page.total,
          unit,
        })}
      </span>
      <div>
        <button
          disabled={page.offset === 0}
          onClick={() => onOffset(Math.max(0, page.offset - page.limit))}
        >
          {t('trackList.prevPage')}
        </button>
        <button
          disabled={page.offset + page.items.length >= page.total}
          onClick={() => onOffset(page.offset + page.limit)}
        >
          {t('trackList.nextPage')}
        </button>
      </div>
    </div>
  );
}
