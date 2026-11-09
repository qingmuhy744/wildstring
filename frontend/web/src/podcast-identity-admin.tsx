import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from './api';

type BackfillRun = {
  processed: number;
  matched: number;
  no_match: number;
  failed: number;
  ambiguous: number;
  finished_at?: string | null;
  stopped_reason?: string | null;
  trigger?: 'auto' | 'manual';
  duplicates?: { verified: number; possible: number } | null;
};

export type BackfillStatus = Partial<BackfillRun> & {
  running: boolean;
  paused_until?: number | null;
  last_run: BackfillRun | null;
  total: number;
  with_itunes_id: number;
  unchecked: number;
  counts: Record<string, number>;
};

type DuplicateShow = {
  id: string;
  title: string;
  author: string;
  feed_url: string;
  itunes_id: string | null;
  followers: number;
  episodes: number;
  downloaded: number;
  redirects: boolean;
};

export type DuplicatePair = {
  confidence: 'verified' | 'possible';
  reasons: string[];
  itunes_id: string | null;
  suggested_keep_id: string;
  podcasts: [DuplicateShow, DuplicateShow];
};

type MergeResult = {
  episodes_moved: number;
  episodes_matched: number;
  progress_moved: number;
  progress_replaced: number;
  downloads_moved: number;
  follows_moved: number;
};

const BASE = '/podcasts/identity';
const REASON_KEYS: Record<string, string> = {
  itunes_id: 'reasonItunesId',
  feed: 'reasonFeed',
  title: 'reasonTitle',
};

const pairKey = (pair: DuplicatePair) => pair.podcasts.map((show) => show.id).join('+');

export function PodcastIdentityAdmin() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<BackfillStatus | null>(null);
  const [pairs, setPairs] = useState<DuplicatePair[]>([]);
  const [hidden, setHidden] = useState(false);
  const [retryUnmatched, setRetryUnmatched] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [confirming, setConfirming] = useState('');
  const wasRunning = useRef(false);

  const loadDuplicates = useCallback(async () => {
    const report = await api<{ duplicates: DuplicatePair[] }>(`${BASE}/duplicates`);
    setPairs(report.duplicates);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const value = await api<BackfillStatus>(`${BASE}/backfill`);
      setStatus(value);
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) setHidden(true);
      else
        setMessage(error instanceof Error ? error.message : t('podcastIdentityAdmin.readFailed'));
      return null;
    }
  }, [t]);

  useEffect(() => {
    void loadStatus().then((value) => {
      if (value) void loadDuplicates().catch((error: Error) => setMessage(error.message));
    });
  }, [loadStatus, loadDuplicates]);

  useEffect(() => {
    if (!status?.running) {
      if (wasRunning.current) {
        wasRunning.current = false;
        void loadDuplicates().catch(() => undefined);
      }
      return;
    }
    wasRunning.current = true;
    const timer = window.setTimeout(() => void loadStatus(), 2000);
    return () => window.clearTimeout(timer);
  }, [status, loadStatus, loadDuplicates]);

  if (hidden) return null;

  async function start() {
    setBusy('backfill');
    setMessage('');
    try {
      setStatus(
        await api<BackfillStatus>(`${BASE}/backfill`, {
          method: 'POST',
          body: JSON.stringify({ limit: 200, retry_unmatched: retryUnmatched }),
        }),
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : t('podcastIdentityAdmin.startBackfillFailed'),
      );
    } finally {
      setBusy('');
    }
  }

  async function merge(pair: DuplicatePair) {
    setBusy(pairKey(pair));
    setMessage('');
    try {
      const result = await api<MergeResult>(`${BASE}/merge`, {
        method: 'POST',
        // The server picks the show to keep; the pair order does not matter.
        body: JSON.stringify({ podcast_ids: pair.podcasts.map((show) => show.id) }),
      });
      setMessage(
        t('podcastIdentityAdmin.mergeSuccess', {
          episodesMoved: result.episodes_moved,
          episodesMatched: result.episodes_matched,
          followsMoved: result.follows_moved,
          progressMoved: result.progress_moved + result.progress_replaced,
          downloadsMoved: result.downloads_moved,
        }),
      );
      setConfirming('');
      await Promise.all([loadDuplicates(), loadStatus()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('podcastIdentityAdmin.mergeFailed'));
    } finally {
      setBusy('');
    }
  }

  const run = status?.running ? status : status?.last_run;
  const verified = pairs.filter((pair) => pair.confidence === 'verified');
  const possible = pairs.filter((pair) => pair.confidence === 'possible');

  return (
    <section className="management-card" aria-label={t('podcastIdentityAdmin.cardTitle')}>
      <h2>{t('podcastIdentityAdmin.cardTitle')}</h2>
      <p className="muted">{t('podcastIdentityAdmin.description')}</p>
      {status && (
        <p>
          {t('podcastIdentityAdmin.statusSummary', {
            total: status.total,
            withId: status.with_itunes_id,
            unchecked: status.unchecked,
          })}
        </p>
      )}
      {run && (
        <p role="status" aria-label={t('podcastIdentityAdmin.backfillProgressAria')}>
          {status?.running
            ? status.paused_until
              ? t('podcastIdentityAdmin.waitingRateLimit', { processed: run.processed })
              : t('podcastIdentityAdmin.checking', { processed: run.processed })
            : run.trigger === 'auto'
              ? t('podcastIdentityAdmin.lastBackfillAuto', { processed: run.processed })
              : t('podcastIdentityAdmin.lastBackfillManual', { processed: run.processed })}
          {t('podcastIdentityAdmin.statsTail', {
            matched: run.matched,
            noMatch: run.no_match,
            failed: run.failed,
          })}
          {run.ambiguous ? t('podcastIdentityAdmin.ambiguousCount', { count: run.ambiguous }) : ''}
          {!status?.running && run.duplicates
            ? t('podcastIdentityAdmin.duplicatesFound', {
                verified: run.duplicates.verified,
                possible: run.duplicates.possible,
              })
            : ''}
        </p>
      )}
      <label className="music-library-grant-option">
        <input
          type="checkbox"
          checked={retryUnmatched}
          disabled={Boolean(busy) || status?.running}
          onChange={(event) => setRetryUnmatched(event.target.checked)}
        />
        <span>{t('podcastIdentityAdmin.retryUnmatched')}</span>
      </label>
      <div className="podcast-search-settings-actions">
        <button
          type="button"
          disabled={Boolean(busy) || !status || status.running}
          onClick={() => void start()}
        >
          {status?.running
            ? t('podcastIdentityAdmin.backfillRunning')
            : t('podcastIdentityAdmin.startBackfill')}
        </button>
      </div>

      <h3>{t('podcastIdentityAdmin.duplicateShowsHeading')}</h3>
      <p className="muted">{t('podcastIdentityAdmin.mergeRuleHelp')}</p>
      {pairs.length === 0 ? (
        <p className="muted">{t('podcastIdentityAdmin.noDuplicatesFound')}</p>
      ) : (
        <ul
          className="podcast-duplicates"
          aria-label={t('podcastIdentityAdmin.duplicateShowsHeading')}
        >
          {[...verified, ...possible].map((pair) => {
            const id = pairKey(pair);
            const keepId = pair.suggested_keep_id;
            const isVerified = pair.confidence === 'verified';
            return (
              <li key={id} className="podcast-duplicate">
                <p>
                  <span
                    className={`podcast-duplicate-badge ${isVerified ? 'is-verified' : 'is-possible'}`}
                  >
                    {isVerified
                      ? t('podcastIdentityAdmin.verified')
                      : t('podcastIdentityAdmin.possible')}
                  </span>{' '}
                  {pair.reasons
                    .map((reason) =>
                      REASON_KEYS[reason]
                        ? t(`podcastIdentityAdmin.${REASON_KEYS[reason]}`)
                        : reason,
                    )
                    .join(t('podcastIdentityAdmin.separator'))}
                  {pair.itunes_id
                    ? t('podcastIdentityAdmin.appleIdSuffix', { id: pair.itunes_id })
                    : ''}
                </p>
                <div className="podcast-duplicate-shows">
                  {pair.podcasts.map((show) => (
                    <div
                      key={show.id}
                      className="podcast-duplicate-show"
                      role="group"
                      aria-label={`「${show.title}」${show.feed_url}`}
                    >
                      <span>
                        <span>
                          <strong>{show.title}</strong>
                          {show.author ? ` · ${show.author}` : ''}
                          {isVerified && keepId === show.id && (
                            <>
                              {' '}
                              <span className="podcast-duplicate-badge is-verified">
                                {t('podcastIdentityAdmin.willKeep')}
                              </span>
                            </>
                          )}
                        </span>
                        <small className="podcast-duplicate-feed">
                          {show.feed_url}
                          {show.redirects ? t('podcastIdentityAdmin.redirected') : ''}
                        </small>
                        <small>
                          {t('podcastIdentityAdmin.showMeta', {
                            followers: show.followers,
                            episodes: show.episodes,
                            downloaded: show.downloaded,
                            noItunesId: show.itunes_id ? '' : t('podcastIdentityAdmin.noAppleId'),
                          })}
                        </small>
                      </span>
                    </div>
                  ))}
                </div>
                {isVerified ? (
                  confirming === id ? (
                    <div className="podcast-search-settings-actions">
                      <span>{t('podcastIdentityAdmin.confirmMergePrompt')}</span>
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() => void merge(pair)}
                      >
                        {busy === id
                          ? t('podcastIdentityAdmin.merging')
                          : t('podcastIdentityAdmin.confirmMerge')}
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() => setConfirming('')}
                      >
                        {t('podcastIdentityAdmin.cancel')}
                      </button>
                    </div>
                  ) : (
                    <div className="podcast-search-settings-actions">
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() => setConfirming(id)}
                      >
                        {t('podcastIdentityAdmin.mergeButton')}
                      </button>
                    </div>
                  )
                ) : (
                  <p className="muted">{t('podcastIdentityAdmin.lowConfidenceHelp')}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
