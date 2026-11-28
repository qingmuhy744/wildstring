import { useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import './book-intake.css';

const statuses = ['pending', 'ignored', 'absorbed_description', 'imported_ebook', 'all'] as const;
type Filter = (typeof statuses)[number];
type Action = 'absorb_description' | 'import_ebook' | 'ignore';
type Resolution = { action: Action; book_id?: string; description?: string; add_pattern?: string };

interface SkippedFile {
  id: string;
  book_id: string | null;
  relative_path: string;
  status: Exclude<Filter, 'all'>;
  preview_text: string;
  cleaned_preview: string;
}

interface SkippedPage {
  items: SkippedFile[];
  total: number;
  pending_count: number;
}

interface BookTarget {
  id: string;
  title: string;
  has_ebook: boolean;
}

const pageSize = 25;

function SkippedFileRow({
  item,
  libraryId,
  detail,
  resolve,
  busy,
}: {
  item: SkippedFile;
  libraryId: string;
  detail?: { id: string; hasEbook: boolean };
  resolve: (resolution: Resolution) => Promise<void>;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [raw, setRaw] = useState(false);
  const [action, setAction] = useState<Exclude<Action, 'ignore'> | null>(null);
  const [description, setDescription] = useState('');
  const [target, setTarget] = useState('');
  const [chooseTarget, setChooseTarget] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<BookTarget[] | null>(null);
  const [searchError, setSearchError] = useState('');
  const preview = raw ? item.preview_text : item.cleaned_preview;
  const fileName = item.relative_path.slice(item.relative_path.lastIndexOf('/') + 1);
  const filenamePattern = fileName.replace(/[\[*?]/g, (char) => `[${char}]`);
  const needsPicker = !!action && !detail && chooseTarget;
  const search = needsPicker ? query.trim() : '';

  useEffect(() => {
    setMatches(null);
    setSearchError('');
    if (!search) return;
    const request = new AbortController();
    const params = new URLSearchParams({ library_id: libraryId, q: search, limit: '50' });
    void api<{ items: BookTarget[] }>(`/books?${params}`, { signal: request.signal })
      .then(({ items }) => {
        if (!request.signal.aborted) setMatches(items);
      })
      .catch((cause: Error) => {
        if (!request.signal.aborted) setSearchError(cause.message);
      });
    return () => request.abort();
  }, [libraryId, search]);

  function start(next: Exclude<Action, 'ignore'>) {
    setTarget(
      next === 'absorb_description'
        ? (item.book_id ?? '')
        : detail && !detail.hasEbook
          ? detail.id
          : '',
    );
    setChooseTarget(next === 'absorb_description' && !item.book_id && !detail);
    setQuery('');
    setDescription(item.cleaned_preview || item.preview_text);
    setAction(next);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (action) {
      void resolve({
        action,
        ...(target ? { book_id: target } : {}),
        ...(action === 'absorb_description' ? { description } : {}),
      });
    }
  }

  return (
    <details className="book-intake-file">
      <summary>
        <span>{item.relative_path}</span>
        {item.status !== 'pending' && (
          <small className="muted">{t(`bookshelf.intake.status.${item.status}`)}</small>
        )}
      </summary>
      <div className="book-intake-file-body">
        <div
          className="book-intake-actions"
          role="group"
          aria-label={t('bookshelf.intake.preview')}
        >
          <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>
            {t('bookshelf.intake.cleaned')}
          </button>
          <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>
            {t('bookshelf.intake.original')}
          </button>
        </div>
        <p className="book-intake-preview">{preview || t('bookshelf.intake.emptyPreview')}</p>
        {item.status === 'pending' && (
          <div className="book-intake-actions">
            <button
              type="button"
              disabled={busy}
              aria-expanded={action === 'absorb_description'}
              onClick={() => start('absorb_description')}
            >
              {t('bookshelf.intake.absorb')}
            </button>
            <button
              type="button"
              disabled={busy}
              aria-expanded={action === 'import_ebook'}
              onClick={() => start('import_ebook')}
            >
              {t('bookshelf.intake.import')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void resolve({ action: 'ignore' })}
            >
              {t('bookshelf.intake.ignore')}
            </button>
            {!detail && (
              <button
                type="button"
                disabled={busy || filenamePattern.length > 200}
                onClick={() => void resolve({ action: 'ignore', add_pattern: filenamePattern })}
              >
                {t('bookshelf.intake.ignoreMatching')}
              </button>
            )}
          </div>
        )}
        {item.status === 'pending' && action && (
          <form className="book-intake-confirm" onSubmit={submit}>
            {needsPicker && (
              <>
                <label htmlFor={`${id}-search`}>{t('bookshelf.intake.searchBook')}</label>
                <input
                  id={`${id}-search`}
                  type="search"
                  maxLength={200}
                  value={query}
                  disabled={busy}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setTarget(action === 'absorb_description' ? (item.book_id ?? '') : '');
                  }}
                />
                {searchError ? (
                  <p role="alert" className="error">
                    {searchError}
                  </p>
                ) : search && matches === null ? (
                  <p role="status">{t('bookshelf.loading')}</p>
                ) : search &&
                  !matches?.some((book) => action !== 'import_ebook' || !book.has_ebook) ? (
                  <p className="muted">{t('bookshelf.intake.noBooksFound')}</p>
                ) : null}
              </>
            )}
            {(needsPicker || (detail && action === 'import_ebook')) && (
              <>
                <label htmlFor={`${id}-target`}>{t('bookshelf.intake.targetBook')}</label>
                <select
                  id={`${id}-target`}
                  required={action === 'absorb_description'}
                  value={target}
                  disabled={busy}
                  onChange={(event) => setTarget(event.target.value)}
                >
                  <option value="">
                    {t(
                      action === 'import_ebook'
                        ? 'bookshelf.intake.newBook'
                        : 'bookshelf.intake.chooseBook',
                    )}
                  </option>
                  {detail && !detail.hasEbook && (
                    <option value={detail.id}>{t('bookshelf.intake.thisBook')}</option>
                  )}
                  {!detail && item.book_id && action === 'absorb_description' && (
                    <option value={item.book_id}>{t('bookshelf.intake.directoryBook')}</option>
                  )}
                  {search &&
                    matches
                      ?.filter((book) =>
                        action === 'import_ebook' ? !book.has_ebook : book.id !== item.book_id,
                      )
                      .map((book) => (
                        <option value={book.id} key={book.id}>
                          {book.title}
                        </option>
                      ))}
                </select>
              </>
            )}
            {!detail && !needsPicker && (
              <div className="book-intake-target">
                <span>
                  {t(
                    action === 'import_ebook'
                      ? 'bookshelf.intake.newBook'
                      : 'bookshelf.intake.directoryBook',
                  )}
                </span>
                <button type="button" disabled={busy} onClick={() => setChooseTarget(true)}>
                  {t('bookshelf.intake.changeTarget')}
                </button>
              </div>
            )}
            {action === 'absorb_description' && (
              <>
                <label htmlFor={`${id}-description`}>{t('bookshelf.field.description')}</label>
                <textarea
                  id={`${id}-description`}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={3}
                  maxLength={16000}
                  required
                  disabled={busy}
                />
              </>
            )}
            <div className="book-intake-actions">
              <button
                type="submit"
                className="primary"
                disabled={
                  busy || (action === 'absorb_description' && (!target || !description.trim()))
                }
              >
                {t(
                  action === 'absorb_description'
                    ? 'bookshelf.intake.saveDescription'
                    : 'bookshelf.intake.confirmImport',
                )}
              </button>
              <button type="button" disabled={busy} onClick={() => setAction(null)}>
                {t('common.cancel')}
              </button>
            </div>
          </form>
        )}
      </div>
    </details>
  );
}

export function BookIntakeQueue({
  libraryId,
  detail,
  updateKey,
  onResolved,
}: {
  libraryId: string;
  detail?: { id: string; hasEbook: boolean };
  updateKey?: string;
  onResolved?: (resolution: Resolution) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [filter, setFilter] = useState<Filter>('pending');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<SkippedPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const bookId = detail?.id;
  const path = `/book-libraries/${libraryId}/skipped-files`;

  useEffect(() => {
    const request = new AbortController();
    setLoading(true);
    setError('');
    const params = new URLSearchParams({
      status: filter,
      limit: String(pageSize),
      offset: String(offset),
    });
    if (bookId) params.set('book_id', bookId);
    void api<SkippedPage>(`${path}?${params}`, { signal: request.signal })
      .then((result) => {
        if (request.signal.aborted) return;
        if (offset && offset >= result.total) {
          setOffset(Math.max(0, Math.floor((result.total - 1) / pageSize) * pageSize));
        } else {
          setPage(result);
          setLoading(false);
        }
      })
      .catch((cause: Error) => {
        if (!request.signal.aborted) {
          setError(cause.message);
          setLoading(false);
        }
      });
    return () => request.abort();
  }, [bookId, filter, offset, path, revision, updateKey]);

  async function resolve(item: SkippedFile, resolution: Resolution) {
    setError('');
    setBusy(true);
    try {
      await api(`${path}/${item.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify(resolution),
      });
      onResolved?.(resolution);
      setRevision((value) => value + 1);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (detail && !page?.pending_count) return null;

  const heading = t('bookshelf.intake.heading');
  const body = (
    <>
      {error && (
        <div className="book-intake-actions">
          <p role="alert" className="error">
            {error}
          </p>
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            {t('bookshelf.intake.retry')}
          </button>
        </div>
      )}
      {loading ? (
        <p role="status">{t('bookshelf.loading')}</p>
      ) : page && !page.items.length && !error ? (
        <p className="muted">{t('bookshelf.intake.empty')}</p>
      ) : null}
      {!loading &&
        page?.items.map((item) => (
          <SkippedFileRow
            key={item.id}
            item={item}
            libraryId={libraryId}
            detail={detail}
            busy={busy}
            resolve={(resolution) => resolve(item, resolution)}
          />
        ))}
      {!loading && page && page.total > pageSize && (
        <div className="book-intake-actions tnum">
          <button
            type="button"
            disabled={!offset || busy}
            onClick={() => setOffset(offset - pageSize)}
          >
            {t('bookshelf.intake.previous')}
          </button>
          <span>
            {offset + 1}–{Math.min(offset + pageSize, page.total)} / {page.total}
          </span>
          <button
            type="button"
            disabled={offset + pageSize >= page.total || busy}
            onClick={() => setOffset(offset + pageSize)}
          >
            {t('bookshelf.intake.next')}
          </button>
        </div>
      )}
    </>
  );

  return detail ? (
    <details className="book-intake book-intake-detail">
      <summary className="tnum">
        {t('bookshelf.intake.headingCount', { count: page?.pending_count })}
      </summary>
      <div className="book-intake-body">{body}</div>
    </details>
  ) : (
    <section className="book-intake" aria-labelledby={id}>
      <div className="book-intake-header">
        <h3 className="tnum" id={id}>
          {page ? t('bookshelf.intake.headingCount', { count: page.pending_count }) : heading}
        </h3>
        <label>
          {t('bookshelf.intake.filter')}
          <select
            value={filter}
            disabled={busy}
            onChange={(event) => {
              setFilter(event.target.value as Filter);
              setPage(null);
              setOffset(0);
            }}
          >
            {statuses.map((status) => (
              <option key={status} value={status}>
                {t(`bookshelf.intake.status.${status}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="book-intake-body">{body}</div>
    </section>
  );
}
