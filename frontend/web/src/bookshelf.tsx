import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api, time } from './api';
import {
  alignmentAvailable,
  BookAlignmentNotice,
  BookReader,
  matchingChapter,
  type AudioChapter,
  type Book,
  type BookAudioSession,
  type EbookChapter,
} from './book-reader';
import { Icon } from './icons';
import './bookshelf.css';

interface Library {
  id: string;
  name: string;
  default_access?: 'restricted' | 'all';
  storage_mode: 'copy' | 'hardlink';
  ebook_upload_enabled?: boolean;
  version: number;
}
interface Candidate {
  provider: string;
  provider_name?: string;
  external_id: string;
  fields: { title: string; authors?: string[]; published_year?: number };
}
interface MetadataSource {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
}
interface BooksResponse {
  items: Book[];
  total?: number;
  has_more?: boolean;
}

const BOOKS_PAGE_SIZE = 100;

function progressLabel(
  t: (key: string) => string,
  progressStatus?: Book['progress_status'],
): string | null {
  if (!progressStatus) return null;
  if (progressStatus === 'finished') return t('bookshelf.finished');
  if (progressStatus === 'in_progress') return t('bookshelf.inProgress');
  return t('bookshelf.unread');
}

export function readingBookId() {
  return /^\/books\/([a-zA-Z0-9_-]+)\/read\/?$/.exec(window.location.pathname)?.[1];
}

export function Bookshelf({
  owner,
  canEdit,
  canUpload,
  audioSession,
  focusedBook,
  onFocusBookHandled,
}: {
  owner: boolean;
  canEdit: boolean;
  canUpload: boolean;
  audioSession: BookAudioSession;
  focusedBook?: Book | null;
  onFocusBookHandled?: () => void;
}) {
  const { t } = useTranslation();
  const [libraryId, setLibraryId] = useState('');
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [books, setBooks] = useState<Book[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pairCandidates, setPairCandidates] = useState<Book[] | null>(null);
  const [selected, setSelected] = useState<Book | null>(null);
  const [reading, setReading] = useState(false);
  const [initialSpine, setInitialSpine] = useState<number | null>(null);
  const [dismissedAlignment, setDismissedAlignment] = useState('');
  const [listening, setListening] = useState(false);
  const [audioChapters, setAudioChapters] = useState<AudioChapter[] | null>(null);
  const [ebookChapters, setEbookChapters] = useState<EbookChapter[] | null>(null);
  const [chapterTab, setChapterTab] = useState<'audio' | 'ebook'>('audio');
  const [editingChapterIndex, setEditingChapterIndex] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [debouncedFilter, setDebouncedFilter] = useState('');
  const [format, setFormat] = useState('all');
  const [status, setStatus] = useState('all');
  const [error, setError] = useState('');
  const [staleNotice, setStaleNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [revision, refresh] = useState(0);
  const [routeAttempt, retryRoute] = useState(0);
  const [showBookEdit, setShowBookEdit] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [enabledSources, setEnabledSources] = useState<MetadataSource[]>([]);
  const [checkedSources, setCheckedSources] = useState<string[]>(['itunes', 'openlibrary']);
  const readerDialog = useRef<HTMLDialogElement>(null);
  const readerRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const openReaderBook = useRef<string | null>(null);
  const returnFocusBook = useRef<string | null>(null);
  const returnFocusDetail = useRef(false);
  const loadedRevision = useRef(-1);
  const shelfRef = useRef<HTMLElement>(null);
  const readActionRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const attachEbookInputRef = useRef<HTMLInputElement>(null);
  const loadMoreController = useRef<AbortController | null>(null);

  function refreshDetail(bookId: string) {
    detailRequest.current?.abort();
    const request = new AbortController();
    detailRequest.current = request;
    void api<Book>(`/books/${bookId}`, { signal: request.signal })
      .then((value) => {
        if (!request.signal.aborted) {
          setSelected((current) => (current?.id === value.id ? value : current));
        }
      })
      .catch(() => {
        // The list already includes the book and its progress summaries.
      });
  }

  useEffect(() => {
    if (!filter) {
      setDebouncedFilter('');
      return;
    }
    const timer = window.setTimeout(() => setDebouncedFilter(filter), 200);
    return () => window.clearTimeout(timer);
  }, [filter]);

  useEffect(
    () => () => {
      loadMoreController.current?.abort();
      detailRequest.current?.abort();
    },
    [],
  );

  useEffect(() => {
    setTitleDraft(selected?.title || '');
  }, [selected?.id, selected?.title]);

  useEffect(() => {
    const dialog = readerDialog.current;
    if (reading && dialog && !dialog.open) dialog.showModal();
  }, [reading]);

  useEffect(() => {
    if (!focusedBook) return;
    readerRequest.current?.abort();
    openReaderBook.current = null;
    returnFocusBook.current = null;
    if (readingBookId()) window.history.replaceState(null, '', '/');
    setSelected(focusedBook);
    setReading(false);
    setInitialSpine(null);
    setShowBookEdit(false);
    onFocusBookHandled?.();
  }, [focusedBook, onFocusBookHandled]);

  useEffect(() => {
    setAudioChapters(null);
    setEbookChapters(null);
    setEditingChapterIndex(null);
    if (!selected) return;
    setChapterTab(selected.has_audiobook ? 'audio' : 'ebook');
    const request = new AbortController();
    if (selected.has_audiobook) {
      void api<{ chapters: AudioChapter[] }>(`/books/${selected.id}/audiobook`, {
        signal: request.signal,
      })
        .then((result) => setAudioChapters(result.chapters))
        .catch((cause: Error) => {
          if (!request.signal.aborted) setError(cause.message);
        });
    }
    if (selected.has_ebook) {
      void api<{ chapters: EbookChapter[] }>(`/books/${selected.id}/ebook/manifest`, {
        signal: request.signal,
      })
        .then((result) => setEbookChapters(result.chapters))
        .catch((cause: Error) => {
          if (!request.signal.aborted) setError(cause.message);
        });
    }
    return () => request.abort();
  }, [selected?.id, selected?.has_audiobook, selected?.has_ebook]);

  const selection = libraries.find((library) => library.id === libraryId);
  const selectedLibrary = libraries.find((library) => library.id === selected?.library_id);

  function buildBooksQuery(offset: number) {
    const params = new URLSearchParams({ limit: String(BOOKS_PAGE_SIZE) });
    if (offset > 0) params.set('offset', String(offset));
    if (libraryId) params.set('library_id', libraryId);
    const trimmed = debouncedFilter.trim();
    if (trimmed) params.set('q', trimmed);
    if (format !== 'all') params.set('format', format === 'audio' ? 'audiobook' : format);
    if (status !== 'all') params.set('progress_status', status);
    return `/books?${params.toString()}`;
  }

  useEffect(() => {
    const request = new AbortController();
    void Promise.all([
      api<{ items: Library[] }>('/book-libraries', { signal: request.signal }),
      canEdit || owner
        ? api<{ items: MetadataSource[] }>('/books/metadata/sources', {
            signal: request.signal,
          }).catch(() => null)
        : Promise.resolve(null),
    ])
      .then(([nextLibraries, nextSources]) => {
        setLibraries(nextLibraries.items);
        if (nextSources) {
          setEnabledSources(nextSources.items);
          const enabledIds = nextSources.items.map((item) => item.id);
          setCheckedSources((prev) => {
            const retained = prev.filter((id) => enabledIds.includes(id));
            return retained.length ? retained : enabledIds;
          });
        }
      })
      .catch((cause: Error) => {
        if (!request.signal.aborted) setError(cause.message);
      });
    return () => request.abort();
  }, [canEdit, owner, revision]);

  useEffect(() => {
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    const request = new AbortController();
    setLoading(true);
    setLoadingMore(false);
    setError('');
    void api<BooksResponse>(buildBooksQuery(0), { signal: request.signal })
      .then((nextBooks) => {
        setBooks(nextBooks.items);
        setHasMore(nextBooks.has_more ?? nextBooks.items.length === BOOKS_PAGE_SIZE);
      })
      .catch((cause: Error) => {
        if (!request.signal.aborted) setError(cause.message);
      })
      .finally(() => {
        if (!request.signal.aborted) {
          loadedRevision.current = revision;
          setLoading(false);
        }
      });
    return () => request.abort();
  }, [libraryId, debouncedFilter, format, status, revision]);

  useEffect(() => {
    if (returnFocusDetail.current && !reading && selected) {
      returnFocusDetail.current = false;
      readActionRef.current?.focus();
      return;
    }
    const bookId = returnFocusBook.current;
    if (!bookId || reading || selected || loading || loadedRevision.current !== revision) return;
    returnFocusBook.current = null;
    const card = shelfRef.current?.querySelector<HTMLButtonElement>(
      `[data-book-id="${CSS.escape(bookId)}"]`,
    );
    (card ?? searchRef.current)?.focus();
  }, [reading, selected, loading, revision]);

  useEffect(() => {
    if (!showBookEdit || !selected || selected.has_ebook === selected.has_audiobook) {
      setPairCandidates(null);
      return;
    }
    const request = new AbortController();
    const params = new URLSearchParams({
      library_id: selected.library_id,
      limit: String(BOOKS_PAGE_SIZE),
    });
    void api<BooksResponse>(`/books?${params.toString()}`, { signal: request.signal })
      .then((result) => setPairCandidates(result.items))
      .catch(() => {
        if (!request.signal.aborted) setPairCandidates(null);
      });
    return () => request.abort();
  }, [
    showBookEdit,
    selected?.id,
    selected?.library_id,
    selected?.has_ebook,
    selected?.has_audiobook,
  ]);

  async function loadMoreBooks() {
    if (!books || loadingMore || !hasMore) return;
    loadMoreController.current?.abort();
    const request = new AbortController();
    loadMoreController.current = request;
    setLoadingMore(true);
    setError('');
    try {
      const next = await api<BooksResponse>(buildBooksQuery(books.length), {
        signal: request.signal,
      });
      setBooks((prev) => {
        const current = prev || [];
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...next.items.filter((item) => !seen.has(item.id))];
      });
      setHasMore(next.has_more ?? next.items.length === BOOKS_PAGE_SIZE);
    } catch (cause) {
      if (!request.signal.aborted) setError((cause as Error).message);
    } finally {
      if (loadMoreController.current === request) {
        loadMoreController.current = null;
      }
      if (!request.signal.aborted) setLoadingMore(false);
    }
  }

  function leaveReading() {
    const bookId = openReaderBook.current;
    if (!bookId) return;
    openReaderBook.current = null;
    returnFocusDetail.current = true;
    readerDialog.current?.close();
    setReading(false);
    setInitialSpine(null);
    setListening(false);
    refreshDetail(bookId);
    refresh((value) => value + 1);
  }

  useEffect(() => {
    const route = () => {
      readerRequest.current?.abort();
      const identity = readingBookId();
      if (identity && identity === openReaderBook.current) return;
      leaveReading();
      if (!identity) return;
      const request = new AbortController();
      readerRequest.current = request;
      void api<Book>(`/books/${identity}`, { signal: request.signal })
        .then((book) => {
          if (request.signal.aborted || readingBookId() !== identity) return;
          openReaderBook.current = book.has_ebook ? book.id : null;
          returnFocusBook.current = null;
          setStaleNotice('');
          setError('');
          setSelected(book);
          setReading(book.has_ebook);
        })
        .catch((cause: Error) => {
          if (request.signal.aborted || readingBookId() !== identity) return;
          if (cause instanceof ApiError && cause.status === 404) {
            window.history.replaceState(null, '', '/');
            setReading(false);
            setSelected(null);
            setError('');
            setStaleNotice(t('bookshelf.staleBookLink'));
          } else {
            setError(cause.message);
          }
        });
    };
    route();
    window.addEventListener('popstate', route);
    return () => {
      readerRequest.current?.abort();
      window.removeEventListener('popstate', route);
    };
  }, [routeAttempt, t]);

  function enterReading(book: Book, spineIndex: number | null = null) {
    readerRequest.current?.abort();
    detailRequest.current?.abort();
    openReaderBook.current = book.id;
    returnFocusBook.current = null;
    returnFocusDetail.current = false;
    setInitialSpine(spineIndex);
    setReading(true);
    if (readingBookId() !== book.id) {
      window.history.pushState({ bookReader: true }, '', `/books/${book.id}/read`);
    }
  }

  function closeReader() {
    readerRequest.current?.abort();
    leaveReading();
    if (window.history.state?.bookReader) {
      window.history.back();
    } else if (readingBookId()) {
      window.history.replaceState(null, '', '/');
    }
  }

  async function write(operation: () => Promise<void>, reportError = setError) {
    setError('');
    setPending(true);
    try {
      await operation();
      refresh((value) => value + 1);
    } catch (cause) {
      reportError((cause as Error).message);
    } finally {
      setPending(false);
    }
  }

  function changeBook(book: Book | null) {
    readerRequest.current?.abort();
    detailRequest.current?.abort();
    openReaderBook.current = null;
    returnFocusDetail.current = false;
    returnFocusBook.current = book ? null : (selected?.id ?? null);
    if (readingBookId()) window.history.replaceState(null, '', '/');
    setReading(false);
    setInitialSpine(null);
    setListening(false);
    setShowBookEdit(false);
    setStaleNotice('');
    setSelected(book);
    setCandidates(null);
    if (!book) {
      refresh((value) => value + 1);
      return;
    }
    refreshDetail(book.id);
  }

  async function uploadEbookFile(file: File, attach?: Book) {
    const body = new FormData();
    body.append('file', file);
    if (!attach && selection?.storage_mode === 'copy') {
      body.append('library_id', selection.id);
    }
    setUploading(true);
    try {
      await write(async () => {
        const result = await api<{ id: string }>(
          attach ? `/books/${attach.id}/ebook` : '/books/upload',
          { method: 'POST', body },
        );
        if (!attach && selection && selection.storage_mode !== 'copy') {
          setLibraryId('');
        }
        changeBook(await api<Book>(`/books/${result.id}`));
      });
    } finally {
      setUploading(false);
    }
  }

  async function uploadCoverFile(file: File, targetBook: Book) {
    const body = new FormData();
    body.append('file', file);
    await write(async () => {
      await api(`/books/${targetBook.id}/cover`, { method: 'POST', body });
      setSelected(await api<Book>(`/books/${targetBook.id}`));
    });
  }

  const visible = books || [];

  const resume =
    !debouncedFilter.trim() && format === 'all' && status === 'all'
      ? visible.find((book) => book.resume_kind)
      : undefined;

  if (selected && reading) {
    return (
      <dialog
        className="book-reader-layout"
        aria-label={selected.title}
        ref={readerDialog}
        onCancel={(event) => {
          event.preventDefault();
          closeReader();
        }}
      >
        <BookReader
          key={selected.id}
          book={selected}
          initialSpine={initialSpine}
          onClose={closeReader}
          onProgressSaved={() => refreshDetail(selected.id)}
          listening={listening}
          onToggleListen={() => {
            if (!listening) audioSession.open(selected);
            setListening(!listening);
          }}
          audioSession={audioSession}
          canEdit={canEdit}
        />
      </dialog>
    );
  }

  const selectedMeta = selected
    ? [
        selected.authors?.join(' · '),
        selected.has_ebook && t('bookshelf.ebook'),
        selected.has_audiobook && t('bookshelf.audiobook'),
        progressLabel(t, selected.progress_status),
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const isSelectedAudioLoaded = Boolean(selected && audioSession.book?.id === selected.id);
  const isSelectedPlaying = Boolean(isSelectedAudioLoaded && audioSession.playing);
  const readingProgress = selected?.reading_progress;
  const savedListeningProgress = selected?.listening_progress;
  const liveAudioTotal =
    isSelectedAudioLoaded && audioSession.chapters?.length
      ? audioSession.chapters.reduce((sum, chapter) => sum + chapter.duration_ms, 0)
      : 0;
  const listeningProgress =
    isSelectedAudioLoaded && audioSession.current
      ? {
          chapter_index: audioSession.current.chapter_index,
          chapter_title: audioSession.current.title,
          chapter_position_ms: audioSession.positionMs,
          book_position_ms: audioSession.current.start_book_ms + audioSession.positionMs,
          total_duration_ms: liveAudioTotal,
          overall_ratio:
            liveAudioTotal > 0
              ? Math.min(
                  1,
                  (audioSession.current.start_book_ms + audioSession.positionMs) / liveAudioTotal,
                )
              : 0,
          playback_rate: audioSession.rate,
          completed: false,
          updated_at: savedListeningProgress?.updated_at ?? Date.now() / 1000,
        }
      : savedListeningProgress;
  const alignmentKey = `${selected?.id}:${readingProgress?.updated_at}`;
  const showAudioAlignment =
    selected?.has_ebook &&
    selected.has_audiobook &&
    readingProgress &&
    alignmentKey !== dismissedAlignment &&
    alignmentAvailable(readingProgress, savedListeningProgress);

  function alignAudio() {
    if (!selected || !readingProgress || !audioChapters?.length) return;
    const match = matchingChapter(
      audioChapters,
      readingProgress.chapter_title,
      readingProgress.spine_index,
    );
    const last = audioChapters[audioChapters.length - 1];
    const position = Math.round(
      readingProgress.overall_ratio * (last.start_book_ms + last.duration_ms),
    );
    const chapter =
      match ??
      audioChapters.find(
        (_, index) => (audioChapters[index + 1]?.start_book_ms ?? Infinity) > position,
      );
    if (!chapter) return;
    const offset = match ? 0 : Math.min(chapter.duration_ms, position - chapter.start_book_ms);
    audioSession.open(selected, false, chapter.chapter_index, {
      position: offset,
      onSaved: () => {
        void api<Book>(`/books/${selected.id}`)
          .then((book) => setSelected((current) => (current?.id === book.id ? book : current)))
          .catch(() => {});
      },
    });
    setDismissedAlignment(alignmentKey);
  }

  const pairableBooks = selected
    ? (pairCandidates ?? books ?? []).filter(
        (book) =>
          book.id !== selected.id &&
          book.library_id === selected.library_id &&
          book.has_ebook !== selected.has_ebook &&
          book.has_audiobook !== selected.has_audiobook,
      )
    : [];

  const showAudioChapters = Boolean(
    selected?.has_audiobook && (!selected.has_ebook || chapterTab === 'audio'),
  );
  const displayedAudioChapters =
    selected && audioSession.book?.id === selected.id && audioSession.chapters
      ? audioSession.chapters
      : audioChapters;

  return (
    <section className="workspace-page bookshelf" ref={shelfRef}>
      {!selected && (
        <header className="workspace-heading bookshelf-heading">
          <h1>{t('bookshelf.title')}</h1>
          {canUpload && selection?.ebook_upload_enabled !== false && (
            <div className="bookshelf-heading-actions">
              <input
                ref={uploadInputRef}
                className="sr-only"
                type="file"
                tabIndex={-1}
                aria-hidden="true"
                accept=".epub,.txt,application/epub+zip,text/plain"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) void uploadEbookFile(file);
                }}
              />
              <button
                type="button"
                className="bookshelf-upload-btn"
                disabled={pending}
                onClick={() => uploadInputRef.current?.click()}
              >
                {uploading ? t('bookshelf.uploading') : t('bookshelf.upload')}
              </button>
            </div>
          )}
        </header>
      )}
      {selected && (
        <div className="book-detail-topbar">
          <button type="button" onClick={() => changeBook(null)}>
            {t('bookshelf.back')}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="bookshelf-banner bookshelf-banner-error">
          <span>{error}</span>
          <span className="bookshelf-banner-actions">
            <button
              type="button"
              onClick={() => {
                if (readingBookId()) retryRoute((value) => value + 1);
                refresh((value) => value + 1);
              }}
            >
              {t('bookshelf.retry')}
            </button>
            <button type="button" onClick={() => setError('')}>
              {t('common.close')}
            </button>
          </span>
        </p>
      )}
      {staleNotice && (
        <p role="status" className="bookshelf-banner bookshelf-banner-notice">
          <span>{staleNotice}</span>
          <button type="button" onClick={() => setStaleNotice('')}>
            {t('common.close')}
          </button>
        </p>
      )}
      {selected ? (
        <div className="book-detail">
          <div className="book-detail-hero">
            <div className="book-detail-cover" aria-hidden="true">
              {selected.has_cover ? (
                <img src={`/api/v1/books/${selected.id}/cover`} alt="" />
              ) : (
                <span className="book-cover-monogram">{selected.title.slice(0, 1)}</span>
              )}
            </div>
            <div className="book-detail-main">
              <h1>{selected.title}</h1>
              {selected.subtitle && <p className="book-detail-subtitle">{selected.subtitle}</p>}
              {selectedMeta && <p className="book-detail-meta">{selectedMeta}</p>}
              <nav className="book-detail-actions" aria-label={t('bookshelf.title')}>
                {selected.has_ebook && (
                  <button
                    ref={readActionRef}
                    type="button"
                    className="primary"
                    aria-pressed={reading}
                    onClick={() => enterReading(selected, readingProgress?.completed ? 0 : null)}
                  >
                    {t(
                      readingProgress?.completed
                        ? 'bookshelf.readAgain'
                        : readingProgress
                          ? 'bookshelf.continueReading'
                          : 'bookshelf.read',
                    )}
                  </button>
                )}
                {selected.has_audiobook && (
                  <button
                    type="button"
                    className={!selected.has_ebook ? 'primary' : undefined}
                    aria-pressed={isSelectedPlaying}
                    onClick={() => {
                      if (isSelectedAudioLoaded) {
                        audioSession.togglePlay();
                      } else {
                        audioSession.open(
                          selected,
                          true,
                          savedListeningProgress?.completed ? 0 : undefined,
                        );
                      }
                    }}
                  >
                    {t(
                      isSelectedPlaying
                        ? 'bookshelf.pauseListening'
                        : isSelectedAudioLoaded
                          ? 'bookshelf.continueListening'
                          : savedListeningProgress?.completed
                            ? 'bookshelf.listenAgain'
                            : savedListeningProgress
                              ? 'bookshelf.continueListening'
                              : 'bookshelf.listen',
                    )}
                  </button>
                )}
                {selected.has_ebook && (
                  <a
                    className="book-action-link"
                    href={`/api/v1/books/${selected.id}/ebook/download`}
                  >
                    {t('bookshelf.download')}
                  </a>
                )}
                {(canEdit || canUpload) && (
                  <button
                    type="button"
                    aria-expanded={showBookEdit}
                    onClick={() => setShowBookEdit(!showBookEdit)}
                  >
                    {t('bookshelf.editBook')}
                  </button>
                )}
              </nav>
              {(readingProgress || listeningProgress) && (
                <ul className="book-carrier-progress">
                  {readingProgress && (
                    <li>
                      {t('bookshelf.readingSummary', {
                        chapter: readingProgress.chapter_title || t('bookshelf.ebook'),
                        percent: Math.round(readingProgress.overall_ratio * 100),
                      })}
                    </li>
                  )}
                  {listeningProgress && (
                    <li>
                      {t('bookshelf.listeningSummary', {
                        chapter: listeningProgress.chapter_title || t('bookshelf.audiobook'),
                        percent: Math.round(listeningProgress.overall_ratio * 100),
                      })}
                    </li>
                  )}
                </ul>
              )}
              {showAudioAlignment && (
                <BookAlignmentNotice
                  source="reading"
                  progress={readingProgress}
                  onAlign={alignAudio}
                  onDismiss={() => setDismissedAlignment(alignmentKey)}
                  disabled={!audioChapters?.length}
                />
              )}
            </div>
          </div>
          {showBookEdit && (canEdit || canUpload) && (
            <div className="book-edit-panel">
              {canEdit && (
                <form
                  key={selected.id}
                  className="book-edit-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const next = titleDraft.trim();
                    if (!next) return;
                    void write(async () => {
                      await api(`/books/${selected.id}/metadata`, {
                        method: 'PATCH',
                        body: JSON.stringify({ title: next }),
                      });
                      setSelected({ ...selected, title: next });
                    });
                  }}
                >
                  <label className="book-edit-field">
                    <span className="book-edit-label">{t('bookshelf.bookTitle')}</span>
                    <input
                      name="title"
                      required
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.currentTarget.value)}
                    />
                  </label>
                  <div className="book-edit-row-actions">
                    <button type="submit" disabled={pending || !titleDraft.trim()}>
                      {t('bookshelf.save')}
                    </button>
                  </div>
                </form>
              )}
              {canEdit && (
                <div className="book-edit-row book-edit-row-stack">
                  <div className="book-edit-row-controls">
                    <div
                      className="source-checkbox-group"
                      role="group"
                      aria-label={t('bookshelf.metadataSearch')}
                    >
                      <span className="source-checkbox-title">{t('bookshelf.metadataSearch')}</span>
                      <div className="source-checkbox-list">
                        {enabledSources.map((source) => (
                          <label className="check-label" key={source.id}>
                            <input
                              type="checkbox"
                              checked={checkedSources.includes(source.id)}
                              onChange={(event) =>
                                setCheckedSources((prev) =>
                                  event.target.checked
                                    ? [...prev, source.id]
                                    : prev.filter((item) => item !== source.id),
                                )
                              }
                            />
                            {source.name}
                          </label>
                        ))}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={pending || !checkedSources.length}
                      onClick={() =>
                        void write(async () => {
                          const selectedIds = enabledSources
                            .map((item) => item.id)
                            .filter((id) => checkedSources.includes(id));
                          const query = titleDraft.trim();
                          const qs = new URLSearchParams({
                            sources: selectedIds.join(','),
                            ...(query ? { q: query } : {}),
                          });
                          const result = await api<{ items: Candidate[] }>(
                            `/books/${selected.id}/metadata/search?${qs.toString()}`,
                          );
                          setCandidates(result.items);
                        })
                      }
                    >
                      {t('bookshelf.search')}
                    </button>
                  </div>
                  {candidates?.length === 0 && <p role="status">{t('bookshelf.metadataEmpty')}</p>}
                  {!!candidates?.length && (
                    <ul className="bookshelf-grid book-candidate-grid">
                      {candidates.map((candidate) => (
                        <li
                          key={candidate.provider + candidate.external_id + candidate.fields.title}
                        >
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() =>
                              void write(async () => {
                                await api(`/books/${selected.id}/metadata`, {
                                  method: 'PATCH',
                                  body: JSON.stringify(candidate.fields),
                                });
                                setSelected(await api<Book>(`/books/${selected.id}`));
                                setCandidates(null);
                              })
                            }
                          >
                            <div className="bookshelf-card-body">
                              <strong>{candidate.fields.title}</strong>
                              <span className="bookshelf-card-authors">
                                {[
                                  candidate.fields.authors?.join(', '),
                                  candidate.provider_name || candidate.provider,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </span>
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {canUpload && (
                <div className="book-edit-row">
                  <span className="book-edit-label">{t('bookshelf.cover')}</span>
                  <input
                    ref={coverInputRef}
                    className="sr-only"
                    type="file"
                    tabIndex={-1}
                    aria-hidden="true"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = '';
                      if (file) void uploadCoverFile(file, selected);
                    }}
                  />
                  <div className="book-edit-row-actions">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => coverInputRef.current?.click()}
                    >
                      {t('bookshelf.changeCover')}
                    </button>
                  </div>
                </div>
              )}
              {canUpload &&
                selectedLibrary?.ebook_upload_enabled !== false &&
                !selected.has_ebook && (
                  <div className="book-edit-row">
                    <span className="book-edit-label">{t('bookshelf.ebook')}</span>
                    <input
                      ref={attachEbookInputRef}
                      className="sr-only"
                      type="file"
                      tabIndex={-1}
                      aria-hidden="true"
                      accept=".epub,.txt,application/epub+zip,text/plain"
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = '';
                        if (file) void uploadEbookFile(file, selected);
                      }}
                    />
                    <div className="book-edit-row-actions">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => attachEbookInputRef.current?.click()}
                      >
                        {uploading ? t('bookshelf.uploading') : t('bookshelf.upload')}
                      </button>
                    </div>
                  </div>
                )}
              {canUpload &&
                ((selected.has_ebook && selected.has_audiobook) || pairableBooks.length > 0) && (
                  <div className="book-edit-row">
                    {selected.has_ebook && selected.has_audiobook ? (
                      <>
                        <span className="book-edit-label">{t('bookshelf.carrierSplitLabel')}</span>
                        <span className="muted book-edit-hint">
                          {t('bookshelf.carrierMergedHint')}
                        </span>
                        <div className="book-edit-row-actions">
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() =>
                              void write(async () => {
                                await api(`/books/${selected.id}/split`, {
                                  method: 'POST',
                                  body: JSON.stringify({ carrier: 'audiobook' }),
                                });
                                setSelected(await api<Book>(`/books/${selected.id}`));
                              })
                            }
                          >
                            {t('bookshelf.splitFormats')}
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="book-edit-label">{t('bookshelf.carrierPairLabel')}</span>
                        <form
                          className="book-edit-inline-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const other = new FormData(event.currentTarget).get('book');
                            void write(async () => {
                              await api(`/books/${selected.id}/pair`, {
                                method: 'POST',
                                body: JSON.stringify({ other_book_id: other }),
                              });
                              setSelected(await api<Book>(`/books/${selected.id}`));
                            });
                          }}
                        >
                          <select name="book" required aria-label={t('bookshelf.carrierPairLabel')}>
                            <option value="">
                              {t(
                                selected.has_audiobook
                                  ? 'bookshelf.selectEbookToMerge'
                                  : 'bookshelf.selectAudiobookToMerge',
                              )}
                            </option>
                            {pairableBooks.map((book) => (
                              <option key={book.id} value={book.id}>
                                {book.title}
                              </option>
                            ))}
                          </select>
                          <button type="submit" disabled={pending}>
                            {t('bookshelf.pairAction')}
                          </button>
                        </form>
                      </>
                    )}
                  </div>
                )}
            </div>
          )}
          {(selected.has_audiobook || selected.has_ebook) && (
            <section className="book-chapters-section">
              <div className="book-chapters-header">
                {selected.has_ebook && selected.has_audiobook ? (
                  <div
                    className="book-segmented"
                    role="tablist"
                    aria-label={t('bookshelf.chapters')}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={chapterTab === 'audio'}
                      onClick={() => setChapterTab('audio')}
                    >
                      {t('bookshelf.audioChapters', {
                        count: displayedAudioChapters?.length ?? 0,
                      })}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={chapterTab === 'ebook'}
                      onClick={() => setChapterTab('ebook')}
                    >
                      {t('bookshelf.ebookContents', { count: ebookChapters?.length ?? 0 })}
                    </button>
                  </div>
                ) : (
                  <>
                    <h2>
                      {t(selected.has_audiobook ? 'bookshelf.chapters' : 'bookshelf.contents')}
                    </h2>
                    <span className="muted tnum">
                      {t('bookshelf.chapterCount', {
                        count:
                          (showAudioChapters ? displayedAudioChapters : ebookChapters)?.length ?? 0,
                      })}
                    </span>
                  </>
                )}
              </div>
              {showAudioChapters ? (
                displayedAudioChapters === null ? (
                  <p role="status" className="muted">
                    {t('bookshelf.loading')}
                  </p>
                ) : displayedAudioChapters.length === 0 ? (
                  <p role="status" className="muted">
                    {t('bookshelf.empty')}
                  </p>
                ) : (
                  <ol className="book-detail-chapter-list">
                    {displayedAudioChapters.map((chapter) => {
                      const isActiveChapter =
                        audioSession.book?.id === selected.id &&
                        audioSession.index === chapter.chapter_index;
                      const editing = editingChapterIndex === chapter.chapter_index;
                      return (
                        <li
                          key={chapter.chapter_index}
                          className={`book-detail-chapter-row ${isActiveChapter ? 'is-active' : ''}`}
                        >
                          {editing ? (
                            <form
                              className="book-chapter-inline-edit"
                              onSubmit={(event) => {
                                event.preventDefault();
                                const title = String(
                                  new FormData(event.currentTarget).get('title') || '',
                                ).trim();
                                if (!title) return;
                                void api<Pick<AudioChapter, 'chapter_index' | 'title'>>(
                                  `/books/${selected.id}/audiobook/chapters/${chapter.chapter_index}`,
                                  { method: 'PATCH', body: JSON.stringify({ title }) },
                                )
                                  .then((edited) => {
                                    setAudioChapters(
                                      (items) =>
                                        items?.map((item) =>
                                          item.chapter_index === edited.chapter_index
                                            ? { ...item, title: edited.title }
                                            : item,
                                        ) ?? null,
                                    );
                                    if (audioSession.book?.id === selected.id) {
                                      audioSession.renameChapter(
                                        edited.chapter_index,
                                        edited.title,
                                      );
                                    }
                                    setEditingChapterIndex(null);
                                  })
                                  .catch((cause: Error) => setError(cause.message));
                              }}
                            >
                              <input
                                name="title"
                                aria-label={t('bookshelf.chapterTitle')}
                                required
                                maxLength={4096}
                                defaultValue={chapter.title}
                              />
                              <div className="book-chapter-inline-actions">
                                <button type="submit">{t('bookshelf.save')}</button>
                                <button type="button" onClick={() => setEditingChapterIndex(null)}>
                                  {t('bookshelf.cancel')}
                                </button>
                              </div>
                            </form>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="book-detail-chapter-play"
                                onClick={() =>
                                  audioSession.open(selected, true, chapter.chapter_index)
                                }
                              >
                                <span className="book-detail-chapter-num tnum">
                                  {isActiveChapter && audioSession.playing
                                    ? '▶'
                                    : String(chapter.chapter_index + 1).padStart(2, '0')}
                                </span>
                                <span className="book-detail-chapter-title">{chapter.title}</span>
                                <time className="book-detail-chapter-duration tnum">
                                  {time(chapter.duration_ms / 1000)}
                                </time>
                              </button>
                              {canEdit && (
                                <button
                                  type="button"
                                  className="book-chapter-edit-btn"
                                  aria-label={`${t('bookshelf.editChapter')} ${chapter.title}`}
                                  title={t('bookshelf.editChapter')}
                                  onClick={() => setEditingChapterIndex(chapter.chapter_index)}
                                >
                                  <Icon name="edit" />
                                </button>
                              )}
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )
              ) : ebookChapters === null ? (
                <p role="status" className="muted">
                  {t('bookshelf.loading')}
                </p>
              ) : ebookChapters.length === 0 ? (
                <p role="status" className="muted">
                  {t('bookshelf.empty')}
                </p>
              ) : (
                <ol className="book-detail-chapter-list">
                  {ebookChapters.map((chapter) => (
                    <li key={chapter.spine_index} className="book-detail-chapter-row">
                      <button
                        type="button"
                        className="book-detail-chapter-play"
                        onClick={() => enterReading(selected, chapter.spine_index)}
                      >
                        <span className="book-detail-chapter-num tnum">
                          {String(chapter.spine_index + 1).padStart(2, '0')}
                        </span>
                        <span className="book-detail-chapter-title">{chapter.title}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
        </div>
      ) : (
        <>
          <div className="bookshelf-controls bookshelf-filter-bar">
            {!loading && resume && (
              <button
                type="button"
                className="primary bookshelf-resume-btn"
                title={t(
                  resume.resume_kind === 'reading'
                    ? 'bookshelf.resumeReading'
                    : 'bookshelf.resumeListening',
                  { title: resume.title },
                )}
                onClick={() => {
                  changeBook(resume);
                  if (resume.resume_kind === 'reading') enterReading(resume);
                  else {
                    audioSession.open(resume, true);
                    setListening(true);
                  }
                }}
              >
                {t(
                  resume.resume_kind === 'reading'
                    ? 'bookshelf.resumeReading'
                    : 'bookshelf.resumeListening',
                  { title: resume.title },
                )}
              </button>
            )}
            <select
              aria-label={t('bookshelf.library')}
              value={libraryId}
              onChange={(event) => setLibraryId(event.target.value)}
            >
              <option value="">{t('bookshelf.allLibraries')}</option>
              {libraries.map((library) => (
                <option key={library.id} value={library.id}>
                  {library.name}
                </option>
              ))}
            </select>
            <input
              ref={searchRef}
              type="search"
              aria-label={t('bookshelf.find')}
              placeholder={t('bookshelf.find')}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <select
              aria-label={t('bookshelf.format')}
              value={format}
              onChange={(event) => setFormat(event.target.value)}
            >
              <option value="all">{t('bookshelf.allFormats')}</option>
              <option value="ebook">{t('bookshelf.ebook')}</option>
              <option value="audio">{t('bookshelf.audiobook')}</option>
            </select>
            <select
              aria-label={t('bookshelf.status')}
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="all">{t('bookshelf.allStatuses')}</option>
              <option value="unread">{t('bookshelf.unread')}</option>
              <option value="in_progress">{t('bookshelf.inProgress')}</option>
              <option value="finished">{t('bookshelf.finished')}</option>
            </select>
          </div>
          {loading ? (
            <div className="bookshelf-loading">
              <p role="status" className="muted">
                {t('bookshelf.loading')}
              </p>
              <ul className="bookshelf-grid" aria-hidden="true">
                {[0, 1, 2, 3, 4, 5].map((skeleton) => (
                  <li key={skeleton} className="bookshelf-skeleton-card" />
                ))}
              </ul>
            </div>
          ) : visible.length ? (
            <>
              <ul className="bookshelf-grid">
                {visible.map((book) => (
                  <li key={book.id}>
                    <button type="button" data-book-id={book.id} onClick={() => changeBook(book)}>
                      <div className="bookshelf-card-cover" aria-hidden="true">
                        {book.has_cover ? (
                          <img src={`/api/v1/books/${book.id}/cover`} alt="" loading="lazy" />
                        ) : (
                          <span className="book-cover-monogram">{book.title.slice(0, 1)}</span>
                        )}
                      </div>
                      <div className="bookshelf-card-body">
                        <strong>{book.title}</strong>
                        {book.subtitle && <span>{book.subtitle}</span>}
                        {!!book.authors?.length && (
                          <span className="bookshelf-card-authors">{book.authors.join(' · ')}</span>
                        )}
                        <small>
                          {[
                            book.has_ebook && t('bookshelf.ebook'),
                            book.has_audiobook && t('bookshelf.audiobook'),
                            progressLabel(t, book.progress_status),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </small>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              {hasMore && (
                <div className="bookshelf-pagination">
                  <button type="button" disabled={loadingMore} onClick={() => void loadMoreBooks()}>
                    {loadingMore ? t('bookshelf.loadingMore') : t('bookshelf.loadMore')}
                  </button>
                </div>
              )}
            </>
          ) : (
            !error && (
              <p className="workspace-empty">
                {libraries.length
                  ? t('bookshelf.empty')
                  : t(owner ? 'bookshelf.emptyOwner' : 'bookshelf.noPermission')}
              </p>
            )
          )}
        </>
      )}
    </section>
  );
}
