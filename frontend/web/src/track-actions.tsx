import { useId, useRef } from 'react';
import type { Playlist, Track } from './api';
import { FavoriteButton, type Favorites } from './favorites';
import type { Player } from './player';

export interface TrackOperations {
  favorites: Favorites;
  playlists: Playlist[];
  onAdd: (track: Track, playlist: Playlist) => Promise<void>;
  onCreate: (track: Track) => void;
  onEdit?: (track: Track) => void;
  onRefresh?: (track: Track) => void;
  onRemove?: (track: Track) => void;
  onMove?: (track: Track, direction: -1 | 1) => void;
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
        aria-label={`歌曲操作 ${track.title}`}
        title="更多操作"
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
        ⋯
      </button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        className="track-popover"
        role="group"
        aria-label={`操作 ${track.title}`}
      >
        <p className="ellipsis">{track.title}</p>
        {operations.onEdit && (
          <button
            onClick={() => {
              operations.onEdit!(track);
              hide();
            }}
          >
            编辑歌曲信息
          </button>
        )}
        {operations.onRefresh && (
          <button
            onClick={() => {
              operations.onRefresh!(track);
              hide();
            }}
          >
            更新元数据
          </button>
        )}
        <button
          onClick={() => {
            player.playNext(track);
            onNotice(`下一首播放：${track.title}`);
            hide();
          }}
        >
          下一首播放
        </button>
        <button
          aria-label={`将 ${track.title} 加入队列`}
          onClick={() => {
            player.enqueue(track);
            onNotice(`已加入队列：${track.title}`);
            hide();
          }}
        >
          加入播放队列
        </button>
        <label>
          加入歌单
          <select
            aria-label={`将 ${track.title} 加入歌单`}
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
              {operations.playlists.length ? '选择普通歌单…' : '还没有普通歌单'}
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
          新建歌单…
        </button>
        {operations.onMove && (
          <div className="playlist-move">
            <button
              onClick={() => {
                operations.onMove!(track, -1);
                hide();
              }}
            >
              歌单中上移
            </button>
            <button
              onClick={() => {
                operations.onMove!(track, 1);
                hide();
              }}
            >
              歌单中下移
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
            从歌单移除
          </button>
        )}
      </div>
    </div>
  );
}
