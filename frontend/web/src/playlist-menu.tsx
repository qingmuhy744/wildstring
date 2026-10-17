import { useEffect, useRef } from 'react';
import type { Playlist } from './api';
import { Icon } from './icons';

export function PlaylistMenu({
  playlist,
  x,
  y,
  following,
  onClose,
  onOpen,
  onEdit,
  onDelete,
  onFollow,
}: {
  playlist: Playlist;
  x: number;
  y: number;
  following: boolean;
  onClose: () => void;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onFollow: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menu.current?.querySelector('button')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        const buttons = [...(menu.current?.querySelectorAll('button') || [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[
          (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        ]?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keyboard);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', keyboard);
      window.removeEventListener('resize', onClose);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [onClose]);
  return (
    <div
      className="playlist-context"
      role="menu"
      aria-label={`${playlist.name}的歌单操作`}
      ref={menu}
      style={{
        left: Math.max(8, Math.min(x, window.innerWidth - 228)),
        top: Math.max(8, Math.min(y, window.innerHeight - 260)),
      }}
    >
      <strong>{playlist.name}</strong>
      <button role="menuitem" onClick={onOpen}>
        <Icon name="playlist" />
        打开歌单
      </button>
      <button role="menuitem" onClick={onFollow}>
        <Icon name="download" />
        {following ? '关闭自动下载' : '自动下载歌单'}
      </button>
      {playlist.kind !== 'favorites' && (
        <>
          <button role="menuitem" onClick={onEdit}>
            <Icon name="edit" />
            编辑歌单
          </button>
          <button role="menuitem" className="error" onClick={onDelete}>
            <Icon name="remove" />
            删除歌单
          </button>
        </>
      )}
    </div>
  );
}
