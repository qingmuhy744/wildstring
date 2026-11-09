import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from './api';
import i18n from './i18n';
import { cleanPodcastDescription } from './podcast-description';
import './podcast-search.css';

export interface PodcastSearchResult {
  itunes_id: string | null;
  title: string;
  author: string;
  artwork_url: string;
  feed_url: string;
  genres: string[];
  episode_count: number | null;
  explicit: boolean;
  latest_release_at: string | null;
  page_url: string;
  regions: string[];
  in_catalog: boolean;
  catalog_podcast_id: string | null;
  followed: boolean;
}

export interface PodcastSearchResponse {
  query: string;
  provider: 'itunes';
  regions: string[];
  failed_regions: { region: string; code: string }[];
  cached: boolean;
  explicit_hidden: number;
  results: PodcastSearchResult[];
}

export interface PodcastFeedPreview {
  feed_url: string;
  resolved_feed_url: string;
  title: string;
  author: string;
  description: string;
  cover_url: string;
  episode_count: number;
  latest_episodes: { title: string; pub_date: string | null; duration_seconds: number | null }[];
  in_catalog: boolean;
  catalog_podcast_id: string | null;
  followed: boolean;
}

export const regionName = (code: string) => {
  const key = `podcastSearch.region_${code.toLowerCase()}`;
  const val = i18n.t(key);
  return val && val !== key ? val : code.toUpperCase();
};

export const isFeedAddress = (value: string) => /^https?:\/\//i.test(value.trim());

const SEARCH_DEBOUNCE_MS = 400;

let cachedAvailableRegions: string[] | null = null;
const discoverCache = new Map<string, PodcastSearchResponse>();
const inflightDiscover = new Map<string, Promise<PodcastSearchResponse>>();

export function invalidatePodcastDiscoverCache() {
  discoverCache.clear();
}

export function prefetchPodcastDiscover(region = '') {
  if (!cachedAvailableRegions) {
    void api<{ regions: string[] }>('/podcasts/search-settings')
      .then((settings) => {
        cachedAvailableRegions = settings.regions;
      })
      .catch(() => {});
  }
  if (discoverCache.has(region) || inflightDiscover.has(region)) return;
  const request = api<PodcastSearchResponse>(
    `/podcasts/discover${region ? `?region=${encodeURIComponent(region)}` : ''}`,
    { timeoutMs: 30000 },
  )
    .then((value) => {
      discoverCache.set(region, value);
      return value;
    })
    .finally(() => {
      inflightDiscover.delete(region);
    });
  inflightDiscover.set(region, request);
  void request.catch(() => {});
}

type Selection = { kind: 'result'; result: PodcastSearchResult } | { kind: 'url'; feedUrl: string };

interface ErrorState {
  message: string;
  retryAfter?: number;
}

function describeError(error: unknown): ErrorState {
  if (error instanceof ApiError) {
    return { message: error.message, retryAfter: error.retryAfter };
  }
  return {
    message: error instanceof Error ? error.message : i18n.t('podcastSearch.requestFailed'),
  };
}

function shortDate(value: string | null) {
  if (!value) return '';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return '';
  return new Date(time).toLocaleDateString(i18n.language === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function minutes(seconds: number | null) {
  if (!seconds) return '';
  return seconds >= 3600
    ? i18n.t('podcastSearch.hoursMinutes', {
        hours: Math.floor(seconds / 3600),
        minutes: Math.round((seconds % 3600) / 60),
      })
    : i18n.t('podcastSearch.minutesOnly', {
        minutes: Math.max(1, Math.round(seconds / 60)),
      });
}

function Artwork({ src, title }: { src: string; title: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span className="podcast-search-artwork placeholder" aria-hidden="true">
        {title.slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      className="podcast-search-artwork"
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

export function PodcastSearchPage({
  canAdd,
  initialQuery = '',
  initialExplore = false,
  onClose,
  onSubscribed,
  onOpen,
}: {
  canAdd: boolean;
  initialQuery?: string;
  initialExplore?: boolean;
  onClose: () => void;
  onSubscribed: (podcastId: string, title: string) => void | Promise<void>;
  onOpen: (podcastId: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(initialQuery);
  const [explore, setExplore] = useState(initialExplore);
  const [region, setRegion] = useState('');
  const [availableRegions, setAvailableRegions] = useState<string[]>(
    () => cachedAvailableRegions ?? [],
  );
  const [response, setResponse] = useState<PodcastSearchResponse | null>(() =>
    !initialQuery.trim() ? (discoverCache.get('') ?? null) : null,
  );
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<ErrorState | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [preview, setPreview] = useState<PodcastFeedPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<ErrorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const detailPanel = useRef<HTMLElement>(null);
  const selectedCard = useRef<HTMLButtonElement | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const previewAbort = useRef<AbortController | null>(null);
  const term = query.trim();
  const urlMode = isFeedAddress(term);

  useEffect(() => {
    setExplore(initialExplore);
  }, [initialExplore]);

  useEffect(() => {
    const controller = new AbortController();
    void api<{ regions: string[] }>('/podcasts/search-settings', { signal: controller.signal })
      .then((settings) => {
        cachedAvailableRegions = settings.regions;
        if (!controller.signal.aborted) setAvailableRegions(settings.regions);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (selection) detailPanel.current?.focus({ preventScroll: true });
  }, [selection]);

  function returnToResults() {
    setSelection(null);
    requestAnimationFrame(() => selectedCard.current?.focus({ preventScroll: true }));
  }

  useEffect(() => {
    searchAbort.current?.abort();
    setError(null);
    if (urlMode) {
      setResponse(null);
      setSearching(false);
      const timer = window.setTimeout(
        () => setSelection({ kind: 'url', feedUrl: term }),
        submitted ? 0 : SEARCH_DEBOUNCE_MS,
      );
      return () => window.clearTimeout(timer);
    }
    if (!term && submitted === 0 && discoverCache.has(region)) {
      setResponse(discoverCache.get(region)!);
      setSearching(false);
      setSelection((current) => (current?.kind === 'url' ? null : current));
      return;
    }
    const controller = new AbortController();
    searchAbort.current = controller;
    setSearching(true);
    const delayMs = submitted || (!term && explore) ? 0 : SEARCH_DEBOUNCE_MS;
    const timer = window.setTimeout(() => {
      const request =
        !term && submitted === 0 && inflightDiscover.has(region)
          ? inflightDiscover.get(region)!
          : api<PodcastSearchResponse>(
              term
                ? `/podcasts/search?q=${encodeURIComponent(term)}`
                : `/podcasts/discover${region ? `?region=${encodeURIComponent(region)}` : ''}`,
              {
                signal: controller.signal,
                timeoutMs: 30000,
              },
            );
      request
        .then((value) => {
          if (!term) discoverCache.set(region, value);
          if (controller.signal.aborted) return;
          setResponse(value);
          setSelection((current) => (current?.kind === 'url' ? null : current));
        })
        .catch((reason) => {
          if (controller.signal.aborted) return;
          if (reason instanceof DOMException && reason.name === 'AbortError') return;
          setResponse(null);
          setError(describeError(reason));
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [term, urlMode, submitted, explore, region]);

  const selectedFeed =
    selection?.kind === 'result' ? selection.result.feed_url : selection?.feedUrl || '';
  const selectedItunes = selection?.kind === 'result' ? selection.result.itunes_id : null;

  useEffect(() => {
    previewAbort.current?.abort();
    setPreview(null);
    setPreviewError(null);
    setActionError(null);
    if (!selectedFeed) return;
    const controller = new AbortController();
    previewAbort.current = controller;
    setPreviewing(true);
    api<PodcastFeedPreview>('/podcasts/preview', {
      method: 'POST',
      body: JSON.stringify({
        feed_url: selectedFeed,
        ...(selectedItunes ? { itunes_id: selectedItunes } : {}),
      }),
      signal: controller.signal,
      timeoutMs: 30000,
    })
      .then((value) => {
        if (!controller.signal.aborted) setPreview(value);
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        setPreviewError(describeError(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewing(false);
      });
    return () => controller.abort();
  }, [selectedFeed, selectedItunes]);

  useEffect(
    () => () => {
      searchAbort.current?.abort();
      previewAbort.current?.abort();
    },
    [],
  );

  const result = selection?.kind === 'result' ? selection.result : null;
  const state = useMemo(() => {
    const source = preview ?? result;
    return {
      inCatalog: Boolean(source?.in_catalog),
      podcastId: source?.catalog_podcast_id ?? null,
      followed: Boolean(source?.followed),
    };
  }, [preview, result]);

  async function subscribe() {
    if (!selectedFeed) return;
    setBusy(true);
    setActionError(null);
    try {
      if (state.inCatalog && state.podcastId) {
        if (!state.followed) {
          await api(`/podcasts/${encodeURIComponent(state.podcastId)}/follow`, {
            method: 'PUT',
            body: JSON.stringify({ followed: true }),
          });
        }
        invalidatePodcastDiscoverCache();
        await onSubscribed(state.podcastId, preview?.title || result?.title || '');
        return;
      }
      const detail = await api<{ podcast: { id: string; title: string } }>('/podcasts', {
        method: 'POST',
        body: JSON.stringify({
          feed_url: selectedFeed,
          ...(selectedItunes ? { itunes_id: selectedItunes } : {}),
        }),
        timeoutMs: 60000,
      });
      invalidatePodcastDiscoverCache();
      await onSubscribed(detail.podcast.id, detail.podcast.title);
    } catch (reason) {
      setActionError(describeError(reason).message);
    } finally {
      setBusy(false);
    }
  }

  const failed = response?.failed_regions ?? [];
  const results = response?.results ?? [];
  const regions = response?.regions ?? [];
  const showDetail = Boolean(selection);

  const actionLabel = state.followed
    ? t('podcastSearch.actionOpen')
    : state.inCatalog
      ? t('podcastSearch.actionFollowAndOpen')
      : canAdd
        ? t('podcastSearch.actionAddAndFollow')
        : t('podcastSearch.actionNotAllowed');
  // A failed preview of a pasted address can still be added: the server dedupes against
  // the catalog first and reports its own fetch error, matching the previous RSS dialog.
  const actionDisabled =
    busy ||
    previewing ||
    (!state.inCatalog && !canAdd) ||
    (!preview && !result && !(urlMode && previewError));

  return (
    <section
      className={`podcasts-page podcast-search-page${showDetail ? ' has-detail' : ''}`}
      aria-labelledby="podcast-search-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing && selection && !urlMode) {
          returnToResults();
          event.stopPropagation();
        }
      }}
    >
      <header className="podcast-explore-header">
        <div>
          <h2 id="podcast-search-title" ref={heading} tabIndex={-1}>
            {explore
              ? t('podcastSearch.headingExplore')
              : canAdd
                ? t('podcastSearch.headingSearchOrAdd')
                : t('podcastSearch.headingSearch')}
          </h2>
          <p>{t('podcastSearch.subheading')}</p>
        </div>
        <button type="button" className="podcast-back-btn" onClick={onClose}>
          {t('podcastSearch.backToRadio')}
        </button>
      </header>
      <div className="podcast-search-controls">
        <form
          className="podcast-search-form"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted((value) => value + 1);
          }}
        >
          <input
            id="podcast-search-input"
            type="search"
            inputMode="search"
            enterKeyHint="search"
            aria-label={t('podcastSearch.searchAriaLabel')}
            placeholder={t('podcastSearch.searchPlaceholder')}
            value={query}
            maxLength={1024}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelection(null);
            }}
          />
        </form>
        <div className="podcast-search-filters">
          <button
            type="button"
            aria-pressed={!term}
            onClick={() => {
              setExplore(true);
              setQuery('');
              setSelection(null);
              setSubmitted((value) => value + 1);
            }}
          >
            {t('podcastSearch.explorePopular')}
          </button>
          {!term && (
            <label>
              {t('podcastSearch.regionLabel')}
              <select
                aria-label={t('podcastSearch.regionAriaLabel')}
                value={region}
                onChange={(event) => {
                  setRegion(event.target.value);
                  setSelection(null);
                }}
              >
                <option value="">{t('podcastSearch.serverDefault')}</option>
                {Array.from(new Set([...availableRegions, 'us', 'tw', 'cn', 'hk', 'jp', 'gb'])).map(
                  (code) => (
                    <option key={code} value={code}>
                      {regionName(code)}
                    </option>
                  ),
                )}
              </select>
            </label>
          )}
        </div>
      </div>
      <p className="podcast-search-hint">
        {urlMode
          ? t('podcastSearch.hintUrlMode')
          : !term
            ? t('podcastSearch.hintBrowsePopular', {
                regions: regions.length ? `：${regions.map(regionName).join(' · ')}` : '',
              })
            : t('podcastSearch.hintSearch', {
                regions: regions.length ? `：${regions.map(regionName).join(' · ')}` : '',
              })}
      </p>

      <div className="podcast-search-body">
        <section
          className="podcast-search-results"
          aria-label={t('podcastSearch.resultsAriaLabel')}
          aria-busy={searching}
          hidden={urlMode && showDetail}
        >
          {searching && (
            <div className="podcast-search-status">
              {term ? t('podcastSearch.searching') : t('podcastSearch.loadingPopular')}
            </div>
          )}
          {!searching && error && (
            <div className="modal-error-message" role="alert">
              {error.message}
              {error.retryAfter ? t('podcastSearch.retryAfter', { seconds: error.retryAfter }) : ''}
              <div className="podcast-search-retry">
                {!term && explore && <p>{t('podcastSearch.popularLoadErrorHelp')}</p>}
                <button type="button" onClick={() => setSubmitted((value) => value + 1)}>
                  {t('podcastSearch.reload')}
                </button>
              </div>
            </div>
          )}
          {!searching && !error && failed.length > 0 && (
            <div className="podcast-search-warning" role="status">
              {t('podcastSearch.failedRegions', {
                regions: failed
                  .map((item) => regionName(item.region))
                  .join(t('podcastSearch.regionSeparator')),
              })}
            </div>
          )}
          {!searching && !error && response && response.explicit_hidden > 0 && (
            <div className="podcast-search-status">
              {t('podcastSearch.explicitHidden', { count: response.explicit_hidden })}
            </div>
          )}
          {!searching && !error && response && results.length === 0 && (
            <div className="podcast-search-empty">
              <strong>
                {term
                  ? t('podcastSearch.noResultsQuery', { query: response.query })
                  : t('podcastSearch.noResultsRegion')}
              </strong>
              <span>{t('podcastSearch.noResultsHint')}</span>
            </div>
          )}
          {!term && !explore && (
            <div className="podcast-search-empty">
              <strong>{t('podcastSearch.searchStartPromptTitle')}</strong>
              <span>{t('podcastSearch.searchStartPromptDesc')}</span>
            </div>
          )}
          {!searching && results.length > 0 && (
            <ul className="podcast-search-list">
              {results.map((item) => {
                const active = result?.feed_url === item.feed_url;
                return (
                  <li key={`${item.itunes_id ?? ''}|${item.feed_url}`}>
                    <button
                      type="button"
                      className={`podcast-search-card${active ? ' active' : ''}`}
                      aria-pressed={active}
                      onClick={(event) => {
                        selectedCard.current = event.currentTarget;
                        setSelection({ kind: 'result', result: item });
                      }}
                    >
                      <Artwork src={item.artwork_url} title={item.title} />
                      <span className="podcast-search-card-text">
                        <span className="podcast-search-card-title">
                          {item.title}
                          {item.explicit && (
                            <span
                              className="podcast-search-explicit"
                              title={t('podcastSearch.explicitTooltip')}
                            >
                              {t('podcastSearch.explicitBadge')}
                            </span>
                          )}
                        </span>
                        <span className="podcast-search-card-author">{item.author}</span>
                        <span className="podcast-search-card-meta">
                          {[
                            item.episode_count != null
                              ? t('podcastSearch.episodeCount', { count: item.episode_count })
                              : '',
                            item.genres[0] ?? '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                        <span className="podcast-search-card-tags">
                          {item.regions.map((region) => (
                            <span key={region} className="podcast-search-region">
                              {regionName(region)}
                            </span>
                          ))}
                          {item.followed ? (
                            <span className="podcast-search-state followed">
                              {t('podcastSearch.stateFollowed')}
                            </span>
                          ) : item.in_catalog ? (
                            <span className="podcast-search-state">
                              {t('podcastSearch.stateInCatalog')}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {showDetail && (
          <section
            className="podcast-search-preview"
            aria-label={t('podcastSearch.previewAriaLabel')}
            ref={detailPanel}
            tabIndex={-1}
          >
            {!urlMode && (
              <button type="button" className="podcast-search-back" onClick={returnToResults}>
                {t('podcastSearch.backToResults')}
              </button>
            )}
            <div className="podcast-search-preview-head">
              <Artwork
                src={preview?.cover_url || result?.artwork_url || ''}
                title={preview?.title || result?.title || t('podcastSearch.defaultShowLetter')}
              />
              <div>
                <h4>{preview?.title || result?.title || selectedFeed}</h4>
                <p>{preview?.author || result?.author}</p>
                {result?.explicit && (
                  <span className="podcast-search-explicit">
                    {t('podcastSearch.explicitTooltip')}
                  </span>
                )}
              </div>
            </div>
            {previewing && (
              <div className="podcast-search-status">{t('podcastSearch.readingRssFeed')}</div>
            )}
            {previewError && (
              <div className="modal-error-message" role="alert">
                {previewError.message}
                {previewError.retryAfter
                  ? t('podcastSearch.retryAfter', { seconds: previewError.retryAfter })
                  : ''}
              </div>
            )}
            {preview && (
              <>
                {preview.description && (
                  <p className="podcast-search-description">
                    {cleanPodcastDescription(preview.description)}
                  </p>
                )}
                <h5>
                  {t('podcastSearch.latestEpisodesHeading', { count: preview.episode_count })}
                </h5>
                <ol className="podcast-search-episodes">
                  {preview.latest_episodes.map((episode, index) => (
                    <li key={`${index}-${episode.title}`}>
                      <span>{episode.title}</span>
                      <small>
                        {[shortDate(episode.pub_date), minutes(episode.duration_seconds)]
                          .filter(Boolean)
                          .join(' · ')}
                      </small>
                    </li>
                  ))}
                </ol>
              </>
            )}
            {actionError && (
              <div className="modal-error-message" role="alert">
                {actionError}
              </div>
            )}
            <div className="modal-actions">
              {state.followed && state.podcastId ? (
                <button
                  type="button"
                  className="modal-submit-btn primary"
                  onClick={() => void onOpen(state.podcastId!)}
                >
                  {t('podcastSearch.followedOpenShow')}
                </button>
              ) : (
                <button
                  type="button"
                  className="modal-submit-btn primary"
                  disabled={actionDisabled}
                  onClick={() => void subscribe()}
                >
                  {busy ? t('podcastSearch.adding') : actionLabel}
                </button>
              )}
            </div>
          </section>
        )}
      </div>
    </section>
  );
}
