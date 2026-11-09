import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Album } from './api';
import { Icon } from './icons';

export function AlbumMenu({
  album,
  x,
  y,
  canManage,
  onClose,
  onOpen,
  onPlay,
  onEdit,
}: {
  album: Album;
  x: number;
  y: number;
  canManage: boolean;
  onClose: () => void;
  onOpen: () => void;
  onPlay: () => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keyboard);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', keyboard);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  // Prevent menu from overflowing right or bottom edge
  const left = Math.min(x, window.innerWidth - 220);
  const top = Math.min(y, window.innerHeight - 200);

  return (
    <div
      ref={menu}
      className="playlist-context"
      role="menu"
      aria-label={t('albumMenu.ariaLabel', { title: album.title })}
      style={{
        position: 'fixed',
        left: Math.max(10, left),
        top: Math.max(10, top),
        zIndex: 1000,
      }}
    >
      <strong
        title={album.title}
        style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {album.title}
      </strong>
      <button
        role="menuitem"
        onClick={() => {
          onOpen();
          onClose();
        }}
      >
        <Icon name="album" /> {t('albumMenu.open')}
      </button>
      <button
        role="menuitem"
        onClick={() => {
          onPlay();
          onClose();
        }}
      >
        <Icon name="play" /> {t('albumMenu.playAll')}
      </button>
      {canManage && (
        <button
          role="menuitem"
          onClick={() => {
            onEdit();
            onClose();
          }}
        >
          <Icon name="edit" /> {t('albumMenu.edit')}
        </button>
      )}
      <button
        role="menuitem"
        onClick={() => {
          navigator.clipboard.writeText(album.title);
          onClose();
        }}
      >
        <Icon name="draft" /> {t('albumMenu.copyTitle')}
      </button>
    </div>
  );
}
