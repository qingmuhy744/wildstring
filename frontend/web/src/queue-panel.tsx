import { useEffect, useId, useRef, useState } from 'react';
import { artist } from './api';
import type { Player } from './player';

type Drag = {
  pointer: number;
  handle: HTMLButtonElement;
  queue: Player['queue'];
  from: number;
  y: number;
  startY: number;
  startScroll: number;
  maxScroll: number;
  centers: number[];
};

export function QueuePanel({
  player,
  onClose,
  onNotice,
  embedded = false,
}: {
  player: Player;
  onClose: () => void;
  onNotice: (message: string) => void;
  embedded?: boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  const dragging = useRef<Drag | null>(null);
  const frame = useRef(0);
  const instruction = useId();
  const [preview, setPreview] = useState<{ from: number; to: number; offset: number } | null>(null);

  function clearDrag() {
    const drag = dragging.current;
    dragging.current = null;
    cancelAnimationFrame(frame.current);
    if (drag?.handle.hasPointerCapture(drag.pointer))
      drag.handle.releasePointerCapture(drag.pointer);
    setPreview(null);
  }

  useEffect(() => {
    if (dragging.current && dragging.current.queue !== player.queue) clearDrag();
  }, [player.queue]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
    },
    [],
  );

  function updatePreview() {
    const drag = dragging.current;
    const element = panel.current;
    if (!drag || !element) return;
    const y = drag.y + element.scrollTop;
    const to = drag.centers.reduce(
      (nearest, center, i) =>
        Math.abs(center - y) < Math.abs(drag.centers[nearest] - y) ? i : nearest,
      drag.from,
    );
    const offset = drag.y - drag.startY + element.scrollTop - drag.startScroll;
    setPreview((previous) =>
      previous?.to === to && previous.offset === offset
        ? previous
        : { from: drag.from, to, offset },
    );
    return to;
  }

  function autoScroll(previousTime: number) {
    frame.current = requestAnimationFrame((now) => {
      const drag = dragging.current;
      const element = panel.current;
      if (!drag || !element) return;
      if (Math.abs(drag.y - drag.startY) > 4) {
        const box = element.getBoundingClientRect();
        const edge = 48;
        const speed =
          drag.y < box.top + edge
            ? -Math.min(1, (box.top + edge - drag.y) / edge)
            : drag.y > box.bottom - edge
              ? Math.min(1, (drag.y - box.bottom + edge) / edge)
              : 0;
        element.scrollTop = Math.max(
          0,
          Math.min(
            drag.maxScroll,
            element.scrollTop + speed * Math.min(now - previousTime, 32) * 0.7,
          ),
        );
        updatePreview();
      }
      autoScroll(now);
    });
  }

  function move(from: number, to: number) {
    if (from === to) return;
    player.move(from, to);
    onNotice('已调整播放顺序');
  }
  return (
    <aside
      className={`queue-panel ${embedded ? 'embedded-queue' : ''}`}
      aria-label="播放队列"
      ref={panel}
    >
      <div className="queue-heading">
        <div>
          <span className="eyebrow">UP NEXT</span>
          <h2>
            播放队列 <small>{player.queue.length}</small>
          </h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="关闭队列">
          ×
        </button>
      </div>
      <p className="sr-only" id={instruction}>
        按住手柄拖动排序，也可聚焦手柄后按上下方向键调整。
      </p>
      {player.queue.length ? (
        <ol>
          {player.queue.map((track, i) => (
            <li
              key={`${track.id}-${i}`}
              className={[
                i === player.index ? 'selected' : '',
                preview?.from === i ? 'is-dragging' : '',
                preview?.to === i && preview.from !== i
                  ? preview.from > i
                    ? 'drop-before'
                    : 'drop-after'
                  : '',
              ].join(' ')}
              style={
                preview?.from === i ? { transform: `translateY(${preview.offset}px)` } : undefined
              }
            >
              <button
                className="queue-grip icon-button"
                aria-label={`拖动队列第 ${i + 1} 首排序`}
                aria-describedby={instruction}
                title="拖动排序"
                onPointerDown={(event) => {
                  const element = panel.current;
                  if (!element || !event.isPrimary || event.button !== 0 || dragging.current)
                    return;
                  event.preventDefault();
                  event.currentTarget.focus({ preventScroll: true });
                  event.currentTarget.setPointerCapture(event.pointerId);
                  dragging.current = {
                    pointer: event.pointerId,
                    handle: event.currentTarget,
                    queue: player.queue,
                    from: i,
                    y: event.clientY,
                    startY: event.clientY,
                    startScroll: element.scrollTop,
                    maxScroll: element.scrollHeight - element.clientHeight,
                    centers: Array.from(element.querySelectorAll('li'), (row) => {
                      const box = row.getBoundingClientRect();
                      return (box.top + box.bottom) / 2 + element.scrollTop;
                    }),
                  };
                  setPreview({ from: i, to: i, offset: 0 });
                  autoScroll(performance.now());
                }}
                onPointerMove={(event) => {
                  if (dragging.current?.pointer !== event.pointerId) return;
                  dragging.current.y = event.clientY;
                  updatePreview();
                }}
                onPointerUp={(event) => {
                  const drag = dragging.current;
                  if (!drag || drag.pointer !== event.pointerId) return;
                  drag.y = event.clientY;
                  const to = updatePreview();
                  clearDrag();
                  if (drag.queue === player.queue && to !== undefined) move(drag.from, to);
                }}
                onPointerCancel={clearDrag}
                onLostPointerCapture={clearDrag}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && dragging.current) {
                    event.preventDefault();
                    event.stopPropagation();
                    clearDrag();
                    return;
                  }
                  if (dragging.current) return;
                  const to = i + (event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0);
                  if (to === i) return;
                  event.preventDefault();
                  if (to < 0 || to >= player.queue.length) return;
                  move(i, to);
                  requestAnimationFrame(() => {
                    panel.current?.querySelectorAll<HTMLButtonElement>('.queue-grip')[to]?.focus();
                  });
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <path d="M5 7h14M5 12h14M5 17h14" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
              <span className="queue-index">{i === player.index ? '♫' : i + 1}</span>
              <button className="track-title" onClick={() => player.start(player.queue, i)}>
                <strong>{track.title}</strong>
                <small>{artist(track)}</small>
              </button>
              <button
                className="icon-button"
                disabled={i === player.index}
                onClick={() => player.remove(i)}
                aria-label={`移除队列第 ${i + 1} 首`}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">从歌曲操作中加入队列，或直接播放曲库。</p>
      )}
    </aside>
  );
}
