import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, time } from './api';

export interface Book {
  id: string;
  library_id: string;
  title: string;
  subtitle?: string;
  authors?: string[];
  has_cover?: boolean;
  has_ebook: boolean;
  has_audiobook: boolean;
  progress_status?: 'unread' | 'in_progress' | 'finished';
  resume_kind?: 'reading' | 'listening';
}

type Mode = 'scroll' | 'paginated';
export type Color = 'amber' | 'terracotta' | 'sage' | 'stone';
const colors: Color[] = ['amber', 'terracotta', 'sage', 'stone'];
interface Anchor {
  spine_index: number;
  block_index: number;
  char_offset: number;
}
interface Reading extends Anchor {
  reading_mode: Mode;
}
interface Listening {
  chapter_index: number;
  chapter_position_ms: number;
  playback_rate: number;
}
interface Checkpoint {
  version: number;
  completed?: boolean;
}
interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}
interface Block {
  block_index: number;
  tag: string;
  text: string;
  runs?: TextRun[];
  image_key?: string | null;
}
interface Chapter {
  spine_index: number;
  title: string;
}
interface Bookmark extends Anchor {
  id: string;
  kind: 'ebook' | 'audio';
  excerpt?: string;
}
interface Annotation {
  id: string;
  color: Color;
  spine_index: number;
  start_block_index: number;
  start_char_offset: number;
  end_block_index: number;
  end_char_offset: number;
  selected_text: string;
}
interface Match extends Anchor {
  excerpt: string;
}

function key(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint32Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return `ws-${Array.from(bytes, (part) => part.toString(16).padStart(8, '0')).join('')}`;
}

function deviceId() {
  const saved = localStorage.getItem('wildstring:book-device');
  if (saved) return saved;
  const id = key();
  localStorage.setItem('wildstring:book-device', id);
  return id;
}

function useCheckpoint<T>(
  path: string,
  onLoad: (value: T & Checkpoint) => void,
  initialIntent: 'resume' | 'restart' = 'resume',
) {
  const [error, setError] = useState('');
  const load = useRef(onLoad);
  load.current = onLoad;
  const session = useRef({
    id: key(),
    version: 0,
    sequence: 0,
    ready: false,
    blocked: false,
    intent: initialIntent,
  });
  const requests = useRef(Promise.resolve());
  useEffect(() => {
    session.current = {
      id: key(),
      version: 0,
      sequence: 0,
      ready: false,
      blocked: false,
      intent: initialIntent,
    };
    setError('');
    if (!path) return;
    const controller = new AbortController();
    void api<T & Checkpoint>(path, { signal: controller.signal })
      .then((value) => {
        session.current.version = value.version;
        session.current.ready = true;
        load.current(value);
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [path, initialIntent]);
  const save = useCallback(
    (fields: T, completed = false) => {
      const current = session.current;
      if (!path || !current.ready || current.blocked) return;
      const sequence = ++current.sequence;
      const intent = current.intent;
      current.intent = 'resume';
      requests.current = requests.current.then(async () => {
        if (current.blocked) return;
        try {
          const value = await api<T & Checkpoint>(path, {
            method: 'PUT',
            body: JSON.stringify({
              ...fields,
              completed,
              session_id: current.id,
              device_id: deviceId(),
              base_version: current.version,
              sequence,
              intent,
            }),
          });
          current.version = value.version;
        } catch (cause) {
          if (cause instanceof ApiError && cause.status === 409) current.blocked = true;
          setError((cause as Error).message);
        }
      });
    },
    [path],
  );
  return { save, error };
}

function codePointLength(value: string): number {
  return [...value].length;
}

function codePointOffsetInBlock(block: HTMLElement, node: Node, offset: number): number {
  if (!block.contains(node) && block !== node) {
    return 0;
  }
  const pre = document.createRange();
  pre.selectNodeContents(block);
  pre.setEnd(node, offset);
  return codePointLength(pre.toString());
}

function resolveBlockFromBoundary(
  container: Node,
  offset: number,
  viewport: HTMLElement,
  edge: 'start' | 'end',
): HTMLElement | null {
  if (container instanceof HTMLElement) {
    const direct = container.closest<HTMLElement>('[data-block]');
    if (direct && viewport.contains(direct)) return direct;
    const child =
      edge === 'end'
        ? container.childNodes.item(Math.max(0, offset - 1))
        : container.childNodes.item(Math.min(offset, Math.max(0, container.childNodes.length - 1)));
    if (child instanceof HTMLElement) {
      const candidate =
        child.closest<HTMLElement>('[data-block]') ??
        child.querySelector<HTMLElement>('[data-block]');
      if (candidate && viewport.contains(candidate)) return candidate;
    }
    return null;
  }
  const parent = container.parentElement?.closest<HTMLElement>('[data-block]') ?? null;
  return parent && viewport.contains(parent) ? parent : null;
}

function findDomPosition(
  block: HTMLElement,
  charOffset: number,
): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, charOffset);
  let current = walker.nextNode();
  let lastText: Node | null = null;
  while (current) {
    lastText = current;
    const content = current.textContent || '';
    const points = [...content];
    if (remaining <= points.length) {
      return {
        node: current,
        offset: points.slice(0, remaining).join('').length,
      };
    }
    remaining -= points.length;
    current = walker.nextNode();
  }
  if (lastText) {
    return { node: lastText, offset: (lastText.textContent || '').length };
  }
  return null;
}

interface Segment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  annotation?: Annotation;
}

function splitAnnotatedRuns(block: Block, highlights: Annotation[]): Segment[] {
  const blockAnns = highlights.filter(
    (ann) => block.block_index >= ann.start_block_index && block.block_index <= ann.end_block_index,
  );
  const runs: TextRun[] = block.runs?.length ? block.runs : [{ text: block.text }];
  const blockPoints = codePointLength(block.text);
  const cuts = new Set<number>([0, blockPoints]);
  let cursor = 0;
  for (const run of runs) {
    cursor += codePointLength(run.text);
    cuts.add(cursor);
  }
  for (const ann of blockAnns) {
    const start =
      block.block_index === ann.start_block_index ? Math.max(0, ann.start_char_offset) : 0;
    const end =
      block.block_index === ann.end_block_index
        ? Math.min(blockPoints, ann.end_char_offset)
        : blockPoints;
    if (start < end) {
      cuts.add(start);
      cuts.add(end);
    }
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const blockChars = [...block.text];
  const segments: Segment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i];
    const to = sorted[i + 1];
    if (to <= from) continue;
    let offset = 0;
    let activeRun: TextRun | undefined;
    for (const run of runs) {
      const len = codePointLength(run.text);
      if (from >= offset && from < offset + len) {
        activeRun = run;
        break;
      }
      offset += len;
    }
    const activeAnn = [...blockAnns].reverse().find((ann) => {
      const start = block.block_index === ann.start_block_index ? ann.start_char_offset : 0;
      const end = block.block_index === ann.end_block_index ? ann.end_char_offset : blockPoints;
      return from >= start && to <= end;
    });
    segments.push({
      text: blockChars.slice(from, to).join(''),
      bold: activeRun?.bold,
      italic: activeRun?.italic,
      code: activeRun?.code,
      annotation: activeAnn,
    });
  }
  return segments;
}

function renderBlockContent(block: Block, highlights: Annotation[]): ReactNode {
  const blockAnns = highlights.filter(
    (ann) => block.block_index >= ann.start_block_index && block.block_index <= ann.end_block_index,
  );
  const runs = block.runs?.length ? block.runs : [{ text: block.text }];
  const hasStyledRuns = runs.some((run) => run.bold || run.italic || run.code);
  if (!blockAnns.length && !hasStyledRuns) {
    // Keep simple unhighlighted paragraphs as a single Text node.
    return block.text;
  }
  return splitAnnotatedRuns(block, blockAnns).map((seg, idx) => {
    let node: ReactNode = seg.text;
    if (seg.code) node = <code>{node}</code>;
    if (seg.italic) node = <em>{node}</em>;
    if (seg.bold) node = <strong>{node}</strong>;
    if (seg.annotation) {
      node = (
        <mark key={idx} data-color={seg.annotation.color} data-annotation-id={seg.annotation.id}>
          {node}
        </mark>
      );
      return node;
    }
    return <span key={idx}>{node}</span>;
  });
}

export function BookReader({ book }: { book: Book }) {
  const { t } = useTranslation();
  const prefix = `/books/${book.id}`;
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [spine, setSpine] = useState(0);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [loadedSpine, setLoadedSpine] = useState(-1);
  const [mode, setMode] = useState<Mode>('scroll');
  const [dark, setDark] = useState(false);
  const [font, setFont] = useState('serif');
  const [size, setSize] = useState(18);
  const [lineHeight, setLineHeight] = useState(1.7);
  const [error, setError] = useState('');
  const [marks, setMarks] = useState<Bookmark[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [selection, setSelection] = useState<Omit<Annotation, 'id' | 'color'> | null>(null);
  const [query, setQuery] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  const pending = useRef<Anchor | null>(null);
  const visible = useRef<Anchor>({ spine_index: 0, block_index: 0, char_offset: 0 });
  const restoredViewport = useRef<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const saveTimer = useRef<number>(0);
  const saveAnchor = useRef<() => void>(() => {});
  const completedSent = useRef(false);

  function jump({ spine_index, block_index, char_offset }: Anchor, persist = true) {
    const anchor = { spine_index, block_index, char_offset };
    pending.current = anchor;
    if (anchor.spine_index === loadedSpine) restore(anchor);
    else setSpine(anchor.spine_index);
    if (persist) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = 0;
      completedSent.current = false;
      checkpoint.save({ ...anchor, reading_mode: mode });
    }
  }

  const checkpoint = useCheckpoint<Reading>(
    prefix + '/reading-progress',
    (value) => {
      if (value.version) {
        setMode(value.reading_mode);
        jump(value, false);
      }
    },
    book.progress_status === 'finished' ? 'restart' : 'resume',
  );

  useEffect(() => {
    completedSent.current = false;
    const request = new AbortController();
    const load = <T,>(path: string) => api<T>(prefix + path, { signal: request.signal });
    void Promise.all([
      load<{ chapters: Chapter[] }>('/ebook/manifest'),
      load<{ items: Bookmark[] }>('/bookmarks'),
      load<{ items: Annotation[] }>('/annotations'),
    ])
      .then(([bookData, savedMarks, savedAnnotations]) => {
        setChapters(bookData.chapters);
        setMarks(savedMarks.items.filter((mark) => mark.kind === 'ebook'));
        setAnnotations(savedAnnotations.items);
      })
      .catch((cause: Error) => {
        if (!request.signal.aborted) setError(cause.message);
      });
    return () => request.abort();
  }, [prefix]);

  useEffect(() => {
    const request = new AbortController();
    void api<{ blocks: Block[] }>(prefix + `/ebook/chapters/${spine}`, { signal: request.signal })
      .then((data) => {
        setBlocks(data.blocks);
        setLoadedSpine(spine);
      })
      .catch((cause: Error) => {
        if (!request.signal.aborted) setError(cause.message);
      });
    return () => request.abort();
  }, [prefix, spine]);

  function restore(anchor: Anchor) {
    const viewport = scroll.current;
    const block = viewport?.querySelector<HTMLElement>(`[data-block="${anchor.block_index}"]`);
    if (!viewport || !block) return;
    const box = viewport.getBoundingClientRect();
    const range = document.createRange();
    const pos = findDomPosition(block, anchor.char_offset);
    if (pos) {
      const content = pos.node.textContent || '';
      const end = Math.min(content.length, pos.offset + 1);
      range.setStart(pos.node, pos.offset);
      range.setEnd(pos.node, end);
    } else range.selectNode(block);
    const rect = range.getBoundingClientRect();
    if (mode === 'paginated') {
      const column = Math.floor(
        (viewport.scrollLeft + rect.left - box.left + 1) / viewport.clientWidth,
      );
      viewport.scrollLeft = Math.max(0, column * viewport.clientWidth);
    } else {
      viewport.scrollTop += rect.top - box.top;
    }
    restoredViewport.current = {
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
      width: viewport.clientWidth,
      height: viewport.clientHeight,
    };
    visible.current = anchor;
    pending.current = null;
  }

  useLayoutEffect(() => {
    if (loadedSpine !== spine || !scroll.current) return;
    restore(
      pending.current ||
        (visible.current.spine_index === spine
          ? visible.current
          : { spine_index: spine, block_index: 0, char_offset: 0 }),
    );
    // restore runs after the reader reflows around the current anchor.
  }, [loadedSpine, spine, mode, font, size, lineHeight]);

  useEffect(() => {
    const viewport = scroll.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      const layout = restoredViewport.current;
      if (
        loadedSpine === spine &&
        (viewport.clientWidth !== layout?.width || viewport.clientHeight !== layout?.height)
      ) {
        restore(pending.current || visible.current);
      }
    });
    observer.observe(viewport);
    return () => observer.disconnect();
    // The active reading mode determines the scroll axis on resize.
  }, [mode, spine, loadedSpine]);

  function syncAnchor() {
    const viewport = scroll.current;
    if (!viewport || loadedSpine !== spine) return;
    const restored = restoredViewport.current;
    if (
      restored &&
      (viewport.clientWidth !== restored.width ||
        viewport.clientHeight !== restored.height ||
        (viewport.scrollLeft === restored.left && viewport.scrollTop === restored.top))
    )
      return;
    if (restored) {
      restored.left = Number.NaN;
      restored.top = Number.NaN;
    }
    const atBottom =
      mode === 'scroll' &&
      spine === chapters.length - 1 &&
      blocks.length > 0 &&
      viewport.scrollHeight > viewport.clientHeight + 4 &&
      viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 4;
    if (atBottom && !completedSent.current) {
      completedSent.current = true;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = 0;
      const lastBlock = blocks.at(-1)!;
      checkpoint.save(
        {
          spine_index: spine,
          block_index: lastBlock.block_index,
          char_offset: codePointLength(lastBlock.text),
          reading_mode: mode,
        },
        true,
      );
      return;
    }
    const box = viewport.getBoundingClientRect();
    const range = document.createRange();
    for (const block of viewport.querySelectorAll<HTMLElement>('[data-block]')) {
      range.selectNodeContents(block);
      const boxes = block.querySelector('img') ? block.getClientRects() : range.getClientRects();
      const fragment = [...boxes].find(
        (rect) =>
          rect.bottom > box.top &&
          rect.top < box.bottom &&
          rect.right > box.left &&
          rect.left < box.right,
      );
      if (!fragment) continue;
      let charOffset = 0;
      if (!block.querySelector('img')) {
        const top = Math.max(fragment.top, box.top);
        const bottom = Math.min(fragment.bottom, box.bottom);
        const caret = document.caretRangeFromPoint(
          Math.max(fragment.left, box.left) + 1,
          (top + bottom) / 2,
        );
        if (caret && block.contains(caret.startContainer)) {
          charOffset = codePointOffsetInBlock(block, caret.startContainer, caret.startOffset);
        }
      }
      visible.current = {
        spine_index: spine,
        block_index: Number(block.dataset.block),
        char_offset: charOffset,
      };
      window.clearTimeout(saveTimer.current);
      saveAnchor.current = () => checkpoint.save({ ...visible.current, reading_mode: mode });
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = 0;
        saveAnchor.current();
      }, 550);
      break;
    }
  }

  useEffect(
    () => () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        saveAnchor.current();
      }
    },
    [],
  );

  function selectMode(next: Mode) {
    if (mode === next) return;
    setMode(next);
    if (spine !== loadedSpine || !blocks.length) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = 0;
    checkpoint.save({ ...visible.current, reading_mode: next });
  }

  function page(direction: number) {
    const viewport = scroll.current;
    if (mode === 'paginated' && viewport) {
      const proposed = viewport.scrollLeft + direction * viewport.clientWidth;
      if (proposed >= 0 && proposed < viewport.scrollWidth - 1) {
        viewport.scrollLeft = proposed;
        return;
      }
    }
    const next = spine + direction;
    if (next >= 0 && next < chapters.length)
      jump({ spine_index: next, block_index: 0, char_offset: 0 });
    else if (direction > 0 && blocks.length) {
      completedSent.current = true;
      checkpoint.save(
        {
          spine_index: spine,
          block_index: blocks.length - 1,
          char_offset: codePointLength(blocks.at(-1)!.text),
          reading_mode: mode,
        },
        true,
      );
    }
  }

  function selectText() {
    const viewport = scroll.current;
    const value = window.getSelection();
    if (!viewport || !value?.rangeCount || value.isCollapsed) {
      setSelection(null);
      return;
    }
    const range = value.getRangeAt(0);
    const first = resolveBlockFromBoundary(
      range.startContainer,
      range.startOffset,
      viewport,
      'start',
    );
    let last = resolveBlockFromBoundary(range.endContainer, range.endOffset, viewport, 'end');
    if (!first || !last) return;
    const startBlockIndex = Number(first.dataset.block);
    const startCharOffset =
      range.startContainer === viewport || !first.contains(range.startContainer)
        ? 0
        : codePointOffsetInBlock(first, range.startContainer, range.startOffset);
    let endBlockIndex = Number(last.dataset.block);
    let endCharOffset =
      range.endContainer === viewport || !last.contains(range.endContainer)
        ? codePointLength(last.textContent || '')
        : codePointOffsetInBlock(last, range.endContainer, range.endOffset);
    if (endBlockIndex > startBlockIndex && endCharOffset === 0) {
      // Triple-click often lands at offset 0 of the next block; snap to end of the previous block.
      const prevBlock = first;
      if (
        last.previousElementSibling instanceof HTMLElement &&
        last.previousElementSibling.dataset.block
      ) {
        last = last.previousElementSibling;
      } else {
        last = prevBlock;
      }
      endBlockIndex = Number(last.dataset.block);
      endCharOffset = codePointLength(last.textContent || '');
    }
    const selectedText = value.toString().trim();
    if (!selectedText || (startBlockIndex === endBlockIndex && endCharOffset <= startCharOffset)) {
      setSelection(null);
      return;
    }
    setSelection({
      spine_index: spine,
      start_block_index: startBlockIndex,
      start_char_offset: startCharOffset,
      end_block_index: endBlockIndex,
      end_char_offset: endCharOffset,
      selected_text: value.toString(),
    });
  }

  async function addMark() {
    try {
      const saved = await api<Bookmark>(prefix + '/bookmarks', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'ebook',
          ...visible.current,
          excerpt: blocks
            .find((block) => block.block_index === visible.current.block_index)
            ?.text.slice(0, 100),
        }),
      });
      setMarks((items) => [...items, saved]);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function removeMark(id: string) {
    try {
      await api(prefix + `/bookmarks/${id}`, { method: 'DELETE' });
      setMarks((items) => items.filter((item) => item.id !== id));
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function annotate(color: Color) {
    if (!selection) return;
    try {
      const saved = await api<Annotation>(prefix + '/annotations', {
        method: 'POST',
        body: JSON.stringify({ ...selection, color }),
      });
      setAnnotations((items) => [...items, saved]);
      setSelection(null);
      window.getSelection()?.removeAllRanges();
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function removeAnnotation(id: string) {
    try {
      await api(prefix + `/annotations/${id}`, { method: 'DELETE' });
      setAnnotations((items) => items.filter((item) => item.id !== id));
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  const spineAnnotations = annotations.filter((ann) => ann.spine_index === spine);

  return (
    <section className={`book-reader ${dark ? 'book-reader-dark' : ''}`}>
      <div className="bookshelf-controls" aria-label={t('bookshelf.read')}>
        <button aria-pressed={mode === 'scroll'} onClick={() => selectMode('scroll')}>
          {t('bookshelf.scroll')}
        </button>
        <button aria-pressed={mode === 'paginated'} onClick={() => selectMode('paginated')}>
          {t('bookshelf.pages')}
        </button>
        <button aria-pressed={dark} onClick={() => setDark(!dark)}>
          {t('bookshelf.dark')}
        </button>
        <select
          aria-label={t('bookshelf.font')}
          value={font}
          onChange={(event) => setFont(event.target.value)}
        >
          <option value="serif">{t('bookshelf.serif')}</option>
          <option value="sans-serif">{t('bookshelf.sans')}</option>
        </select>
        <label className="bookshelf-range">
          <span>{t('bookshelf.fontSize')}</span>
          <input
            aria-label={t('bookshelf.fontSize')}
            type="range"
            value={size}
            min={14}
            max={24}
            onChange={(event) => setSize(Number(event.target.value))}
          />
          <output className="tnum">{size}px</output>
        </label>
        <label className="bookshelf-range">
          <span>{t('bookshelf.lineHeight')}</span>
          <input
            aria-label={t('bookshelf.lineHeight')}
            type="range"
            value={lineHeight}
            min={1.2}
            max={2.2}
            step={0.1}
            onChange={(event) => setLineHeight(Number(event.target.value))}
          />
          <output className="tnum">{lineHeight.toFixed(1)}</output>
        </label>
      </div>
      <div className="bookshelf-controls">
        <select
          aria-label={t('bookshelf.contents')}
          value={spine}
          onChange={(event) =>
            jump({
              spine_index: Number(event.target.value),
              block_index: 0,
              char_offset: 0,
            })
          }
        >
          {chapters.map((chapter) => (
            <option key={chapter.spine_index} value={chapter.spine_index}>
              {chapter.title}
            </option>
          ))}
        </select>
        <button onClick={() => void addMark()}>{t('bookshelf.bookmark')}</button>
        <form
          className="bookshelf-controls"
          onSubmit={(event) => {
            event.preventDefault();
            void api<{ items: Match[] }>(prefix + `/ebook/search?q=${encodeURIComponent(query)}`)
              .then((value) => setMatches(value.items))
              .catch((cause: Error) => setError(cause.message));
          }}
        >
          <input
            aria-label={t('bookshelf.searchText')}
            placeholder={t('bookshelf.searchText')}
            value={query}
            required
            onChange={(event) => setQuery(event.target.value)}
          />
          <button>{t('bookshelf.search')}</button>
        </form>
      </div>
      {(error || checkpoint.error) && <p role="alert">{error || checkpoint.error}</p>}
      {selection && (
        <div className="bookshelf-controls" role="toolbar" aria-label={t('bookshelf.annotations')}>
          {colors.map((color) => (
            <button key={color} data-color={color} onClick={() => void annotate(color)}>
              {t(`bookshelf.colors.${color}`)}
            </button>
          ))}
        </div>
      )}
      {!!marks.length && (
        <details>
          <summary>
            <span>{t('bookshelf.bookmarks')}</span>{' '}
            <span className="muted tnum">({marks.length})</span>
          </summary>
          <ul className="bookshelf-note-list">
            {marks.map((mark) => (
              <li key={mark.id}>
                <button onClick={() => jump(mark)}>
                  {mark.excerpt || t('bookshelf.bookmark')}
                </button>
                <button
                  type="button"
                  className="bookshelf-note-delete"
                  aria-label={`${t('bookshelf.delete')} ${mark.excerpt || t('bookshelf.bookmark')}`}
                  onClick={() => void removeMark(mark.id)}
                >
                  {t('bookshelf.delete')}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {!!annotations.length && (
        <details>
          <summary>
            <span>{t('bookshelf.annotations')}</span>{' '}
            <span className="muted tnum">({annotations.length})</span>
          </summary>
          <ul className="bookshelf-note-list">
            {annotations.map((annotation) => (
              <li key={annotation.id}>
                <button
                  data-color={annotation.color}
                  onClick={() =>
                    jump({
                      spine_index: annotation.spine_index,
                      block_index: annotation.start_block_index,
                      char_offset: annotation.start_char_offset,
                    })
                  }
                >
                  {annotation.selected_text}
                </button>
                <button
                  type="button"
                  className="bookshelf-note-delete"
                  aria-label={`${t('bookshelf.delete')} ${annotation.selected_text}`}
                  onClick={() => void removeAnnotation(annotation.id)}
                >
                  {t('bookshelf.delete')}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {!!matches.length && (
        <ul className="bookshelf-note-list">
          {matches.map((match, index) => (
            <li key={index}>
              <button onClick={() => jump(match)}>{match.excerpt}</button>
            </li>
          ))}
        </ul>
      )}
      <div
        ref={scroll}
        className={`book-reader-viewport book-reader-${mode}`}
        onScroll={syncAnchor}
        onPointerUp={selectText}
        onKeyUp={selectText}
        tabIndex={0}
        aria-label={book.title}
      >
        {loadedSpine !== spine && !error ? (
          <p role="status">{t('bookshelf.loading')}</p>
        ) : (
          <article
            className="book-reader-document"
            style={{ fontFamily: font, fontSize: size, lineHeight }}
          >
            {blocks.map((block) => {
              if (block.image_key) {
                return (
                  <img
                    key={block.block_index}
                    data-block={block.block_index}
                    alt=""
                    onLoad={() => {
                      if (loadedSpine === spine) restore(visible.current);
                    }}
                    src={`/api/v1${prefix}/ebook/assets/${block.image_key}`}
                  />
                );
              }
              const children = renderBlockContent(block, spineAnnotations);
              if (/^h[1-6]$/.test(block.tag)) {
                return (
                  <h2 key={block.block_index} data-block={block.block_index}>
                    {children}
                  </h2>
                );
              }
              if (block.tag === 'blockquote') {
                return (
                  <blockquote key={block.block_index} data-block={block.block_index}>
                    {children}
                  </blockquote>
                );
              }
              if (block.tag === 'li') {
                return (
                  <p
                    key={block.block_index}
                    data-block={block.block_index}
                    className="book-list-item"
                  >
                    {children}
                  </p>
                );
              }
              return (
                <p key={block.block_index} data-block={block.block_index}>
                  {children}
                </p>
              );
            })}
          </article>
        )}
      </div>
      <div className="bookshelf-controls">
        <button onClick={() => page(-1)}>{t('bookshelf.previous')}</button>
        <button onClick={() => page(1)}>{t('bookshelf.next')}</button>
        {!!chapters.length && (
          <span className="muted tnum">
            {t('bookshelf.chapterProgress', { current: spine + 1, total: chapters.length })}
          </span>
        )}
      </div>
    </section>
  );
}

export interface AudioChapter {
  chapter_index: number;
  file_index: number;
  title: string;
  duration_ms: number;
  start_file_ms: number;
  end_file_ms: number;
}

export interface BookAudioSession {
  book: Book | null;
  chapters: AudioChapter[] | null;
  current: AudioChapter | undefined;
  index: number;
  rate: number;
  timer: number;
  playing: boolean;
  positionMs: number;
  error: string;
  audio: RefObject<HTMLAudioElement | null>;
  open: (nextBook: Book, autoplayNow?: boolean) => void;
  close: () => void;
  choose: (next: number, play?: boolean) => void;
  seekBy: (seconds: number) => void;
  seekToChapterMs: (chapterMs: number) => void;
  togglePlay: () => void;
  setRate: (rate: number) => void;
  setTimer: (minutes: number) => void;
  renameChapter: (chapterIndex: number, title: string) => void;
  bindHandlers: {
    onLoadedMetadata: () => void;
    onPlay: () => void;
    onPause: () => void;
    onSeeked: () => void;
    onEnded: () => void;
    onTimeUpdate: () => void;
  };
}

export function useBookAudioSession({
  activeElsewhere,
  onPlay,
  userId,
}: {
  activeElsewhere: boolean;
  onPlay: () => void;
  userId: string;
}): BookAudioSession {
  const audio = useRef<HTMLAudioElement>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [chapters, setChapters] = useState<AudioChapter[] | null>(null);
  const [index, setIndex] = useState(0);
  const [rate, setRate] = useState(1);
  const [timer, setTimer] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [error, setError] = useState('');
  const restore = useRef(0);
  const touched = useRef(false);
  const autoplay = useRef(false);
  const lastSavedAt = useRef(0);
  const current = chapters?.[index];
  const prefix = book ? `/books/${book.id}` : '';

  const checkpoint = useCheckpoint<Listening>(
    prefix ? `${prefix}/listening-progress` : '',
    (value) => {
      if (value.version && !touched.current) {
        restore.current = value.chapter_position_ms;
        setIndex(value.chapter_index);
        setRate(value.playback_rate);
      }
    },
    book?.progress_status === 'finished' ? 'restart' : 'resume',
  );

  useEffect(() => {
    audio.current?.pause();
    setPlaying(false);
    setTimer(0);
    setBook(null);
    setChapters(null);
  }, [userId]);

  useEffect(() => {
    setChapters(null);
    setIndex(0);
    setPositionMs(0);
    setError('');
    setPlaying(false);
    restore.current = 0;
    touched.current = false;
    if (!prefix) return;
    const request = new AbortController();
    void api<{ chapters: AudioChapter[] }>(prefix + '/audiobook', { signal: request.signal })
      .then((value) => setChapters(value.chapters))
      .catch((cause: Error) => {
        if (!request.signal.aborted) setError(cause.message);
      });
    return () => request.abort();
  }, [prefix]);

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    if (activeElsewhere && audio.current && !audio.current.paused) {
      audio.current.pause();
    }
  }, [activeElsewhere]);

  useEffect(() => {
    if (!timer) return;
    const timeout = window.setTimeout(() => {
      audio.current?.pause();
      setTimer(0);
    }, timer * 60_000);
    return () => window.clearTimeout(timeout);
  }, [timer]);

  const save = useCallback(
    (completed = false) => {
      if (!current || !audio.current || !touched.current) return;
      checkpoint.save(
        {
          chapter_index: index,
          chapter_position_ms: Math.max(
            0,
            Math.round(audio.current.currentTime * 1000 - current.start_file_ms),
          ),
          playback_rate: rate,
        },
        completed,
      );
    },
    [checkpoint, current, index, rate],
  );

  const open = useCallback(
    (nextBook: Book, autoplayNow = false) => {
      if (book?.id === nextBook.id) {
        if (autoplayNow && audio.current?.paused) {
          onPlay();
          void audio.current.play().catch((cause: Error) => setError(cause.message));
        }
        return;
      }
      save();
      audio.current?.pause();
      setPlaying(false);
      autoplay.current = autoplayNow;
      setBook(nextBook);
    },
    [book?.id, onPlay, save],
  );

  const close = useCallback(() => {
    save();
    audio.current?.pause();
    setPlaying(false);
    setTimer(0);
    setBook(null);
    setChapters(null);
  }, [save]);

  const choose = useCallback(
    (next: number, play = false) => {
      if (!chapters?.[next]) return;
      save();
      restore.current = 0;
      touched.current = true;
      autoplay.current = play;
      if (audio.current && chapters[next].file_index === current?.file_index) {
        audio.current.currentTime = chapters[next].start_file_ms / 1000;
        setPositionMs(0);
        if (play) {
          autoplay.current = false;
          onPlay();
          void audio.current.play().catch((cause: Error) => setError(cause.message));
        }
      }
      setIndex(next);
    },
    [chapters, current?.file_index, onPlay, save],
  );

  const seekBy = useCallback(
    (seconds: number) => {
      if (!audio.current || !current) return;
      const target = Math.max(
        current.start_file_ms / 1000,
        Math.min(current.end_file_ms / 1000, audio.current.currentTime + seconds),
      );
      audio.current.currentTime = target;
      setPositionMs(Math.max(0, Math.round(target * 1000 - current.start_file_ms)));
    },
    [current],
  );

  const seekToChapterMs = useCallback(
    (chapterMs: number) => {
      if (!audio.current || !current) return;
      const clamped = Math.max(0, Math.min(current.duration_ms, chapterMs));
      audio.current.currentTime = (current.start_file_ms + clamped) / 1000;
      setPositionMs(clamped);
    },
    [current],
  );

  const togglePlay = useCallback(() => {
    if (!audio.current) return;
    if (audio.current.paused) {
      touched.current = true;
      onPlay();
      void audio.current.play().catch((cause: Error) => setError(cause.message));
    } else {
      audio.current.pause();
    }
  }, [onPlay]);

  const renameChapter = useCallback((chapterIndex: number, title: string) => {
    setChapters(
      (items) =>
        items?.map((item) => (item.chapter_index === chapterIndex ? { ...item, title } : item)) ??
        null,
    );
  }, []);

  return {
    book,
    chapters,
    current,
    index,
    rate,
    timer,
    playing,
    positionMs,
    error: error || checkpoint.error,
    audio,
    open,
    close,
    choose,
    seekBy,
    seekToChapterMs,
    togglePlay,
    setRate,
    setTimer,
    renameChapter,
    bindHandlers: {
      onLoadedMetadata: () => {
        if (!audio.current || !current) return;
        const targetMs = current.start_file_ms + restore.current;
        audio.current.currentTime = targetMs / 1000;
        audio.current.playbackRate = rate;
        setPositionMs(restore.current);
        restore.current = 0;
        if (autoplay.current) {
          autoplay.current = false;
          onPlay();
          void audio.current.play().catch((cause: Error) => setError(cause.message));
        }
      },
      onPlay: () => {
        touched.current = true;
        setPlaying(true);
        onPlay();
      },
      onPause: () => {
        setPlaying(false);
        save();
      },
      onSeeked: () => save(),
      onEnded: () => {
        if (chapters?.[index + 1]) choose(index + 1, true);
        else {
          setPlaying(false);
          save(true);
        }
      },
      onTimeUpdate: () => {
        if (!audio.current || !current) return;
        const ms = Math.max(
          0,
          Math.round(audio.current.currentTime * 1000 - current.start_file_ms),
        );
        setPositionMs(ms);
        if (
          audio.current.currentTime * 1000 >= current.end_file_ms &&
          chapters?.[index + 1]?.file_index === current.file_index
        ) {
          choose(index + 1, true);
        } else if (Date.now() - lastSavedAt.current > 10_000) {
          lastSavedAt.current = Date.now();
          save();
        }
      },
    },
  };
}

export function BookAudioHost({
  session,
  showDock,
  onOpenBook,
}: {
  session: BookAudioSession;
  showDock: boolean;
  onOpenBook: (book: Book) => void;
}) {
  const { t } = useTranslation();
  if (!session.book) return null;
  const src = session.current
    ? `/api/v1/books/${session.book.id}/audiobook/files/${session.current.file_index}/stream`
    : undefined;
  return (
    <>
      <audio
        ref={session.audio}
        preload="metadata"
        src={src}
        onLoadedMetadata={session.bindHandlers.onLoadedMetadata}
        onPlay={session.bindHandlers.onPlay}
        onPause={session.bindHandlers.onPause}
        onSeeked={session.bindHandlers.onSeeked}
        onEnded={session.bindHandlers.onEnded}
        onTimeUpdate={session.bindHandlers.onTimeUpdate}
      />
      {showDock && session.current && (
        <aside className="book-audio-dock" aria-label={session.book.title}>
          <button
            type="button"
            className="text-button book-audio-dock-title"
            onClick={() => session.book && onOpenBook(session.book)}
          >
            <strong>{session.book.title}</strong>
            <span> · {session.current.title}</span>
          </button>
          <span className="muted tnum">
            {time(session.positionMs / 1000)} / {time(session.current.duration_ms / 1000)}
          </span>
          <div className="bookshelf-controls">
            <button type="button" onClick={() => session.seekBy(-15)}>
              -15s
            </button>
            <button type="button" className="primary" onClick={session.togglePlay}>
              {t(session.playing ? 'bookshelf.pause' : 'bookshelf.play')}
            </button>
            <button type="button" onClick={() => session.seekBy(30)}>
              +30s
            </button>
            <button type="button" aria-label={t('bookshelf.back')} onClick={session.close}>
              ×
            </button>
          </div>
        </aside>
      )}
    </>
  );
}

export function BookAudio({
  book,
  session,
  canEdit,
}: {
  book: Book;
  session: BookAudioSession;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const [editError, setEditError] = useState('');

  useEffect(() => {
    if (session.book?.id !== book.id) {
      session.open(book);
    }
  }, [book, session]);

  const current = session.book?.id === book.id ? session.current : undefined;
  const chapters = session.book?.id === book.id ? session.chapters : null;
  if (!current) {
    return (
      <p role={session.error ? 'alert' : 'status'}>{session.error || t('bookshelf.loading')}</p>
    );
  }
  return (
    <section className="book-audio">
      <div className="bookshelf-controls">
        <select
          aria-label={t('bookshelf.contents')}
          value={session.index}
          onChange={(event) => session.choose(Number(event.target.value), session.playing)}
        >
          {chapters?.map((chapter) => (
            <option key={chapter.chapter_index} value={chapter.chapter_index}>
              {chapter.title} · {time(chapter.duration_ms / 1000)}
            </option>
          ))}
        </select>
        <select
          aria-label={t('bookshelf.speed')}
          value={session.rate}
          onChange={(event) => session.setRate(Number(event.target.value))}
        >
          {[0.75, 1, 1.25, 1.5, 1.75, 2, 2.5].map((value) => (
            <option key={value} value={value}>
              {value}×
            </option>
          ))}
        </select>
        <select
          aria-label={t('bookshelf.sleep')}
          value={session.timer}
          onChange={(event) => session.setTimer(Number(event.target.value))}
        >
          <option value={0}>{t('bookshelf.sleep')}</option>
          {[15, 30, 45, 60].map((minutes) => (
            <option key={minutes} value={minutes}>
              {t('bookshelf.minutes', { minutes })}
            </option>
          ))}
        </select>
      </div>
      <div className="bookshelf-controls">
        <button type="button" className="primary" onClick={session.togglePlay}>
          {t(session.playing ? 'bookshelf.pause' : 'bookshelf.play')}
        </button>
        <button type="button" onClick={() => session.seekBy(-15)}>
          -15s
        </button>
        <button type="button" onClick={() => session.seekBy(30)}>
          +30s
        </button>
        <input
          type="range"
          className="book-audio-scrubber"
          aria-label={current.title}
          min={0}
          max={Math.max(1, current.duration_ms)}
          value={Math.min(current.duration_ms, session.positionMs)}
          onChange={(event) => session.seekToChapterMs(Number(event.target.value))}
        />
        <span className="muted tnum">
          {time(session.positionMs / 1000)} / {time(current.duration_ms / 1000)}
        </span>
      </div>
      {canEdit && (
        <details>
          <summary>{t('bookshelf.editChapter')}</summary>
          <form
            key={session.index}
            className="bookshelf-controls"
            onSubmit={(event) => {
              event.preventDefault();
              const title = String(new FormData(event.currentTarget).get('title') || '').trim();
              if (!title) return;
              void api<Pick<AudioChapter, 'chapter_index' | 'title'>>(
                `/books/${book.id}/audiobook/chapters/${session.index}`,
                { method: 'PATCH', body: JSON.stringify({ title }) },
              )
                .then((edited) => {
                  session.renameChapter(edited.chapter_index, edited.title);
                  setEditError('');
                })
                .catch((cause: Error) => setEditError(cause.message));
            }}
          >
            <input
              name="title"
              aria-label={t('bookshelf.chapterTitle')}
              required
              maxLength={4096}
              defaultValue={current.title}
            />
            <button>{t('bookshelf.save')}</button>
          </form>
        </details>
      )}
      {(session.error || editError) && <p role="alert">{editError || session.error}</p>}
    </section>
  );
}
