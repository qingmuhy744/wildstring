import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, time } from './api';

export interface Book {
  id: string;
  library_id: string;
  title: string;
  subtitle?: string;
  has_ebook: boolean;
  has_audiobook: boolean;
  progress_status?: 'unread' | 'in_progress' | 'finished';
  resume_kind?: 'reading' | 'listening';
}

type Mode = 'scroll' | 'paginated';
type Color = 'amber' | 'terracotta' | 'sage' | 'stone';
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
interface Block {
  block_index: number;
  tag: string;
  text: string;
  image_key?: string;
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

const key = () =>
  globalThis.crypto?.randomUUID?.() || `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function deviceId() {
  const saved = localStorage.getItem('wildstring:book-device');
  if (saved) return saved;
  const id = key();
  localStorage.setItem('wildstring:book-device', id);
  return id;
}

function useCheckpoint<T>(path: string, onLoad: (value: T & Checkpoint) => void) {
  const [error, setError] = useState('');
  const load = useRef(onLoad);
  load.current = onLoad;
  const session = useRef({ id: key(), version: 0, sequence: 0, ready: false, blocked: false });
  const requests = useRef(Promise.resolve());
  useEffect(() => {
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
  }, [path]);
  const save = useCallback(
    (fields: T, completed = false) => {
      const current = session.current;
      if (!current.ready || current.blocked) return;
      const sequence = ++current.sequence;
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
              intent: 'resume',
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

function charIndex(text: string, offset: number) {
  return [...text.slice(0, offset)].length;
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

  function jump({ spine_index, block_index, char_offset }: Anchor, persist = true) {
    const anchor = { spine_index, block_index, char_offset };
    pending.current = anchor;
    if (anchor.spine_index === loadedSpine) restore(anchor);
    else setSpine(anchor.spine_index);
    if (persist) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = 0;
      checkpoint.save({ ...anchor, reading_mode: mode });
    }
  }

  const checkpoint = useCheckpoint<Reading>(prefix + '/reading-progress', (value) => {
    if (value.version) {
      setMode(value.reading_mode);
      jump(value, false);
    }
  });

  useEffect(() => {
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
    const text = block.firstChild;
    const range = document.createRange();
    if (text?.nodeType === Node.TEXT_NODE) {
      const characters = [...(text.textContent || '')];
      const position = Math.min(anchor.char_offset, Math.max(characters.length - 1, 0));
      const offset = characters.slice(0, position).join('').length;
      range.setStart(text, offset);
      range.setEnd(text, offset + (characters[position]?.length || 0));
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
    const box = viewport.getBoundingClientRect();
    const range = document.createRange();
    for (const block of viewport.querySelectorAll<HTMLElement>('[data-block]')) {
      const text = block.firstChild;
      range.selectNodeContents(block);
      const boxes =
        text?.nodeType === Node.TEXT_NODE ? range.getClientRects() : block.getClientRects();
      const fragment = [...boxes].find(
        (rect) =>
          rect.bottom > box.top &&
          rect.top < box.bottom &&
          rect.right > box.left &&
          rect.left < box.right,
      );
      if (!fragment) continue;
      let charOffset = 0;
      if (text?.nodeType === Node.TEXT_NODE) {
        const top = Math.max(fragment.top, box.top);
        const bottom = Math.min(fragment.bottom, box.bottom);
        const caret = document.caretRangeFromPoint(
          Math.max(fragment.left, box.left) + 1,
          (top + bottom) / 2,
        );
        if (caret?.startContainer === text)
          charOffset = charIndex(text.textContent || '', caret.startOffset);
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
      checkpoint.save(
        {
          spine_index: spine,
          block_index: blocks.length - 1,
          char_offset: [...blocks.at(-1)!.text].length,
          reading_mode: mode,
        },
        true,
      );
    }
  }

  function selectText() {
    const value = window.getSelection();
    if (!value?.rangeCount || value.isCollapsed) {
      setSelection(null);
      return;
    }
    const range = value.getRangeAt(0);
    const first = range.startContainer.parentElement?.closest<HTMLElement>('[data-block]');
    const last = range.endContainer.parentElement?.closest<HTMLElement>('[data-block]');
    if (!first || !last || !scroll.current?.contains(first) || !scroll.current.contains(last))
      return;
    setSelection({
      spine_index: spine,
      start_block_index: Number(first.dataset.block),
      start_char_offset: charIndex(range.startContainer.textContent || '', range.startOffset),
      end_block_index: Number(last.dataset.block),
      end_char_offset: charIndex(range.endContainer.textContent || '', range.endOffset),
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
        <input
          aria-label={t('bookshelf.fontSize')}
          type="range"
          value={size}
          min={14}
          max={24}
          onChange={(event) => setSize(Number(event.target.value))}
        />
        <input
          aria-label={t('bookshelf.lineHeight')}
          type="range"
          value={lineHeight}
          min={1.2}
          max={2.2}
          step={0.1}
          onChange={(event) => setLineHeight(Number(event.target.value))}
        />
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
        <div className="bookshelf-controls">
          {colors.map((color) => (
            <button key={color} data-color={color} onClick={() => void annotate(color)}>
              {t(`bookshelf.colors.${color}`)}
            </button>
          ))}
        </div>
      )}
      {!!marks.length && (
        <details>
          <summary>{t('bookshelf.bookmarks')}</summary>
          <ul>
            {marks.map((mark) => (
              <li key={mark.id}>
                <button onClick={() => jump(mark)}>
                  {mark.excerpt || t('bookshelf.bookmark')}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {!!annotations.length && (
        <details>
          <summary>{t('bookshelf.annotations')}</summary>
          <ul>
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
              </li>
            ))}
          </ul>
        </details>
      )}
      {!!matches.length && (
        <ul>
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
            {blocks.map((block) =>
              block.image_key ? (
                <img
                  key={block.block_index}
                  data-block={block.block_index}
                  alt=""
                  onLoad={() => {
                    if (loadedSpine === spine) restore(visible.current);
                  }}
                  src={`/api/v1${prefix}/ebook/assets/${block.image_key}`}
                />
              ) : /^h[1-6]$/.test(block.tag) ? (
                <h2 key={block.block_index} data-block={block.block_index}>
                  {block.text}
                </h2>
              ) : (
                <p key={block.block_index} data-block={block.block_index}>
                  {block.text}
                </p>
              ),
            )}
          </article>
        )}
      </div>
      <div className="bookshelf-controls">
        <button onClick={() => page(-1)}>{t('bookshelf.previous')}</button>
        <button onClick={() => page(1)}>{t('bookshelf.next')}</button>
      </div>
    </section>
  );
}

interface AudioChapter {
  chapter_index: number;
  file_index: number;
  title: string;
  duration_ms: number;
  start_file_ms: number;
  end_file_ms: number;
}

export function BookAudio({
  book,
  activeElsewhere,
  canEdit,
  onPlay,
}: {
  book: Book;
  activeElsewhere: boolean;
  canEdit: boolean;
  onPlay: () => void;
}) {
  const { t } = useTranslation();
  const prefix = `/books/${book.id}`;
  const audio = useRef<HTMLAudioElement>(null);
  const [chapters, setChapters] = useState<AudioChapter[] | null>(null);
  const [index, setIndex] = useState(0);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState('');
  const [timer, setTimer] = useState(0);
  const restore = useRef(0);
  const touched = useRef(false);
  const autoplay = useRef(false);
  const last = useRef(0);
  const current = chapters?.[index];

  const checkpoint = useCheckpoint<Listening>(prefix + '/listening-progress', (value) => {
    if (value.version && !touched.current) {
      restore.current = value.chapter_position_ms;
      setIndex(value.chapter_index);
      setRate(value.playback_rate);
    }
  });

  useEffect(() => {
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
    if (activeElsewhere) audio.current?.pause();
  }, [activeElsewhere]);
  useEffect(() => {
    if (!timer) return;
    const timeout = window.setTimeout(() => {
      audio.current?.pause();
      setTimer(0);
    }, timer * 60_000);
    return () => window.clearTimeout(timeout);
  }, [timer]);

  function save(completed = false) {
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
  }

  function choose(next: number, play = false) {
    if (!chapters?.[next]) return;
    save();
    restore.current = 0;
    touched.current = true;
    autoplay.current = play;
    if (audio.current && chapters[next].file_index === current?.file_index) {
      audio.current.currentTime = chapters[next].start_file_ms / 1000;
      if (play) {
        autoplay.current = false;
        void audio.current.play().catch((cause: Error) => setError(cause.message));
      }
    }
    setIndex(next);
  }

  if (!current) return <p role={error ? 'alert' : 'status'}>{error || t('bookshelf.loading')}</p>;
  return (
    <section className="book-audio">
      <div className="bookshelf-controls">
        <select
          aria-label={t('bookshelf.contents')}
          value={index}
          onChange={(event) => choose(Number(event.target.value), !audio.current?.paused)}
        >
          {chapters?.map((chapter) => (
            <option key={chapter.chapter_index} value={chapter.chapter_index}>
              {chapter.title} · {time(chapter.duration_ms / 1000)}
            </option>
          ))}
        </select>
        <select
          aria-label={t('bookshelf.speed')}
          value={rate}
          onChange={(event) => setRate(Number(event.target.value))}
        >
          {[0.75, 1, 1.25, 1.5, 1.75, 2, 2.5].map((value) => (
            <option key={value} value={value}>
              {value}×
            </option>
          ))}
        </select>
        <select
          aria-label={t('bookshelf.sleep')}
          value={timer}
          onChange={(event) => setTimer(Number(event.target.value))}
        >
          <option value={0}>{t('bookshelf.sleep')}</option>
          {[15, 30, 45, 60].map((minutes) => (
            <option key={minutes} value={minutes}>
              {t('bookshelf.minutes', { minutes })}
            </option>
          ))}
        </select>
        {[-15, 30].map((seconds) => (
          <button
            key={seconds}
            onClick={() => {
              if (audio.current)
                audio.current.currentTime = Math.max(
                  current.start_file_ms / 1000,
                  Math.min(current.end_file_ms / 1000, audio.current.currentTime + seconds),
                );
            }}
          >
            {seconds > 0 ? '+' : ''}
            {seconds}s
          </button>
        ))}
      </div>
      {canEdit && (
        <details>
          <summary>{t('bookshelf.editChapter')}</summary>
          <form
            key={index}
            className="bookshelf-controls"
            onSubmit={(event) => {
              event.preventDefault();
              const title = String(new FormData(event.currentTarget).get('title') || '').trim();
              if (!title) return;
              void api<Pick<AudioChapter, 'chapter_index' | 'title'>>(
                prefix + `/audiobook/chapters/${index}`,
                { method: 'PATCH', body: JSON.stringify({ title }) },
              )
                .then((edited) => {
                  setChapters(
                    (items) =>
                      items?.map((item) =>
                        item.chapter_index === edited.chapter_index
                          ? { ...item, title: edited.title }
                          : item,
                      ) ?? null,
                  );
                  setError('');
                })
                .catch((cause: Error) => setError(cause.message));
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
      <audio
        ref={audio}
        controls
        preload="metadata"
        src={`/api/v1${prefix}/audiobook/files/${current.file_index}/stream`}
        onLoadedMetadata={() => {
          if (!audio.current) return;
          audio.current.currentTime = (current.start_file_ms + restore.current) / 1000;
          audio.current.playbackRate = rate;
          restore.current = 0;
          if (autoplay.current) {
            autoplay.current = false;
            void audio.current.play().catch((cause: Error) => setError(cause.message));
          }
        }}
        onPlay={() => {
          touched.current = true;
          onPlay();
        }}
        onPause={() => save()}
        onSeeked={() => save()}
        onEnded={() => {
          if (chapters?.[index + 1]) choose(index + 1, true);
          else save(true);
        }}
        onTimeUpdate={() => {
          if (!audio.current) return;
          if (
            audio.current.currentTime * 1000 >= current.end_file_ms &&
            chapters?.[index + 1]?.file_index === current.file_index
          ) {
            choose(index + 1, true);
          } else if (Date.now() - last.current > 10_000) {
            last.current = Date.now();
            save();
          }
        }}
      />
      {(error || checkpoint.error) && <p role="alert">{error || checkpoint.error}</p>}
    </section>
  );
}
