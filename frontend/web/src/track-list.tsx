import { artist, time, type TrackPage } from './api';
import { Cover } from './cover';
import type { Player } from './player';

export function TrackList({
  page,
  player,
  onNotice,
  revision,
}: {
  page: TrackPage;
  player: Player;
  onNotice: (notice: string) => void;
  revision: number;
}) {
  return (
    <div className="track-list" role="table" aria-label="歌曲列表">
      <div className="track-header" role="row">
        <span role="columnheader">#</span>
        <span role="columnheader">歌曲 / 艺人</span>
        <span className="album-column" role="columnheader">
          专辑
        </span>
        <span className="quality-column" role="columnheader">
          格式
        </span>
        <span role="columnheader">时长</span>
        <span role="columnheader">
          <span className="sr-only">操作</span>
        </span>
      </div>
      {page.items.map((track, i) => (
        <div
          className={`track-row ${player.current?.id === track.id ? 'current' : ''}`}
          role="row"
          key={track.id}
        >
          <span role="cell" className="track-number">
            {player.current?.id === track.id && player.playing
              ? '♫'
              : String(page.offset + i + 1).padStart(2, '0')}
          </span>
          <div role="cell" className="track-identity">
            <Cover
              key={`${track.id}-${revision}`}
              trackId={track.id}
              title={track.album || track.title}
            />
            <button
              className="track-title"
              onClick={() => player.start(page.items, i)}
              aria-label={`播放 ${track.title}`}
            >
              <strong>{track.title}</strong>
              <small>{artist(track)}</small>
            </button>
          </div>
          <span className="album-column ellipsis" role="cell" title={track.album || ''}>
            {track.album || '未知专辑'}
          </span>
          <span className="quality-column" role="cell">
            <span className="format">{track.format.toUpperCase()}</span>
          </span>
          <time role="cell">{time(track.duration_ms / 1000)}</time>
          <span role="cell">
            <button
              className="add-button"
              aria-label={`将 ${track.title} 加入队列`}
              onClick={() => {
                player.enqueue(track);
                onNotice(`已加入队列：${track.title}`);
              }}
            >
              ＋
            </button>
          </span>
        </div>
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
  return (
    <div className="pagination">
      <span>
        第 {page.offset + 1}–{page.offset + page.items.length} {unit} / 共 {page.total} {unit}
      </span>
      <div>
        <button
          disabled={page.offset === 0}
          onClick={() => onOffset(Math.max(0, page.offset - page.limit))}
        >
          上一页
        </button>
        <button
          disabled={page.offset + page.items.length >= page.total}
          onClick={() => onOffset(page.offset + page.limit)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}
