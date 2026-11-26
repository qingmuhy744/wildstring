import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, time } from './api';
import { Icon } from './icons';

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
  resume_kind?: 'reading' | 'listening' | null;
  reading_progress?: (CarrierProgress & { spine_index: number }) | null;
  listening_progress?:
    | (CarrierProgress &
        Listening & {
          book_position_ms: number;
          total_duration_ms: number;
        })
    | null;
}

interface CarrierProgress {
  chapter_title: string | null;
  overall_ratio: number;
  completed: boolean;
  updated_at: number;
}

function chapterKey(title: string | null) {
  return (
    title
      ?.normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/[\s\p{P}]+/gu, '') || ''
  );
}

export function matchingChapter<T extends { title: string }>(
  chapters: T[],
  sourceTitle: string | null,
  sourceIndex: number,
) {
  const title = chapterKey(sourceTitle);
  return (
    (title ? chapters.find((chapter) => chapterKey(chapter.title) === title) : null) ??
    chapters[sourceIndex]
  );
}

export function alignmentAvailable(
  other: CarrierProgress | null | undefined,
  own: CarrierProgress | null | undefined,
) {
  if (!other) return false;
  return (
    !own ||
    (other.updated_at > own.updated_at &&
      (Math.abs(other.overall_ratio - own.overall_ratio) >= 0.03 ||
        chapterKey(other.chapter_title) !== chapterKey(own.chapter_title)))
  );
}

export function BookAlignmentNotice({
  source,
  progress,
  onAlign,
  onDismiss,
  disabled,
}: {
  source: 'reading' | 'listening';
  progress: CarrierProgress;
  onAlign: () => void;
  onDismiss: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="book-align-notice">
      <span>
        {t(source === 'reading' ? 'bookshelf.alignReading' : 'bookshelf.alignListening', {
          chapter: progress.chapter_title || t('bookshelf.title'),
          percent: Math.round(progress.overall_ratio * 100),
        })}
      </span>
      <div className="book-align-actions">
        <button type="button" onClick={onAlign} disabled={disabled}>
          {t('bookshelf.alignJump')}
        </button>
        <button type="button" onClick={onDismiss}>
          {t('bookshelf.alignIgnore')}
        </button>
      </div>
    </div>
  );
}

type Mode = 'scroll' | 'paginated';
type ReaderPanel = 'contents' | 'notes' | 'search' | 'appearance';
type CustomColor = `#${string}`;
export type Color = 'amber' | 'terracotta' | 'sage' | 'stone' | CustomColor;
const colors = ['amber', 'terracotta', 'sage', 'stone'] as const;
const CUSTOM_COLOR_KEY = 'wildstring:reader:custom-highlight';

function isCustomColor(value: string): value is CustomColor {
  return /^#[0-9a-f]{6}$/.test(value);
}
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
export interface EbookChapter {
  spine_index: number;
  title: string;
  char_count: number;
  start_global_char: number;
}
interface Bookmark extends Anchor {
  id: string;
  kind: 'ebook' | 'audio';
  excerpt?: string;
}
interface SelectionRange {
  spine_index: number;
  start_block_index: number;
  start_char_offset: number;
  end_block_index: number;
  end_char_offset: number;
  selected_text: string;
}
interface PopoverAnchor {
  x: number;
  y: number;
  placement: 'above' | 'below';
}
interface Annotation extends SelectionRange {
  id: string;
  color: Color;
  note?: string | null;
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
  revision = 0,
  onCommit?: () => void,
) {
  const [error, setError] = useState<{
    kind: 'load' | 'save' | 'conflict';
    message: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retryIntent = useRef(initialIntent);
  const requestKey = path ? `${path}|${initialIntent}|${attempt}|${revision}` : '';
  const [settledKey, setSettledKey] = useState('');
  const load = useRef(onLoad);
  load.current = onLoad;
  const commit = useRef(onCommit);
  commit.current = onCommit;
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
    const active = {
      id: key(),
      version: 0,
      sequence: 0,
      ready: false,
      blocked: false,
      intent: attempt ? retryIntent.current : initialIntent,
    };
    session.current = active;
    setError(null);
    if (!path) {
      setSettledKey('');
      return;
    }
    const controller = new AbortController();
    void api<T & Checkpoint>(path, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        active.version = value.version;
        active.ready = true;
        load.current(value);
        setSettledKey(requestKey);
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) {
          setError({ kind: 'load', message: cause.message });
          setSettledKey(requestKey);
        }
      });
    return () => controller.abort();
  }, [path, initialIntent, requestKey, attempt]);
  const save = useCallback(
    (fields: T, completed = false, onSaved?: () => void) => {
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
          commit.current?.();
          if (session.current === current) {
            setError((previous) => (previous?.kind === 'save' ? null : previous));
            onSaved?.();
          }
        } catch (cause) {
          const conflict = cause instanceof ApiError && cause.status === 409;
          if (conflict) current.blocked = true;
          if (session.current === current) {
            setError({ kind: conflict ? 'conflict' : 'save', message: (cause as Error).message });
          }
        }
      });
    },
    [path],
  );
  return {
    save,
    error,
    ready: !path || settledKey === requestKey,
    started: () => session.current.version > 0 || session.current.sequence > 0,
    retry: () => {
      retryIntent.current = session.current.blocked ? 'resume' : session.current.intent;
      setAttempt((value) => value + 1);
    },
  };
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
        <mark
          key={idx}
          data-color={seg.annotation.color}
          data-annotation-id={seg.annotation.id}
          style={
            isCustomColor(seg.annotation.color)
              ? ({ '--annotation-color': seg.annotation.color } as CSSProperties)
              : undefined
          }
        >
          {node}
        </mark>
      );
      return node;
    }
    return <span key={idx}>{node}</span>;
  });
}

export function BookReader({
  book,
  initialSpine = null,
  onClose,
  onProgressSaved,
  listening = false,
  onToggleListen,
  audioSession,
}: {
  book: Book;
  initialSpine?: number | null;
  onClose?: () => void;
  onProgressSaved?: () => void;
  listening?: boolean;
  onToggleListen?: () => void;
  audioSession?: BookAudioSession;
  canEdit?: boolean;
}) {
  const { t } = useTranslation();
  const prefix = `/books/${book.id}`;
  const [chapters, setChapters] = useState<EbookChapter[]>([]);
  const [totalChars, setTotalChars] = useState(0);
  const [alignmentDismissed, dismissAlignment] = useState(false);
  const alignmentRequest = useRef<AbortController | null>(null);
  const [manifestFailed, setManifestFailed] = useState(false);
  const [manifestAttempt, setManifestAttempt] = useState(0);
  const [spine, setSpine] = useState(initialSpine ?? 0);
  const initialJump = useRef<number | null>(initialSpine);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [loadedSpine, setLoadedSpine] = useState(-1);
  const [failedSpine, setFailedSpine] = useState<number | null>(null);
  const [chapterAttempt, setChapterAttempt] = useState(0);
  const [mode, setMode] = useState<Mode>('scroll');
  const [dark, setDark] = useState(false);
  const [font, setFont] = useState('serif');
  const [size, setSize] = useState(18);
  const [lineHeight, setLineHeight] = useState(1.7);
  const [error, setError] = useState('');
  const [marks, setMarks] = useState<Bookmark[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [searchedQuery, setSearchedQuery] = useState<string | null>(null);
  const [selection, setSelection] = useState<{
    range: SelectionRange;
    anchor: PopoverAnchor;
  } | null>(null);
  const [draftNoteMode, setDraftNoteMode] = useState(false);
  const [draftColor, setDraftColor] = useState<Color>('amber');
  const [customColor, setCustomColor] = useState<CustomColor>(() => {
    const stored = localStorage.getItem(CUSTOM_COLOR_KEY) || '';
    return isCustomColor(stored) ? stored : '#b6845c';
  });
  const [draftNote, setDraftNote] = useState('');
  const [activeMark, setActiveMark] = useState<{
    annotation: Annotation;
    anchor: PopoverAnchor;
  } | null>(null);
  const [editingAnnId, setEditingAnnId] = useState<string | null>(null);
  const [editingAnnColor, setEditingAnnColor] = useState<Color>('amber');
  const [editingAnnNote, setEditingAnnNote] = useState('');
  const [query, setQuery] = useState('');
  const [panel, setPanel] = useState<ReaderPanel | null>(null);
  const panelTrigger = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
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
  const saveInitialView = useRef<() => void>(() => {});
  const completedSent = useRef(false);

  function customColorPicker(selected: Color, onChange: (color: Color) => void) {
    return (
      <input
        className="book-color-custom"
        type="color"
        data-selected={isCustomColor(selected) ? 'true' : undefined}
        aria-label={t('bookshelf.customColor')}
        title={t('bookshelf.customColor')}
        value={isCustomColor(selected) ? selected : customColor}
        onChange={(event) => {
          const color = event.currentTarget.value;
          if (!isCustomColor(color)) return;
          setCustomColor(color);
          localStorage.setItem(CUSTOM_COLOR_KEY, color);
          onChange(color);
        }}
      />
    );
  }

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
      window.clearTimeout(saveTimer.current);
      saveTimer.current = 0;
      completedSent.current = false;
      if (value.version) setMode(value.reading_mode);
      if (initialJump.current !== null) {
        const target = initialJump.current;
        initialJump.current = null;
        const anchor = { spine_index: target, block_index: 0, char_offset: 0 };
        pending.current = anchor;
        setSpine(target);
        checkpoint.save({ ...anchor, reading_mode: value.version ? value.reading_mode : mode });
        return;
      }
      if (value.version) {
        jump(value, false);
      }
    },
    book.reading_progress?.completed ? 'restart' : 'resume',
    0,
    onProgressSaved,
  );
  saveInitialView.current = () => {
    if (loadedSpine === spine && blocks.length && checkpoint.ready && !checkpoint.started()) {
      checkpoint.save({ ...visible.current, reading_mode: mode });
    }
  };

  useEffect(() => () => alignmentRequest.current?.abort(), []);

  useEffect(() => {
    setManifestFailed(false);
    const request = new AbortController();
    void api<{ chapters: EbookChapter[]; total_chars: number }>(prefix + '/ebook/manifest', {
      signal: request.signal,
    })
      .then((value) => {
        if (request.signal.aborted) return;
        setChapters(value.chapters);
        setTotalChars(value.total_chars);
      })
      .catch(() => {
        if (!request.signal.aborted) setManifestFailed(true);
      });
    return () => request.abort();
  }, [prefix, manifestAttempt]);

  useEffect(() => {
    const request = new AbortController();
    const load = <T,>(path: string) => api<T>(prefix + path, { signal: request.signal });
    void Promise.all([
      load<{ items: Bookmark[] }>('/bookmarks'),
      load<{ items: Annotation[] }>('/annotations'),
    ])
      .then(([savedMarks, savedAnnotations]) => {
        if (request.signal.aborted) return;
        setMarks(savedMarks.items.filter((mark) => mark.kind === 'ebook'));
        setAnnotations(savedAnnotations.items);
      })
      .catch((cause: Error) => {
        if (!request.signal.aborted) setError(cause.message);
      });
    return () => request.abort();
  }, [prefix]);

  useEffect(() => {
    setSelection(null);
    setDraftNoteMode(false);
    setActiveMark(null);
    setFailedSpine(null);
    const request = new AbortController();
    void api<{ blocks: Block[] }>(prefix + `/ebook/chapters/${spine}`, { signal: request.signal })
      .then((data) => {
        if (request.signal.aborted) return;
        setBlocks(data.blocks);
        setLoadedSpine(spine);
      })
      .catch(() => {
        if (!request.signal.aborted) setFailedSpine(spine);
      });
    return () => request.abort();
  }, [prefix, spine, chapterAttempt]);

  async function alignReading(progress: NonNullable<Book['listening_progress']>) {
    const match = matchingChapter(chapters, progress.chapter_title, progress.chapter_index);
    const target = Math.floor(progress.overall_ratio * totalChars);
    const chapter =
      match ??
      chapters.find((_, index) => (chapters[index + 1]?.start_global_char ?? Infinity) > target);
    if (!chapter) return;
    const anchor = { spine_index: chapter.spine_index, block_index: 0, char_offset: 0 };
    const offset = match ? 0 : target - chapter.start_global_char;
    alignmentRequest.current?.abort();
    if (offset > 0) {
      const request = new AbortController();
      alignmentRequest.current = request;
      try {
        const content = await api<{ blocks: Block[] }>(
          prefix + `/ebook/chapters/${chapter.spine_index}`,
          { signal: request.signal },
        );
        if (request.signal.aborted) return;
        let remaining = offset;
        for (const block of content.blocks) {
          const length = codePointLength(block.text);
          anchor.block_index = block.block_index;
          anchor.char_offset = Math.min(length, remaining);
          if (remaining <= length) break;
          remaining -= length;
        }
      } catch (cause) {
        if (!request.signal.aborted) setError((cause as Error).message);
        return;
      }
    }
    jump(anchor);
    dismissAlignment(true);
  }

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

  useEffect(() => {
    const selector = panel === 'search' ? 'input[type="search"]' : 'button';
    if (panel) drawerRef.current?.querySelector<HTMLElement>(selector)?.focus();
  }, [panel]);

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
      } else saveInitialView.current();
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
        syncAnchor();
        return;
      }
    }
    const next = spine + direction;
    if (next >= 0 && next < chapters.length)
      jump({ spine_index: next, block_index: 0, char_offset: 0 });
    else if (direction > 0 && loadedSpine === spine && blocks.length) {
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

  function anchorFromRect(rect: DOMRect, minAboveSpace = 58, halfWidth = 148): PopoverAnchor {
    const stageBox = stageRef.current?.getBoundingClientRect();
    if (!stageBox || !stageBox.width) return { x: 180, y: 12, placement: 'below' };
    const fittedHalf = Math.min(halfWidth, Math.max(88, stageBox.width / 2 - 12));
    const center = (rect.left + rect.right) / 2 - stageBox.left;
    const x = Math.max(fittedHalf + 12, Math.min(stageBox.width - fittedHalf - 12, center));
    const placement = rect.top - stageBox.top >= minAboveSpace ? 'above' : 'below';
    const rawY =
      placement === 'above' ? rect.top - stageBox.top - 10 : rect.bottom - stageBox.top + 10;
    const y = Math.max(8, Math.min(stageBox.height - 16, rawY));
    return { x, y, placement };
  }

  function selectText() {
    const viewport = scroll.current;
    const value = window.getSelection();
    if (!viewport || !value?.rangeCount || value.isCollapsed) {
      setSelection(null);
      setDraftNoteMode(false);
      return;
    }
    const range = value.getRangeAt(0);
    if (!viewport.contains(range.commonAncestorContainer)) return;
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
      setDraftNoteMode(false);
      return;
    }
    setActiveMark(null);
    setDraftNoteMode(false);
    setDraftColor('amber');
    setDraftNote('');
    setSelection({
      range: {
        spine_index: spine,
        start_block_index: startBlockIndex,
        start_char_offset: startCharOffset,
        end_block_index: endBlockIndex,
        end_char_offset: endCharOffset,
        selected_text: value.toString(),
      },
      anchor: anchorFromRect(range.getBoundingClientRect()),
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
      checkpoint.save({ ...visible.current, reading_mode: mode });
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

  async function annotate(color: Color, noteText?: string) {
    if (!selection) return;
    try {
      const cleanNote = noteText?.trim() || null;
      const saved = await api<Annotation>(prefix + '/annotations', {
        method: 'POST',
        body: JSON.stringify({
          ...selection.range,
          color,
          ...(cleanNote ? { note: cleanNote } : {}),
        }),
      });
      setAnnotations((items) => [...items, saved]);
      checkpoint.save({
        spine_index: saved.spine_index,
        block_index: saved.end_block_index,
        char_offset: saved.end_char_offset,
        reading_mode: mode,
      });
      setSelection(null);
      setDraftNoteMode(false);
      setDraftNote('');
      window.getSelection()?.removeAllRanges();
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function updateAnnotation(annotation: Annotation, color: Color, noteText: string) {
    try {
      const cleanNote = noteText.trim() || null;
      const saved = await api<Annotation>(prefix + `/annotations/${annotation.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          spine_index: annotation.spine_index,
          start_block_index: annotation.start_block_index,
          start_char_offset: annotation.start_char_offset,
          end_block_index: annotation.end_block_index,
          end_char_offset: annotation.end_char_offset,
          selected_text: annotation.selected_text,
          note: cleanNote,
          color,
        }),
      });
      setAnnotations((items) => items.map((item) => (item.id === annotation.id ? saved : item)));
      setActiveMark((current) =>
        current?.annotation.id === annotation.id ? { ...current, annotation: saved } : current,
      );
      return saved;
    } catch (cause) {
      setError((cause as Error).message);
      return null;
    }
  }

  async function removeAnnotation(id: string) {
    try {
      await api(prefix + `/annotations/${id}`, { method: 'DELETE' });
      setAnnotations((items) => items.filter((item) => item.id !== id));
      setEditingAnnId((current) => (current === id ? null : current));
      setActiveMark((current) => (current?.annotation.id === id ? null : current));
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  const spineAnnotations = annotations.filter((ann) => ann.spine_index === spine);
  const noteCount = marks.length + annotations.length;
  const activeChapter =
    chapters.find((chapter) => chapter.spine_index === spine) || chapters[spine];

  function dismissPanel() {
    setPanel(null);
    setEditingAnnId(null);
    panelTrigger.current?.focus();
  }

  function togglePanel(next: ReaderPanel, trigger: HTMLButtonElement) {
    if (panel === next) dismissPanel();
    else {
      panelTrigger.current = trigger;
      setPanel(next);
      setEditingAnnId(null);
    }
  }

  function recoveryNotice(message: string, retry: () => void, label = t('bookshelf.retry')) {
    return (
      <div className="book-reader-alert book-reader-rail">
        <span role="alert">{message}</span>
        <button
          type="button"
          onClick={() => {
            scroll.current?.focus({ preventScroll: true });
            retry();
          }}
        >
          {label}
        </button>
      </div>
    );
  }

  return (
    <section
      className={`book-reader ${dark ? 'book-reader-dark' : ''}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        if (selection || activeMark) {
          setSelection(null);
          setDraftNoteMode(false);
          setActiveMark(null);
          window.getSelection()?.removeAllRanges();
          scroll.current?.focus({ preventScroll: true });
        } else if (editingAnnId) {
          setEditingAnnId(null);
          drawerRef.current?.querySelector('button')?.focus();
        } else if (panel) dismissPanel();
        else return;
        event.preventDefault();
      }}
    >
      <header className="book-reader-topbar">
        <div className="book-reader-rail book-reader-topbar-inner">
          <div className="book-reader-top-start">
            {onClose && (
              <button type="button" className="book-reader-btn" onClick={onClose}>
                {t('bookshelf.backToBook')}
              </button>
            )}
            <strong className="book-reader-title">{book.title}</strong>
          </div>
          <div className="book-reader-top-end" role="toolbar" aria-label={t('bookshelf.read')}>
            <div className="book-segmented" role="group" aria-label={t('bookshelf.read')}>
              <button
                type="button"
                aria-pressed={mode === 'scroll'}
                onClick={() => selectMode('scroll')}
              >
                {t('bookshelf.scroll')}
              </button>
              <button
                type="button"
                aria-pressed={mode === 'paginated'}
                onClick={() => selectMode('paginated')}
              >
                {t('bookshelf.pages')}
              </button>
            </div>
            <button
              type="button"
              className="book-reader-btn"
              aria-expanded={panel === 'contents'}
              onClick={(event) => togglePanel('contents', event.currentTarget)}
            >
              {t('bookshelf.contents')}
            </button>
            <button
              type="button"
              className="book-reader-btn tnum"
              aria-expanded={panel === 'notes'}
              onClick={(event) => togglePanel('notes', event.currentTarget)}
            >
              {noteCount > 0
                ? t('bookshelf.notesCount', { count: noteCount })
                : t('bookshelf.notes')}
            </button>
            <button
              type="button"
              className="book-reader-btn"
              aria-expanded={panel === 'search'}
              onClick={(event) => togglePanel('search', event.currentTarget)}
            >
              {t('bookshelf.search')}
            </button>
            <button
              type="button"
              className="book-reader-btn"
              aria-expanded={panel === 'appearance'}
              onClick={(event) => togglePanel('appearance', event.currentTarget)}
            >
              {t('bookshelf.appearance')}
            </button>
            {book.has_audiobook && onToggleListen && (
              <button
                type="button"
                className="book-reader-btn"
                aria-pressed={Boolean(listening)}
                onClick={onToggleListen}
              >
                {t('bookshelf.listen')}
              </button>
            )}
          </div>
        </div>
      </header>
      {!alignmentDismissed &&
        book.listening_progress &&
        book.has_audiobook &&
        alignmentAvailable(book.listening_progress, book.reading_progress) && (
          <div className="book-reader-rail book-reader-alignment">
            <BookAlignmentNotice
              source="listening"
              progress={book.listening_progress}
              disabled={!chapters.length || !checkpoint.ready || Boolean(checkpoint.error)}
              onAlign={() => void alignReading(book.listening_progress!)}
              onDismiss={() => {
                alignmentRequest.current?.abort();
                dismissAlignment(true);
              }}
            />
          </div>
        )}
      {listening && audioSession && (
        <div className="book-reader-panel-wrap book-reader-audio-wrap">
          <div className="book-reader-rail">
            <BookAudio key={book.id} book={book} session={audioSession} />
          </div>
        </div>
      )}
      {(error || checkpoint.error?.kind === 'save') && (
        <p className="book-reader-alert book-reader-rail" role="alert">
          {error || checkpoint.error?.message}
        </p>
      )}
      {manifestFailed &&
        recoveryNotice(t('bookshelf.contentsLoadFailed'), () => setManifestAttempt((i) => i + 1))}
      {failedSpine === spine &&
        recoveryNotice(t('bookshelf.chapterLoadFailed'), () => setChapterAttempt((i) => i + 1))}
      {checkpoint.error?.kind === 'load' &&
        recoveryNotice(t('bookshelf.readingProgressLoadFailed'), checkpoint.retry)}
      {checkpoint.error?.kind === 'conflict' &&
        recoveryNotice(
          t('bookshelf.readingProgressConflict'),
          checkpoint.retry,
          t('bookshelf.reloadReadingProgress'),
        )}
      <div ref={stageRef} className="book-reader-stage">
        {panel !== null && (
          <div
            ref={drawerRef}
            className="book-reader-drawer"
            role="group"
            aria-label={t(`bookshelf.${panel}`)}
          >
            <button
              type="button"
              className="book-reader-drawer-close icon-button"
              aria-label={t('common.close')}
              onClick={dismissPanel}
            >
              <Icon name="close" />
            </button>
            {panel === 'contents' &&
              (chapters.length ? (
                <ul className="book-chapter-list">
                  {chapters.map((chapter) => (
                    <li key={chapter.spine_index}>
                      <button
                        type="button"
                        aria-current={chapter.spine_index === spine ? 'true' : undefined}
                        onClick={() => {
                          jump({
                            spine_index: chapter.spine_index,
                            block_index: 0,
                            char_offset: 0,
                          });
                          dismissPanel();
                        }}
                      >
                        <span className="book-chapter-num tnum">
                          {String(chapter.spine_index + 1).padStart(2, '0')}
                        </span>
                        <span className="book-chapter-name">{chapter.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p role="status" className="muted book-sheet-status">
                  {t('bookshelf.empty')}
                </p>
              ))}
            {panel === 'notes' && (
              <div className="book-notes-panel">
                <div className="book-notes-header">
                  <strong>{t('bookshelf.notes')}</strong>
                  <button type="button" onClick={() => void addMark()}>
                    {t('bookshelf.bookmark')}
                  </button>
                </div>
                {!marks.length && !annotations.length && (
                  <p role="status" className="muted book-sheet-status">
                    {t('bookshelf.empty')}
                  </p>
                )}
                {!!marks.length && (
                  <div className="book-notes-group">
                    <div className="book-notes-heading">
                      <span>{t('bookshelf.bookmarks')}</span>{' '}
                      <span className="muted tnum">({marks.length})</span>
                    </div>
                    <ul className="bookshelf-note-list">
                      {marks.map((mark) => (
                        <li key={mark.id} className="book-bookmark-card">
                          <button
                            type="button"
                            className="book-bookmark-quote"
                            onClick={() => {
                              jump(mark);
                              dismissPanel();
                            }}
                          >
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
                  </div>
                )}
                {!!annotations.length && (
                  <div className="book-notes-group">
                    <div className="book-notes-heading">
                      <span>{t('bookshelf.annotations')}</span>{' '}
                      <span className="muted tnum">({annotations.length})</span>
                    </div>
                    <ul className="bookshelf-note-list">
                      {annotations.map((annotation) => (
                        <li
                          key={annotation.id}
                          className="book-annotation-card"
                          data-color={annotation.color}
                        >
                          <div className="book-annotation-card-head">
                            <button
                              type="button"
                              className="book-annotation-quote"
                              onClick={() => {
                                jump({
                                  spine_index: annotation.spine_index,
                                  block_index: annotation.start_block_index,
                                  char_offset: annotation.start_char_offset,
                                });
                                dismissPanel();
                              }}
                            >
                              {annotation.selected_text}
                            </button>
                            <div className="book-annotation-card-actions">
                              <button
                                type="button"
                                className="bookshelf-note-edit"
                                aria-label={`${annotation.note ? t('bookshelf.editNote') : t('bookshelf.addNote')} ${annotation.selected_text}`}
                                onClick={() => {
                                  setEditingAnnId(annotation.id);
                                  setEditingAnnColor(annotation.color);
                                  setEditingAnnNote(annotation.note || '');
                                }}
                              >
                                {annotation.note ? t('bookshelf.editNote') : t('bookshelf.addNote')}
                              </button>
                              <button
                                type="button"
                                className="bookshelf-note-delete"
                                aria-label={`${t('bookshelf.delete')} ${annotation.selected_text}`}
                                onClick={() => void removeAnnotation(annotation.id)}
                              >
                                {t('bookshelf.delete')}
                              </button>
                            </div>
                          </div>
                          {editingAnnId === annotation.id ? (
                            <form
                              className="book-annotation-editor"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void updateAnnotation(
                                  annotation,
                                  editingAnnColor,
                                  editingAnnNote,
                                ).then((saved) => {
                                  if (saved) setEditingAnnId(null);
                                });
                              }}
                            >
                              <div
                                className="book-color-dots"
                                role="radiogroup"
                                aria-label={t('bookshelf.annotations')}
                              >
                                {colors.map((color) => (
                                  <button
                                    type="button"
                                    key={color}
                                    className="book-color-dot"
                                    data-color={color}
                                    role="radio"
                                    aria-checked={editingAnnColor === color}
                                    aria-label={t(`bookshelf.colors.${color}`)}
                                    title={t(`bookshelf.colors.${color}`)}
                                    onClick={() => setEditingAnnColor(color)}
                                  />
                                ))}
                                {customColorPicker(editingAnnColor, setEditingAnnColor)}
                              </div>
                              <textarea
                                aria-label={t('bookshelf.note')}
                                placeholder={t('bookshelf.notePlaceholder')}
                                rows={2}
                                maxLength={4096}
                                value={editingAnnNote}
                                onChange={(event) => setEditingAnnNote(event.target.value)}
                              />
                              <div className="book-annotation-editor-actions">
                                <button type="button" onClick={() => setEditingAnnId(null)}>
                                  {t('bookshelf.cancel')}
                                </button>
                                <button type="submit" className="primary">
                                  {t('bookshelf.save')}
                                </button>
                              </div>
                            </form>
                          ) : annotation.note ? (
                            <p className="book-annotation-note">{annotation.note}</p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {panel === 'search' && (
              <div className="book-search-panel">
                <form
                  className="book-search-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const submitted = query;
                    void api<{ items: Match[] }>(
                      prefix + `/ebook/search?q=${encodeURIComponent(submitted)}`,
                    )
                      .then((value) => {
                        setMatches(value.items);
                        setSearchedQuery(submitted);
                      })
                      .catch((cause: Error) => setError(cause.message));
                  }}
                >
                  <input
                    type="search"
                    aria-label={t('bookshelf.searchText')}
                    placeholder={t('bookshelf.searchText')}
                    value={query}
                    required
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <button type="submit">{t('bookshelf.search')}</button>
                </form>
                {!!matches.length ? (
                  <ul className="bookshelf-note-list">
                    {matches.map((match, index) => (
                      <li key={index} className="book-bookmark-card">
                        <button
                          type="button"
                          className="book-bookmark-quote"
                          onClick={() => {
                            jump(match);
                            dismissPanel();
                          }}
                        >
                          {match.excerpt}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : searchedQuery !== null ? (
                  <p role="status" className="muted book-sheet-status">
                    {t('bookshelf.empty')}
                  </p>
                ) : null}
              </div>
            )}
            {panel === 'appearance' && (
              <div className="book-appearance-panel">
                <button type="button" aria-pressed={dark} onClick={() => setDark(!dark)}>
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
            )}
          </div>
        )}
        {selection && (
          <div
            className={`book-highlight-bar is-${selection.anchor.placement}${draftNoteMode ? ' is-composing' : ''}`}
            style={{ left: `${selection.anchor.x}px`, top: `${selection.anchor.y}px` }}
            role="toolbar"
            aria-label={t('bookshelf.annotations')}
          >
            {draftNoteMode ? (
              <form
                className="book-annotation-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  void annotate(draftColor, draftNote);
                }}
              >
                <div
                  className="book-color-dots"
                  role="radiogroup"
                  aria-label={t('bookshelf.annotations')}
                >
                  {colors.map((color) => (
                    <button
                      type="button"
                      key={color}
                      className="book-color-dot"
                      data-color={color}
                      role="radio"
                      aria-checked={draftColor === color}
                      aria-label={t(`bookshelf.colors.${color}`)}
                      title={t(`bookshelf.colors.${color}`)}
                      onClick={() => setDraftColor(color)}
                    />
                  ))}
                  {customColorPicker(draftColor, setDraftColor)}
                </div>
                <textarea
                  aria-label={t('bookshelf.note')}
                  placeholder={t('bookshelf.notePlaceholder')}
                  rows={2}
                  maxLength={4096}
                  autoFocus
                  value={draftNote}
                  onChange={(event) => setDraftNote(event.target.value)}
                />
                <div className="book-annotation-editor-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setDraftNoteMode(false);
                      setDraftNote('');
                    }}
                  >
                    {t('bookshelf.cancel')}
                  </button>
                  <button type="submit" className="primary">
                    {t('bookshelf.save')}
                  </button>
                </div>
              </form>
            ) : (
              <>
                {colors.map((color) => (
                  <button
                    type="button"
                    key={color}
                    className="book-color-dot"
                    data-color={color}
                    aria-label={t(`bookshelf.colors.${color}`)}
                    title={t(`bookshelf.colors.${color}`)}
                    onClick={() => void annotate(color)}
                  />
                ))}
                {customColorPicker(draftColor, setDraftColor)}
                <button
                  type="button"
                  className="book-highlight-note-btn"
                  aria-label={t('bookshelf.applyCustomColor')}
                  title={t('bookshelf.applyCustomColor')}
                  onClick={() => void annotate(customColor)}
                >
                  <span aria-hidden="true">✓</span>
                </button>
                <span className="book-highlight-divider" aria-hidden="true" />
                <button
                  type="button"
                  className="book-highlight-note-btn"
                  onClick={() => setDraftNoteMode(true)}
                >
                  {t('bookshelf.addNote')}
                </button>
              </>
            )}
          </div>
        )}
        {!selection && activeMark && (
          <div
            className={`book-highlight-bar is-${activeMark.anchor.placement} is-composing`}
            style={{ left: `${activeMark.anchor.x}px`, top: `${activeMark.anchor.y}px` }}
            role="dialog"
            aria-label={t('bookshelf.annotations')}
          >
            <form
              className="book-annotation-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void updateAnnotation(activeMark.annotation, editingAnnColor, editingAnnNote).then(
                  (saved) => {
                    if (saved) setActiveMark(null);
                  },
                );
              }}
            >
              <div
                className="book-color-dots"
                role="radiogroup"
                aria-label={t('bookshelf.annotations')}
              >
                {colors.map((color) => (
                  <button
                    type="button"
                    key={color}
                    className="book-color-dot"
                    data-color={color}
                    role="radio"
                    aria-checked={editingAnnColor === color}
                    aria-label={t(`bookshelf.colors.${color}`)}
                    title={t(`bookshelf.colors.${color}`)}
                    onClick={() => setEditingAnnColor(color)}
                  />
                ))}
                {customColorPicker(editingAnnColor, setEditingAnnColor)}
              </div>
              <textarea
                aria-label={t('bookshelf.note')}
                placeholder={t('bookshelf.notePlaceholder')}
                rows={2}
                maxLength={4096}
                value={editingAnnNote}
                onChange={(event) => setEditingAnnNote(event.target.value)}
              />
              <div className="book-annotation-editor-actions">
                <button
                  type="button"
                  onClick={() => void removeAnnotation(activeMark.annotation.id)}
                >
                  {t('bookshelf.delete')}
                </button>
                <button type="button" onClick={() => setActiveMark(null)}>
                  {t('bookshelf.cancel')}
                </button>
                <button type="submit" className="primary">
                  {t('bookshelf.save')}
                </button>
              </div>
            </form>
          </div>
        )}
        <div
          ref={scroll}
          className={`book-reader-viewport book-reader-${mode}`}
          onScroll={() => {
            setActiveMark(null);
            syncAnchor();
          }}
          onPointerUp={selectText}
          onKeyUp={selectText}
          onClick={(event) => {
            const currentSel = window.getSelection();
            if (currentSel && !currentSel.isCollapsed) return;
            const mark = (event.target as HTMLElement | null)?.closest<HTMLElement>(
              'mark[data-annotation-id]',
            );
            if (!mark) {
              setActiveMark(null);
              return;
            }
            const found = annotations.find((item) => item.id === mark.dataset.annotationId);
            if (!found) return;
            setEditingAnnColor(found.color);
            setEditingAnnNote(found.note || '');
            setActiveMark({
              annotation: found,
              anchor: anchorFromRect(mark.getBoundingClientRect(), 158, 168),
            });
          }}
          tabIndex={0}
          aria-label={book.title}
        >
          {loadedSpine !== spine ? (
            failedSpine !== spine && (
              <p role="status" className="muted book-reader-loading">
                {t('bookshelf.loading')}
              </p>
            )
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
      </div>
      <footer className="book-reader-footer">
        <div className="book-reader-rail book-reader-footer-inner">
          {chapters.length ? (
            <span className="book-reader-progress muted tnum">
              {t('bookshelf.chapterProgress', { current: spine + 1, total: chapters.length })}
              {activeChapter?.title ? ` · ${activeChapter.title}` : ''}
            </span>
          ) : (
            <span />
          )}
          <div className="book-reader-pager">
            <button
              type="button"
              onClick={() => page(-1)}
              disabled={mode === 'scroll' && spine === 0}
            >
              {t(mode === 'scroll' ? 'bookshelf.prevChapter' : 'bookshelf.previous')}
            </button>
            <button
              type="button"
              onClick={() => page(1)}
              disabled={
                !chapters.length ||
                (mode === 'scroll' &&
                  spine === chapters.length - 1 &&
                  (loadedSpine !== spine ||
                    !blocks.length ||
                    !checkpoint.ready ||
                    checkpoint.error?.kind === 'load' ||
                    checkpoint.error?.kind === 'conflict'))
              }
            >
              {t(
                mode === 'paginated'
                  ? 'bookshelf.next'
                  : spine === chapters.length - 1
                    ? 'bookshelf.finishReading'
                    : 'bookshelf.nextChapter',
              )}
            </button>
          </div>
        </div>
      </footer>
    </section>
  );
}

export interface AudioChapter {
  chapter_index: number;
  file_index: number;
  title: string;
  duration_ms: number;
  start_file_ms: number;
  start_book_ms: number;
  end_file_ms: number;
}

interface AudioAlignment {
  position: number;
  onSaved: () => void;
}

export interface BookAudioSession {
  book: Book | null;
  chapters: AudioChapter[] | null;
  current: AudioChapter | undefined;
  audioReady: boolean;
  index: number;
  rate: number;
  timer: number;
  playing: boolean;
  positionMs: number;
  error: string;
  audio: RefObject<HTMLAudioElement | null>;
  open: (
    nextBook: Book,
    autoplayNow?: boolean,
    targetChapterIndex?: number,
    align?: AudioAlignment,
  ) => void;
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
  volume,
}: {
  activeElsewhere: boolean;
  onPlay: () => void;
  userId: string;
  volume: number;
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
  const [manualStart, setManualStart] = useState(false);
  const [restartRevision, restartAudio] = useState(0);
  const restore = useRef(0);
  const touched = useRef(false);
  const autoplay = useRef(false);
  const pendingChapter = useRef<number | null>(null);
  const alignment = useRef<(AudioAlignment & { bookId: string; index: number }) | null>(null);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const prevElsewhere = useRef(activeElsewhere);
  const lastSavedAt = useRef(0);
  const current = chapters?.[index];
  const prefix = book ? `/books/${book.id}` : '';

  const checkpoint = useCheckpoint<Listening>(
    prefix ? `${prefix}/listening-progress` : '',
    (value) => {
      if (value.version && !touched.current && pendingChapter.current === null) {
        restore.current = value.chapter_position_ms;
        setIndex(value.chapter_index);
        setRate(value.playback_rate);
      }
    },
    book?.listening_progress?.completed ? 'restart' : 'resume',
    restartRevision,
  );

  useEffect(() => {
    const target = alignment.current;
    if (
      !target ||
      target.bookId !== book?.id ||
      target.index !== current?.chapter_index ||
      !checkpoint.ready ||
      checkpoint.error
    )
      return;
    alignment.current = null;
    checkpoint.save(
      { chapter_index: target.index, chapter_position_ms: target.position, playback_rate: rate },
      false,
      target.onSaved,
    );
  }, [book?.id, current?.chapter_index, checkpoint, rate]);

  useEffect(() => {
    audio.current?.pause();
    setPlaying(false);
    setTimer(0);
    setManualStart(false);
    setBook(null);
    setChapters(null);
  }, [userId]);

  useEffect(() => {
    setChapters(null);
    setIndex(0);
    setRate(1);
    setPositionMs(0);
    setError('');
    setPlaying(false);
    setManualStart(false);
    restore.current = 0;
    touched.current = false;
    if (!prefix) {
      pendingChapter.current = null;
      return;
    }
    const request = new AbortController();
    void api<{ chapters: AudioChapter[] }>(prefix + '/audiobook', { signal: request.signal })
      .then((value) => {
        setChapters(value.chapters);
        if (pendingChapter.current !== null && value.chapters?.[pendingChapter.current]) {
          restore.current =
            alignment.current?.bookId === book?.id ? (alignment.current?.position ?? 0) : 0;
          touched.current = true;
          setManualStart(true);
          setIndex(pendingChapter.current);
          pendingChapter.current = null;
        } else if (value.chapters.length > 0) {
          setIndex((prev) => Math.min(prev, value.chapters.length - 1));
        }
      })
      .catch((cause: Error) => {
        if (!request.signal.aborted) setError(cause.message);
      });
    return () => request.abort();
  }, [prefix]);

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    if (audio.current) audio.current.volume = volume;
  }, [volume]);

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

  const close = useCallback(() => {
    save();
    audio.current?.pause();
    pendingChapter.current = null;
    alignment.current = null;
    autoplay.current = false;
    setManualStart(false);
    setPlaying(false);
    setTimer(0);
    setBook(null);
    setChapters(null);
  }, [save]);

  useEffect(() => {
    const rising = activeElsewhere && !prevElsewhere.current;
    prevElsewhere.current = activeElsewhere;
    if (rising && book) {
      close();
    }
  }, [activeElsewhere, book, close]);

  const choose = useCallback(
    (next: number, play = false, position = 0, recordPrevious = true) => {
      if (!chapters?.[next]) return;
      if (play) onPlay();
      if (recordPrevious) save();
      restore.current = position;
      touched.current = true;
      setManualStart(true);
      autoplay.current = play;
      if (audio.current && chapters[next].file_index === current?.file_index) {
        audio.current.currentTime = (chapters[next].start_file_ms + position) / 1000;
        setPositionMs(position);
        if (play) {
          autoplay.current = false;
          void audio.current.play().catch((cause: Error) => setError(cause.message));
        }
      }
      setIndex(next);
    },
    [chapters, current?.file_index, onPlay, save],
  );

  const open = useCallback(
    (nextBook: Book, autoplayNow = false, targetChapterIndex?: number, align?: AudioAlignment) => {
      if (targetChapterIndex !== undefined && align) {
        alignment.current = { bookId: nextBook.id, index: targetChapterIndex, ...align };
      }
      if (autoplayNow) onPlay();
      if (book?.id === nextBook.id) {
        const restarting =
          autoplayNow && targetChapterIndex === 0 && nextBook.listening_progress?.completed;
        if (restarting) {
          setBook(nextBook);
          restartAudio((revision) => revision + 1);
        }
        if (targetChapterIndex !== undefined && chapters?.[targetChapterIndex]) {
          choose(
            targetChapterIndex,
            autoplayNow || Boolean(align && playing),
            align?.position,
            !restarting,
          );
          if (targetChapterIndex === index && align && checkpoint.ready && !checkpoint.error) {
            alignment.current = null;
            checkpoint.save(
              { chapter_index: index, chapter_position_ms: align.position, playback_rate: rate },
              false,
              align.onSaved,
            );
          }
        } else if (autoplayNow && audio.current) {
          if (audio.current.paused) {
            touched.current = true;
            setManualStart(true);
            void audio.current.play().catch((cause: Error) => setError(cause.message));
          } else {
            audio.current.pause();
          }
        }
        return;
      }
      save();
      audio.current?.pause();
      setPlaying(false);
      pendingChapter.current = targetChapterIndex ?? null;
      autoplay.current = autoplayNow;
      setBook(nextBook);
    },
    [book?.id, chapters, checkpoint, choose, index, onPlay, playing, rate, save],
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
      setManualStart(true);
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

  const audioReady = Boolean(chapters && current && (checkpoint.ready || manualStart));

  return {
    book,
    chapters,
    current,
    audioReady,
    index,
    rate,
    timer,
    playing,
    positionMs,
    error: error || checkpoint.error?.message || '',
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
        audio.current.volume = volumeRef.current;
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

export function BookAudioElement({ session }: { session: BookAudioSession }) {
  if (!session.book) return null;
  const src =
    session.audioReady && session.current
      ? `/api/v1/books/${session.book.id}/audiobook/files/${session.current.file_index}/stream`
      : undefined;
  return (
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
  );
}

export function BookAudio({ book, session }: { book: Book; session: BookAudioSession }) {
  const { t } = useTranslation();

  useEffect(() => {
    if (session.book?.id !== book.id) {
      session.open(book);
    }
  }, [book, session]);

  const current = session.book?.id === book.id ? session.current : undefined;
  const chapters = session.book?.id === book.id ? session.chapters : null;
  if (!current || !session.audioReady) {
    return (
      <p role={session.error ? 'alert' : 'status'}>{session.error || t('bookshelf.loading')}</p>
    );
  }
  return (
    <section className="book-audio">
      <div className="book-audio-transport-buttons">
        <button type="button" className="book-skip-pill tnum" onClick={() => session.seekBy(-15)}>
          -15s
        </button>
        <button type="button" className="primary book-play-pill" onClick={session.togglePlay}>
          {t(session.playing ? 'bookshelf.pause' : 'bookshelf.play')}
        </button>
        <button type="button" className="book-skip-pill tnum" onClick={() => session.seekBy(30)}>
          +30s
        </button>
      </div>
      <div className="book-audio-timeline">
        <span className="book-time tnum">{time(session.positionMs / 1000)}</span>
        <input
          type="range"
          className="book-audio-scrubber"
          aria-label={current.title}
          aria-valuetext={t('playerPage.progressTimeAria', {
            elapsed: time(session.positionMs / 1000),
            total: time(current.duration_ms / 1000),
          })}
          min={0}
          max={Math.max(1, current.duration_ms)}
          value={Math.min(current.duration_ms, session.positionMs)}
          onChange={(event) => session.seekToChapterMs(Number(event.target.value))}
        />
        <span className="book-time tnum">{time(current.duration_ms / 1000)}</span>
      </div>
      <div className="book-audio-bar-options">
        <select
          className="book-audio-chapter"
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
      {session.error && <p role="alert">{session.error}</p>}
    </section>
  );
}
