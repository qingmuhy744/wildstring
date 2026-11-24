import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { BookReader, BookAudio, type Book } from './book-reader';
import './bookshelf.css';

interface Library {
  id: string;
  name: string;
  storage_mode: 'copy' | 'hardlink';
  version: number;
}
interface Candidate {
  provider: string;
  external_id: string;
  fields: { title: string; authors?: string[]; published_year?: number };
}
interface Job {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  copied_files: number;
  relinked_files: number;
  reclaimed_bytes: number;
  kept_standalone_files: number;
  sidecars_written: number;
  error?: string;
}

export function readingBookId() {
  return /^\/books\/([a-zA-Z0-9_-]+)\/read\/?$/.exec(window.location.pathname)?.[1];
}

export function Bookshelf({
  owner,
  canEdit,
  canUpload,
  musicPlaying,
  onPlayAudio,
}: {
  owner: boolean;
  canEdit: boolean;
  canUpload: boolean;
  musicPlaying: boolean;
  onPlayAudio: () => void;
}) {
  const { t } = useTranslation();
  const [libraryId, setLibraryId] = useState('');
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [books, setBooks] = useState<Book[] | null>(null);
  const [selected, setSelected] = useState<Book | null>(null);
  const [reading, setReading] = useState(false);
  const [listening, setListening] = useState(false);
  const [filter, setFilter] = useState('');
  const [format, setFormat] = useState('all');
  const [status, setStatus] = useState('all');
  const [notice, setNotice] = useState('');
  const [migrationError, setMigrationError] = useState('');
  const [exported, setExported] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [revision, refresh] = useState(0);
  const [showManage, setManage] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [provider, setProvider] = useState('openlibrary');
  const readerDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = readerDialog.current;
    if (reading && dialog && !dialog.open) dialog.showModal();
  }, [reading]);

  const selection = libraries.find((library) => library.id === libraryId);

  useEffect(() => {
    const request = new AbortController();
    setLoading(true);
    setError('');
    void Promise.all([
      api<{ items: Library[] }>('/book-libraries', { signal: request.signal }),
      api<{ items: Book[] }>(
        `/books?limit=100${libraryId ? `&library_id=${encodeURIComponent(libraryId)}` : ''}`,
        { signal: request.signal },
      ),
    ])
      .then(([nextLibraries, nextBooks]) => {
        setLibraries(nextLibraries.items);
        setBooks(nextBooks.items);
      })
      .catch((cause: Error) => {
        if (!request.signal.aborted) setError(cause.message);
      })
      .finally(() => {
        if (!request.signal.aborted) setLoading(false);
      });
    return () => request.abort();
  }, [libraryId, revision]);

  useEffect(() => {
    if (!owner || !showManage || !libraryId) {
      setJobs([]);
      return;
    }
    const request = new AbortController();
    const load = () =>
      void api<{ items: Job[] }>(`/book-libraries/${libraryId}/migrations`, {
        signal: request.signal,
      })
        .then((result) => {
          setJobs(result.items);
        })
        .catch((cause: Error) => {
          if (!request.signal.aborted) setError(cause.message);
        });
    load();
    const timer = window.setInterval(load, 2500);
    return () => {
      request.abort();
      window.clearInterval(timer);
    };
  }, [libraryId, owner, revision, showManage]);

  useEffect(() => {
    const request = new AbortController();
    const route = () => {
      const identity = readingBookId();
      if (!identity) {
        setReading(false);
        return;
      }
      void api<Book>(`/books/${identity}`, { signal: request.signal })
        .then((book) => {
          setSelected(book);
          setReading(book.has_ebook);
        })
        .catch((cause: Error) => {
          if (!request.signal.aborted) setError(cause.message);
        });
    };
    route();
    window.addEventListener('popstate', route);
    return () => {
      request.abort();
      window.removeEventListener('popstate', route);
    };
  }, []);

  function enterReading(book: Book) {
    setReading(true);
    if (readingBookId() !== book.id) {
      window.history.pushState({ bookReader: true }, '', `/books/${book.id}/read`);
    }
  }

  function closeReader() {
    setReading(false);
    setSelected(null);
    setListening(false);
    refresh((value) => value + 1);
    if (window.history.state?.bookReader) {
      window.history.back();
    } else if (readingBookId()) {
      window.history.replaceState(null, '', '/');
    }
  }

  async function write(operation: () => Promise<void>, reportError = setError) {
    setError('');
    setNotice('');
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
    setReading(false);
    setListening(false);
    setSelected(book);
    setCandidates(null);
    if (!book) refresh((value) => value + 1);
  }

  function createLibrary(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const managed = String(fields.get('managed_root') || '').trim();
    const roots = String(fields.get('source_roots') || '')
      .split('\n')
      .map((root) => root.trim())
      .filter(Boolean);
    void write(async () => {
      const created = await api<Library>('/book-libraries', {
        method: 'POST',
        body: JSON.stringify({
          name: fields.get('name'),
          source_roots: roots,
          ...(managed ? { managed_root: managed } : {}),
          storage_mode: fields.get('storage_mode'),
          default_access: fields.get('default_access'),
        }),
      });
      setLibraryId(created.id);
    });
  }

  function upload(event: FormEvent<HTMLFormElement>, attach?: Book) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    if (attach) fields.delete('library_id');
    void write(async () => {
      const result = await api<{ id: string }>(
        attach ? `/books/${attach.id}/ebook` : '/books/upload',
        {
          method: 'POST',
          body: fields,
        },
      );
      changeBook(await api<Book>(`/books/${result.id}`));
    });
  }

  function startMigration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selection) return;
    const values = new FormData(event.currentTarget);
    const path = String(values.get('managed_root') || '').trim();
    setMigrationError('');
    void write(async () => {
      await api(`/book-libraries/${selection.id}/migrations`, {
        method: 'POST',
        body: JSON.stringify({
          version: selection.version,
          target_storage_mode: values.get('target_storage_mode'),
          ...(path ? { managed_root: path } : {}),
        }),
      });
    }, setMigrationError);
  }

  const visible = (books || []).filter(
    (book) =>
      (format === 'all' || (format === 'ebook' ? book.has_ebook : book.has_audiobook)) &&
      (status === 'all' || status === book.progress_status) &&
      `${book.title} ${book.subtitle || ''}`
        .toLocaleLowerCase()
        .includes(filter.toLocaleLowerCase()),
  );

  const resume =
    !filter && format === 'all' && status === 'all'
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
        <header>
          <button onClick={closeReader}>{t('bookshelf.back')}</button>
          <strong>{selected.title}</strong>
          {selected.has_audiobook && (
            <button aria-pressed={listening} onClick={() => setListening(!listening)}>
              {t('bookshelf.listen')}
            </button>
          )}
        </header>
        {listening && (
          <BookAudio
            key={selected.id}
            book={selected}
            activeElsewhere={musicPlaying}
            canEdit={canEdit}
            onPlay={onPlayAudio}
          />
        )}
        <BookReader key={selected.id} book={selected} />
      </dialog>
    );
  }

  return (
    <section className="workspace-page bookshelf">
      <header className="workspace-heading">
        <h1>{selected?.title || t('bookshelf.title')}</h1>
        {selected ? (
          <button onClick={() => changeBook(null)}>{t('bookshelf.back')}</button>
        ) : owner ? (
          <button aria-expanded={showManage} onClick={() => setManage(!showManage)}>
            {t('bookshelf.manage')}
          </button>
        ) : null}
      </header>
      {error && (
        <p role="alert">
          {error}{' '}
          <button onClick={() => refresh((value) => value + 1)}>{t('bookshelf.retry')}</button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {selected ? (
        <>
          <nav className="bookshelf-controls" aria-label={t('bookshelf.title')}>
            {selected.has_ebook && (
              <button aria-pressed={reading} onClick={() => enterReading(selected)}>
                {t('bookshelf.read')}
              </button>
            )}
            {selected.has_audiobook && (
              <button aria-pressed={listening} onClick={() => setListening(!listening)}>
                {t('bookshelf.listen')}
              </button>
            )}
            {selected.has_ebook && (
              <a href={`/api/v1/books/${selected.id}/ebook/download`}>{t('bookshelf.download')}</a>
            )}
          </nav>
          {canEdit && !reading && !listening && (
            <form
              key={selected.id}
              className="bookshelf-controls"
              onSubmit={(event) => {
                event.preventDefault();
                const next = String(new FormData(event.currentTarget).get('title') || '').trim();
                void write(async () => {
                  await api(`/books/${selected.id}/metadata`, {
                    method: 'PATCH',
                    body: JSON.stringify({ title: next }),
                  });
                  setSelected({ ...selected, title: next });
                });
              }}
            >
              <label>
                {t('bookshelf.bookTitle')}{' '}
                <input name="title" required defaultValue={selected.title} />
              </label>
              <button disabled={pending}>{t('bookshelf.save')}</button>
            </form>
          )}
          {canEdit && !reading && !listening && (
            <details>
              <summary>{t('bookshelf.metadataSearch')}</summary>
              <div className="bookshelf-controls">
                <select
                  aria-label={t('bookshelf.metadataSearch')}
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                >
                  <option value="openlibrary">Open Library</option>
                  <option value="google_books">Google Books</option>
                  <option value="itunes">Apple iTunes</option>
                </select>
                <button
                  disabled={pending}
                  onClick={() =>
                    void write(async () => {
                      const result = await api<{ items: Candidate[] }>(
                        `/books/${selected.id}/metadata/search?provider=${provider}`,
                      );
                      setCandidates(result.items);
                    })
                  }
                >
                  {t('bookshelf.search')}
                </button>
              </div>
              {candidates?.length === 0 && <p role="status">{t('bookshelf.empty')}</p>}
              {!!candidates?.length && (
                <ul className="bookshelf-grid">
                  {candidates.map((candidate) => (
                    <li key={candidate.external_id + candidate.fields.title}>
                      <button
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
                        <strong>{candidate.fields.title}</strong>
                        <span>{candidate.fields.authors?.join(', ')}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
          {canUpload && !reading && !listening && (
            <details>
              <summary>{t('bookshelf.carriers')}</summary>
              <div className="bookshelf-controls">
                {selected.has_ebook && selected.has_audiobook ? (
                  <button
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
                    {t('bookshelf.split')}
                  </button>
                ) : (
                  <form
                    className="bookshelf-controls"
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
                    <select name="book" required aria-label={t('bookshelf.pair')}>
                      <option value="">{t('bookshelf.pair')}</option>
                      {(books || [])
                        .filter(
                          (book) =>
                            book.id !== selected.id &&
                            book.library_id === selected.library_id &&
                            book.has_ebook !== selected.has_ebook &&
                            book.has_audiobook !== selected.has_audiobook,
                        )
                        .map((book) => (
                          <option key={book.id} value={book.id}>
                            {book.title}
                          </option>
                        ))}
                    </select>
                    <button disabled={pending}>{t('bookshelf.pair')}</button>
                  </form>
                )}
                <form
                  className="bookshelf-controls"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const body = new FormData(event.currentTarget);
                    void write(async () => {
                      await api(`/books/${selected.id}/cover`, { method: 'POST', body });
                    });
                  }}
                >
                  <label>
                    {t('bookshelf.cover')}{' '}
                    <input
                      type="file"
                      name="file"
                      accept="image/jpeg,image/png,image/webp"
                      required
                    />
                  </label>
                  <button disabled={pending}>{t('bookshelf.save')}</button>
                </form>
              </div>
            </details>
          )}
          {canUpload && !selected.has_ebook && (
            <form className="bookshelf-controls" onSubmit={(event) => upload(event, selected)}>
              <label>
                {t('bookshelf.ebook')}{' '}
                <input
                  name="file"
                  type="file"
                  required
                  accept=".epub,.txt,application/epub+zip,text/plain"
                />
              </label>
              <button disabled={pending}>{t('bookshelf.upload')}</button>
            </form>
          )}
          {listening && (
            <BookAudio
              key={selected.id}
              book={selected}
              activeElsewhere={musicPlaying}
              canEdit={canEdit}
              onPlay={onPlayAudio}
            />
          )}
        </>
      ) : (
        <>
          <div className="bookshelf-controls">
            <select
              aria-label={t('bookshelf.library')}
              value={libraryId}
              onChange={(event) => {
                setLibraryId(event.target.value);
                setMigrationError('');
                setExported(null);
              }}
            >
              <option value="">{t('bookshelf.allLibraries')}</option>
              {libraries.map((library) => (
                <option key={library.id} value={library.id}>
                  {library.name}
                </option>
              ))}
            </select>
            <input
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
          {showManage && owner && (
            <div className="bookshelf-management">
              <details open={!libraries.length}>
                <summary>{t('bookshelf.create')}</summary>
                <form className="bookshelf-form" onSubmit={createLibrary}>
                  <label>
                    {t('bookshelf.name')} <input required name="name" />
                  </label>
                  <label>
                    {t('bookshelf.sources')} <textarea name="source_roots" rows={2} />
                  </label>
                  <label>
                    {t('bookshelf.managedRoot')} <input name="managed_root" />
                  </label>
                  <label>
                    {t('bookshelf.storage')}{' '}
                    <select name="storage_mode">
                      <option value="copy">{t('bookshelf.copy')}</option>
                      <option value="hardlink">{t('bookshelf.hardlink')}</option>
                    </select>
                  </label>
                  <label>
                    {t('bookshelf.access')}{' '}
                    <select name="default_access">
                      <option value="restricted">{t('bookshelf.restricted')}</option>
                      <option value="all">{t('bookshelf.shared')}</option>
                    </select>
                  </label>
                  <button disabled={pending}>{t('bookshelf.create')}</button>
                </form>
              </details>
              {selection && (
                <>
                  <div className="bookshelf-controls">
                    <button
                      disabled={pending}
                      onClick={() =>
                        void write(async () => {
                          const result = await api<{ status: string }>(
                            `/book-libraries/${selection.id}/scan`,
                            { method: 'POST', timeoutMs: 0 },
                          );
                          setNotice(
                            result.status === 'completed'
                              ? t('bookshelf.scanned')
                              : t('bookshelf.scanErrors'),
                          );
                        })
                      }
                    >
                      {t('bookshelf.scan')}
                    </button>
                    <button
                      disabled={pending}
                      onClick={() =>
                        void write(async () => {
                          const result = await api<{ sidecars_written: number }>(
                            `/book-libraries/${selection.id}/export-sidecars`,
                            { method: 'POST', timeoutMs: 0 },
                          );
                          setExported(result.sidecars_written);
                        })
                      }
                    >
                      {t('bookshelf.export')}
                    </button>
                    {exported !== null && (
                      <span role="status">{t('bookshelf.exported', { count: exported })}</span>
                    )}
                  </div>
                  <details>
                    <summary>{t('bookshelf.migrate')}</summary>
                    <form className="bookshelf-form" onSubmit={startMigration}>
                      <label>
                        {t('bookshelf.storage')}{' '}
                        <select
                          key={selection.id}
                          name="target_storage_mode"
                          defaultValue={selection.storage_mode === 'copy' ? 'hardlink' : 'copy'}
                        >
                          <option value="copy">{t('bookshelf.copy')}</option>
                          <option value="hardlink">{t('bookshelf.hardlink')}</option>
                        </select>
                      </label>
                      <label>
                        {t('bookshelf.managedRoot')} <input name="managed_root" />
                      </label>
                      {migrationError && <p role="alert">{migrationError}</p>}
                      <button disabled={pending}>{t('bookshelf.migrate')}</button>
                    </form>
                    {jobs.map((job) => (
                      <div key={job.id} className="bookshelf-controls" role="status">
                        <span>{t(`bookshelf.job.${job.status}`)}</span>
                        <span>{t('bookshelf.relinked', { count: job.relinked_files })}</span>
                        <span>
                          {t('bookshelf.estimate', { bytes: job.reclaimed_bytes.toLocaleString() })}
                        </span>
                        <span>{t('bookshelf.retained', { count: job.kept_standalone_files })}</span>
                        <span>{t('bookshelf.exported', { count: job.sidecars_written })}</span>
                        {job.error && (
                          <span>{t(`errors.${job.error}`, { defaultValue: job.error })}</span>
                        )}
                        {job.status === 'failed' && (
                          <button
                            disabled={pending}
                            onClick={() =>
                              void write(async () => {
                                await api(
                                  `/book-libraries/${selection.id}/migrations/${job.id}/retry`,
                                  { method: 'POST' },
                                );
                              })
                            }
                          >
                            {t('bookshelf.retry')}
                          </button>
                        )}
                      </div>
                    ))}
                  </details>
                </>
              )}
            </div>
          )}
          {canUpload && selection && (
            <form className="bookshelf-controls" onSubmit={upload}>
              <input type="hidden" name="library_id" value={selection.id} />
              <label>
                {t('bookshelf.ebook')}{' '}
                <input
                  name="file"
                  type="file"
                  required
                  accept=".epub,.txt,application/epub+zip,text/plain"
                />
              </label>
              <button disabled={pending}>{t('bookshelf.upload')}</button>
            </form>
          )}
          {!loading && resume && (
            <p>
              <button
                onClick={() => {
                  changeBook(resume);
                  if (resume.resume_kind === 'reading') enterReading(resume);
                  else setListening(true);
                }}
              >
                {t(
                  resume.resume_kind === 'reading'
                    ? 'bookshelf.resumeReading'
                    : 'bookshelf.resumeListening',
                  { title: resume.title },
                )}
              </button>
            </p>
          )}
          {loading ? (
            <p role="status">{t('bookshelf.loading')}</p>
          ) : visible.length ? (
            <ul className="bookshelf-grid">
              {visible.map((book) => (
                <li key={book.id}>
                  <button onClick={() => changeBook(book)}>
                    <strong>{book.title}</strong>
                    {book.subtitle && <span>{book.subtitle}</span>}
                    <small>
                      {[
                        book.has_ebook && t('bookshelf.ebook'),
                        book.has_audiobook && t('bookshelf.audiobook'),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
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
