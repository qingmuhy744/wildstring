import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Playlist, Track } from './api';
import { FavoriteButton, type Favorites } from './favorites';
import type { Player } from './player';
import { Icon } from './icons';

export interface TrackOperations {
  favorites: Favorites;
  playlists: Playlist[];
  onAdd: (track: Track, playlist: Playlist) => Promise<void>;
  onCreate: (track: Track) => void;
  onOpenAlbum?: (track: Track) => void;
  onEdit?: (track: Track) => void;
  onRefresh?: (track: Track) => void;
  onDownload?: (track: Track) => void;
  onRemove?: (track: Track) => void;
  onMove?: (track: Track, direction: -1 | 1) => void;
  onFileInfo?: (track: Track) => void;
}
export function TrackActions({
  track,
  player,
  operations,
  onNotice,
}: {
  track: Track;
  player: Player;
  operations: TrackOperations;
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId(),
    panel = useRef<HTMLDivElement>(null);
  function hide() {
    panel.current?.hidePopover();
  }
  return (
    <div className="track-actions">
      <FavoriteButton track={track} favorites={operations.favorites} />
      <button
        className="icon-button track-more"
        popoverTarget={id}
        aria-label={t('trackActions.trackOperations', { title: track.title })}
        data-help={t('trackActions.moreOperations')}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          if (panel.current) {
            panel.current.style.left = `${Math.max(12, Math.min(innerWidth - 252, box.right - 240))}px`;
            panel.current.style.top = `${Math.max(12, Math.min(innerHeight - 330, box.bottom + 8))}px`;
            requestAnimationFrame(() => {
              const node = panel.current;
              if (node?.matches(':popover-open')) {
                node.style.top = `${Math.max(12, Math.min(innerHeight - node.getBoundingClientRect().height - 12, box.bottom + 8))}px`;
              }
            });
          }
        }}
      >
        <Icon name="more" />
      </button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        className="track-popover"
        role="group"
        aria-label={t('trackActions.operationsFor', { title: track.title })}
      >
        <p className="ellipsis">{track.title}</p>
        {operations.onOpenAlbum && track.album_id && (
          <button
            onClick={() => {
              operations.onOpenAlbum!(track);
              hide();
            }}
          >
            <Icon name="album" />
            <span>{t('trackActions.viewAlbum')}</span>
            <Icon name="chevron" className="menu-chevron" />
          </button>
        )}
        {operations.onEdit && (
          <button
            onClick={() => {
              operations.onEdit!(track);
              hide();
            }}
          >
            <Icon name="edit" />
            <span>{t('trackActions.editTrack')}</span>
          </button>
        )}
        {operations.onRefresh && (
          <button
            onClick={() => {
              operations.onRefresh!(track);
              hide();
            }}
          >
            <Icon name="refresh" />
            <span>{t('trackActions.refreshMetadata')}</span>
          </button>
        )}
        {operations.onFileInfo && (
          <button
            onClick={() => {
              operations.onFileInfo!(track);
              hide();
            }}
          >
            <Icon name="info" />
            <span>{t('trackActions.fileInfo')}</span>
          </button>
        )}
        <button
          onClick={() => {
            if (player.playNext(track))
              onNotice(t('trackActions.playNextNotice', { title: track.title }));
            else onNotice(t('trackActions.queueFull'));
            hide();
          }}
        >
          <Icon name="next" />
          <span>{t('trackActions.playNext')}</span>
        </button>
        <button
          aria-label={t('trackActions.addToQueueAria', { title: track.title })}
          onClick={() => {
            if (player.enqueue(track))
              onNotice(t('trackActions.enqueuedNotice', { title: track.title }));
            else onNotice(t('trackActions.queueFull'));
            hide();
          }}
        >
          <Icon name="queue" />
          <span>{t('trackActions.addToQueue')}</span>
        </button>
        <label>
          <span className="track-menu-label">
            <Icon name="playlist" />
            <span>{t('trackActions.addToPlaylist')}</span>
          </span>
          <select
            aria-label={t('trackActions.addToPlaylistAria', { title: track.title })}
            value=""
            disabled={!operations.playlists.length}
            onChange={(event) => {
              const list = operations.playlists.find((item) => item.id === event.target.value);
              if (list) {
                void operations.onAdd(track, list);
                hide();
              }
            }}
          >
            <option value="">
              {operations.playlists.length
                ? t('trackActions.selectPlaylist')
                : t('trackActions.noPlaylists')}
            </option>
            {operations.playlists.map((list) => (
              <option value={list.id} key={list.id}>
                {list.name}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => {
            operations.onCreate(track);
            hide();
          }}
        >
          <Icon name="add" />
          <span>{t('trackActions.newPlaylist')}</span>
        </button>
        {operations.onDownload && (
          <button
            onClick={() => {
              operations.onDownload!(track);
              hide();
            }}
          >
            <Icon name="download" />
            <span>{t('trackActions.saveOffline')}</span>
          </button>
        )}
        {operations.onMove && (
          <div className="playlist-move">
            <button
              onClick={() => {
                operations.onMove!(track, -1);
                hide();
              }}
            >
              <Icon name="up" />
              <span>{t('trackActions.moveUp')}</span>
            </button>
            <button
              onClick={() => {
                operations.onMove!(track, 1);
                hide();
              }}
            >
              <Icon name="down" />
              <span>{t('trackActions.moveDown')}</span>
            </button>
          </div>
        )}
        {operations.onRemove && (
          <button
            className="danger-text"
            onClick={() => {
              operations.onRemove!(track);
              hide();
            }}
          >
            <Icon name="remove" />
            <span>{t('trackActions.removeFromPlaylist')}</span>
          </button>
        )}
      </div>
    </div>
  );
}
