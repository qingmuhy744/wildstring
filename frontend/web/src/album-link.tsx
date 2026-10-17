import type { Track } from './api';
import { Icon } from './icons';

export function AlbumLink({ track, onOpen }: { track: Track; onOpen: (track: Track) => void }) {
  return (
    <button
      className="album-link"
      aria-label={`查看所属专辑 ${track.album || '未知专辑'}`}
      onClick={() => onOpen(track)}
    >
      <Icon name="album" />
      <span className="ellipsis">{track.album || '未知专辑'}</span>
      <Icon name="chevron" className="album-chevron" />
    </button>
  );
}
