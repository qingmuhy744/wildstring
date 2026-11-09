import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, errorCodeMessage } from './api';
import { DialogCloseButton } from './dialog-close';
import './podcast-search.css';

export interface OpmlFeed {
  title: string;
  feed_url: string;
  html_url: string;
  in_catalog: boolean;
  followed: boolean;
  catalog_podcast_id: string | null;
}

interface OpmlParseResponse {
  feeds: OpmlFeed[];
  invalid: number;
  duplicates: number;
}

export interface OpmlImportResult {
  feed_url: string;
  status: 'added' | 'followed' | 'already_followed' | 'failed';
  podcast_id?: string;
  title?: string;
  code?: string;
}

const BATCH = 10;
const MAX_FILE_BYTES = 1_000_000;
export const OPML_EXPORT_URL = '/api/v1/podcasts/opml/export';

const STATUS_KEYS: Record<OpmlImportResult['status'], string> = {
  added: 'statusAdded',
  followed: 'statusFollowed',
  already_followed: 'statusAlreadyFollowed',
  failed: 'statusFailed',
};

export function PodcastOpmlImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useTranslation();
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState('');
  const [parsed, setParsed] = useState<OpmlParseResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState(0);
  const [results, setResults] = useState<OpmlImportResult[] | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !importing) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [importing, onClose]);
  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setParsed(null);
    setResults(null);
    if (file.size > MAX_FILE_BYTES) {
      setError(errorCodeMessage('podcast_opml_too_large'));
      return;
    }
    setParsing(true);
    try {
      const content = await file.text();
      const body = await api<OpmlParseResponse>('/podcasts/opml/parse', {
        method: 'POST',
        body: JSON.stringify({ content }),
      });
      setParsed(body);
      setSelected(new Set(body.feeds.filter((feed) => !feed.followed).map((f) => f.feed_url)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setParsing(false);
    }
  };

  const chosen = useMemo(
    () => (parsed ? parsed.feeds.filter((feed) => selected.has(feed.feed_url)) : []),
    [parsed, selected],
  );

  const toggle = (url: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });

  const runImport = async () => {
    setImporting(true);
    setError('');
    setDone(0);
    const collected: OpmlImportResult[] = [];
    try {
      for (let start = 0; start < chosen.length && !cancelled.current; start += BATCH) {
        const batch = chosen.slice(start, start + BATCH);
        try {
          const body = await api<{ results: OpmlImportResult[] }>('/podcasts/opml/import', {
            method: 'POST',
            body: JSON.stringify({ feeds: batch.map((feed) => ({ feed_url: feed.feed_url })) }),
            timeoutMs: 180000,
          });
          collected.push(...body.results);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          collected.push(
            ...batch.map((feed) => ({
              feed_url: feed.feed_url,
              status: 'failed' as const,
              code: message,
            })),
          );
        }
        setDone(Math.min(start + BATCH, chosen.length));
        setResults([...collected]);
      }
    } finally {
      setImporting(false);
      if (collected.some((item) => item.status !== 'failed')) onImported();
    }
  };

  const titleOf = (url: string) =>
    parsed?.feeds.find((feed) => feed.feed_url === url)?.title || url;
  const failed = results?.filter((item) => item.status === 'failed').length ?? 0;

  return (
    <div className="podcasts-modal-backdrop" onClick={importing ? undefined : onClose}>
      <div
        className="podcasts-modal podcast-search-modal podcast-opml-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="podcast-opml-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="podcasts-modal-header">
          <h3 id="podcast-opml-title">{t('podcastOpml.dialogTitle')}</h3>
          <DialogCloseButton
            className="modal-close-btn"
            aria-label={t('podcastOpml.closeDialog')}
            disabled={importing}
            onClick={onClose}
          />
        </div>
        <p className="podcast-search-hint">{t('podcastOpml.dialogHint')}</p>
        <label className="podcast-opml-file">
          <span>{t('podcastOpml.selectFile')}</span>
          <input
            type="file"
            accept=".opml,.xml,text/x-opml,text/xml,application/xml"
            disabled={parsing || importing}
            onChange={(event) => void readFile(event.target.files?.[0])}
          />
        </label>
        {parsing && <div className="podcast-search-status">{t('podcastOpml.readingFile')}</div>}
        {error && (
          <div className="modal-error-message" role="alert">
            {error}
          </div>
        )}
        {parsed && !results && (
          <section className="podcast-opml-preview" aria-label={t('podcastOpml.feedListAriaLabel')}>
            <div className="podcast-opml-summary" role="status">
              {t('podcastOpml.summaryTotal', { count: parsed.feeds.length })}
              {parsed.duplicates
                ? t('podcastOpml.summaryDuplicates', { count: parsed.duplicates })
                : ''}
              {parsed.invalid ? t('podcastOpml.summaryInvalid', { count: parsed.invalid }) : ''}
            </div>
            <div className="podcast-opml-bulk">
              <button
                type="button"
                className="podcasts-action-btn"
                onClick={() =>
                  setSelected(
                    new Set(parsed.feeds.filter((f) => !f.followed).map((f) => f.feed_url)),
                  )
                }
              >
                {t('podcastOpml.selectAllUnfollowed')}
              </button>
              <button
                type="button"
                className="podcasts-action-btn"
                onClick={() => setSelected(new Set())}
              >
                {t('podcastOpml.deselectAll')}
              </button>
            </div>
            <ul className="podcast-search-list podcast-opml-list">
              {parsed.feeds.map((feed) => (
                <li key={feed.feed_url}>
                  <label className="podcast-opml-row">
                    <input
                      type="checkbox"
                      checked={selected.has(feed.feed_url)}
                      disabled={feed.followed}
                      onChange={() => toggle(feed.feed_url)}
                    />
                    <span className="podcast-search-card-text">
                      <span className="podcast-search-card-title">{feed.title}</span>
                      <span className="podcast-search-card-meta">{feed.feed_url}</span>
                    </span>
                    {feed.followed ? (
                      <span className="podcast-search-state followed">
                        {t('podcastOpml.stateFollowed')}
                      </span>
                    ) : feed.in_catalog ? (
                      <span className="podcast-search-state">
                        {t('podcastOpml.stateInCatalog')}
                      </span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}
        {results && (
          <section
            className="podcast-opml-preview"
            aria-label={t('podcastOpml.importResultsAriaLabel')}
          >
            <div className="podcast-opml-summary" role="status">
              {importing
                ? t('podcastOpml.importingProgress', { done, total: chosen.length })
                : t('podcastOpml.importComplete', { succeeded: results.length - failed, failed })}
            </div>
            <progress
              max={chosen.length || 1}
              value={done}
              aria-label={t('podcastOpml.progressAriaLabel')}
            />
            <ul className="podcast-search-list podcast-opml-list">
              {results.map((item) => (
                <li key={item.feed_url} className={`podcast-opml-result ${item.status}`}>
                  <span className="podcast-search-card-text">
                    <span className="podcast-search-card-title">
                      {item.title || titleOf(item.feed_url)}
                    </span>
                    <span className="podcast-search-card-meta">
                      {t(`podcastOpml.${STATUS_KEYS[item.status]}`)}
                      {item.status === 'failed' && item.code
                        ? `：${errorCodeMessage(item.code)}`
                        : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <div className="modal-actions">
          {results && !importing ? (
            <button type="button" className="modal-submit-btn primary" onClick={onClose}>
              {t('podcastOpml.done')}
            </button>
          ) : (
            <button
              type="button"
              className="modal-submit-btn primary"
              disabled={!parsed || importing || chosen.length === 0}
              onClick={() => void runImport()}
            >
              {importing
                ? t('podcastOpml.importing')
                : t('podcastOpml.importSelected', { count: chosen.length })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
