import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TrackPage } from './api';

const BLOCK_ROWS = 25;
const WINDOW_THRESHOLD = 150;
const OVERSCAN_PX = 640;

type Block = {
  first: number;
  count: number;
  key: string;
  discs: number;
};
export type TrackBlockMeasurements = Map<string, { width: number; height: number }>;

export function TrackWindow({
  page,
  discOffsets,
  listSize,
  measurements,
  anchorID,
  renderTrack,
}: {
  page: TrackPage;
  discOffsets: readonly number[];
  listSize: string;
  measurements: TrackBlockMeasurements;
  anchorID?: string;
  renderTrack: (index: number) => ReactNode;
}) {
  const windowed = page.items.length > WINDOW_THRESHOLD;
  const blocks = useMemo(() => {
    const blocks: Block[] = [];
    for (let first = 0; first < page.items.length;) {
      const absolute = page.offset + first;
      const count = Math.min(BLOCK_ROWS - (absolute % BLOCK_ROWS), page.items.length - first);
      blocks.push({
        first,
        count,
        key: `${page.items[first].id}:${page.items[first + count - 1].id}:${count}`,
        discs: discOffsets.filter((offset) => offset >= absolute && offset < absolute + count)
          .length,
      });
      first += count;
    }
    return blocks;
  }, [page.items, page.offset, discOffsets]);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const [near, setNear] = useState<ReadonlySet<string>>(() => new Set());
  const [focused, setFocused] = useState<string>();
  const [width, setWidth] = useState(0);
  const anchorIndex = anchorID ? page.items.findIndex(({ id }) => id === anchorID) : -1;

  useLayoutEffect(() => {
    const node = elements.current.values().next().value?.parentElement;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(node);
    return () => resize.disconnect();
  }, [blocks]);

  useLayoutEffect(() => {
    if (!windowed) return;
    const keys = new Set<string>();
    for (const block of blocks) {
      const box = elements.current.get(block.key)?.getBoundingClientRect();
      if (box && box.bottom > -OVERSCAN_PX && box.top < innerHeight + OVERSCAN_PX)
        keys.add(block.key);
    }
    setNear(new Set(keys));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const { target, isIntersecting } of entries) {
          const key = (target as HTMLElement).dataset.trackBlock!;
          if (isIntersecting) keys.add(key);
          else keys.delete(key);
        }
        setNear(new Set(keys));
      },
      { rootMargin: `${OVERSCAN_PX}px 0px` },
    );
    for (const node of elements.current.values()) observer.observe(node);
    return () => observer.disconnect();
  }, [blocks, windowed]);

  // Preserve the actual height of groups with extra disc headers or longer labels.
  useLayoutEffect(() => {
    if (!width) return;
    const observer = new ResizeObserver((entries) => {
      for (const { target, contentRect } of entries) {
        const node = target as HTMLElement;
        if (!node.firstElementChild) continue;
        measurements.set(`${listSize}:${node.dataset.trackBlock}`, {
          width,
          height: contentRect.height,
        });
      }
    });
    for (const node of elements.current.values()) {
      if (node.firstElementChild) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [blocks, measurements, width, listSize, near, focused, anchorIndex]);

  return blocks.map(({ first, count, key, discs }) => {
    const shown =
      !windowed ||
      first === 0 ||
      near.has(key) ||
      focused === key ||
      (anchorIndex >= first && anchorIndex < first + count);
    const measured = measurements.get(`${listSize}:${key}`);
    const placeholder =
      measured?.width === width
        ? measured.height
        : `calc(${count} * var(--track-row-height) + ${discs} * var(--track-disc-height))`;
    return (
      <div
        role={shown ? 'rowgroup' : undefined}
        aria-hidden={!shown || undefined}
        key={key}
        data-track-block={key}
        data-track-offset={page.offset + first}
        ref={(element) => {
          if (element) elements.current.set(key, element);
          else elements.current.delete(key);
        }}
        style={shown ? undefined : { height: placeholder }}
        onFocusCapture={() => setFocused(key)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setFocused((previous) => (previous === key ? undefined : previous));
          }
        }}
      >
        {shown && Array.from({ length: count }, (_, row) => renderTrack(first + row))}
      </div>
    );
  });
}
