import { useTranslation } from 'react-i18next';
import type { Track } from './api';
import { Icon } from './icons';

export function AlbumLink({ track, onOpen }: { track: Track; onOpen: (track: Track) => void }) {
  const { t } = useTranslation();
  const albumName = track.album || t('albumLink.unknownAlbum');
  return (
    <button
      className="album-link"
      aria-label={t('albumLink.viewAlbumAria', { album: albumName })}
      onClick={() => onOpen(track)}
    >
      <Icon name="album" />
      <span className="ellipsis">{albumName}</span>
      <Icon name="chevron" className="album-chevron" />
    </button>
  );
}
