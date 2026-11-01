import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from './api';
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

const REGION_NAMES: Record<string, string> = {
  us: '美国',
  tw: '台湾',
  cn: '中国大陆',
  hk: '香港',
  mo: '澳门',
  sg: '新加坡',
  jp: '日本',
  kr: '韩国',
  gb: '英国',
  ca: '加拿大',
  au: '澳大利亚',
  de: '德国',
  fr: '法国',
};

export const regionName = (code: string) => REGION_NAMES[code] || code.toUpperCase();

export const isFeedAddress = (value: string) => /^https?:\/\//i.test(value.trim());

const SEARCH_DEBOUNCE_MS = 400;

type Selection = { kind: 'result'; result: PodcastSearchResult } | { kind: 'url'; feedUrl: string };

interface ErrorState {
  message: string;
  retryAfter?: number;
}

function describeError(error: unknown): ErrorState {
  if (error instanceof ApiError) {
    return { message: error.message, retryAfter: error.retryAfter };
  }
  return { message: error instanceof Error ? error.message : '请求未完成，请重试。' };
}

function shortDate(value: string | null) {
  if (!value) return '';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return '';
  return new Date(time).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function minutes(seconds: number | null) {
  if (!seconds) return '';
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)} 小时 ${Math.round((seconds % 3600) / 60)} 分`
    : `${Math.max(1, Math.round(seconds / 60))} 分钟`;
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
  const [query, setQuery] = useState(initialQuery);
  const [explore, setExplore] = useState(initialExplore);
  const [region, setRegion] = useState('');
  const [availableRegions, setAvailableRegions] = useState<string[]>([]);
  const [response, setResponse] = useState<PodcastSearchResponse | null>(null);
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
    if (!explore) return;
    const controller = new AbortController();
    void api<{ regions: string[] }>('/podcasts/search-settings', { signal: controller.signal })
      .then((settings) => {
        if (!controller.signal.aborted) setAvailableRegions(settings.regions);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [explore]);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  useEffect(() => {
    if (selection) detailPanel.current?.focus();
  }, [selection]);

  function returnToResults() {
    setSelection(null);
    requestAnimationFrame(() => selectedCard.current?.focus());
  }

  useEffect(() => {
    searchAbort.current?.abort();
    setError(null);
    if (!term && !explore) {
      setResponse(null);
      setSearching(false);
      setSelection(null);
      return;
    }
    if (urlMode) {
      setResponse(null);
      setSearching(false);
      const timer = window.setTimeout(
        () => setSelection({ kind: 'url', feedUrl: term }),
        submitted ? 0 : SEARCH_DEBOUNCE_MS,
      );
      return () => window.clearTimeout(timer);
    }
    const controller = new AbortController();
    searchAbort.current = controller;
    setSearching(true);
    const timer = window.setTimeout(
      () => {
        api<PodcastSearchResponse>(
          term
            ? `/podcasts/search?q=${encodeURIComponent(term)}`
            : `/podcasts/discover${region ? `?region=${encodeURIComponent(region)}` : ''}`,
          {
            signal: controller.signal,
            timeoutMs: 30000,
          },
        )
          .then((value) => {
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
      },
      submitted ? 0 : SEARCH_DEBOUNCE_MS,
    );
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
    ? '打开节目'
    : state.inCatalog
      ? '关注并打开'
      : canAdd
        ? '添加并关注'
        : '管理员尚未开放添加节目';
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
        <button type="button" className="podcast-back-btn" onClick={onClose}>
          ← 返回电台
        </button>
        <div>
          <h2 id="podcast-search-title" ref={heading} tabIndex={-1}>
            {explore ? '探索播客' : canAdd ? '搜索或添加节目' : '搜索节目'}
          </h2>
          <p>找一个感兴趣的声音，先看看，再决定是否关注。</p>
        </div>
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
            aria-label="节目名称或 RSS 地址"
            placeholder="搜索节目名称，或粘贴 RSS 地址"
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
            aria-pressed={explore && !term}
            onClick={() => {
              setExplore(true);
              setQuery('');
              setSelection(null);
              setSubmitted((value) => value + 1);
            }}
          >
            热门探索
          </button>
          {explore && !term && (
            <label>
              区域{' '}
              <select
                aria-label="探索区域"
                value={region}
                onChange={(event) => {
                  setRegion(event.target.value);
                  setSelection(null);
                }}
              >
                <option value="">服务器默认</option>
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
          ? '已识别为 RSS 地址，将直接预览这个源。'
          : `通过 Apple Podcasts 目录${!term && explore ? '浏览热门节目' : '搜索'}${
              regions.length ? `：${regions.map(regionName).join(' · ')}` : ''
            }`}
      </p>

      <div className="podcast-search-body">
        <section
          className="podcast-search-results"
          aria-label="搜索结果"
          aria-busy={searching}
          hidden={urlMode && showDetail}
        >
          {searching && (
            <div className="podcast-search-status">{term ? '正在搜索…' : '正在加载热门节目…'}</div>
          )}
          {!searching && error && (
            <div className="modal-error-message" role="alert">
              {error.message}
              {error.retryAfter ? `（约 ${error.retryAfter} 秒后可重试）` : ''}
              <div className="podcast-search-retry">
                {!term && explore && (
                  <p>热门榜单暂时无法加载，可以重试、切换区域，或直接搜索节目名称。</p>
                )}
                <button type="button" onClick={() => setSubmitted((value) => value + 1)}>
                  重新加载
                </button>
              </div>
            </div>
          )}
          {!searching && !error && failed.length > 0 && (
            <div className="podcast-search-warning" role="status">
              部分区域暂时无法搜索：{failed.map((item) => regionName(item.region)).join('、')}
            </div>
          )}
          {!searching && !error && response && response.explicit_hidden > 0 && (
            <div className="podcast-search-status">
              已按管理员设置隐藏 {response.explicit_hidden} 个含成人内容的节目。
            </div>
          )}
          {!searching && !error && response && results.length === 0 && (
            <div className="podcast-search-empty">
              <strong>
                {term ? `没有找到与「${response.query}」相关的节目` : '这个区域暂无可用节目'}
              </strong>
              <span>换个关键词，或直接粘贴节目的 RSS 地址。</span>
            </div>
          )}
          {!term && !explore && (
            <div className="podcast-search-empty">
              <strong>输入节目名称开始搜索</strong>
              <span>也可以粘贴以 http:// 或 https:// 开头的 RSS 地址。</span>
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
                            <span className="podcast-search-explicit" title="含成人内容">
                              成人
                            </span>
                          )}
                        </span>
                        <span className="podcast-search-card-author">{item.author}</span>
                        <span className="podcast-search-card-meta">
                          {[
                            item.episode_count != null ? `${item.episode_count} 集` : '',
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
                            <span className="podcast-search-state followed">已关注</span>
                          ) : item.in_catalog ? (
                            <span className="podcast-search-state">本服已有</span>
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
            aria-label="节目预览"
            ref={detailPanel}
            tabIndex={-1}
          >
            {!urlMode && (
              <button type="button" className="podcast-search-back" onClick={returnToResults}>
                ← 返回结果
              </button>
            )}
            <div className="podcast-search-preview-head">
              <Artwork
                src={preview?.cover_url || result?.artwork_url || ''}
                title={preview?.title || result?.title || '节'}
              />
              <div>
                <h4>{preview?.title || result?.title || selectedFeed}</h4>
                <p>{preview?.author || result?.author}</p>
                {result?.explicit && <span className="podcast-search-explicit">含成人内容</span>}
              </div>
            </div>
            {previewing && <div className="podcast-search-status">正在读取 RSS 源…</div>}
            {previewError && (
              <div className="modal-error-message" role="alert">
                {previewError.message}
                {previewError.retryAfter ? `（约 ${previewError.retryAfter} 秒后可重试）` : ''}
              </div>
            )}
            {preview && (
              <>
                {preview.description && (
                  <p className="podcast-search-description">
                    {cleanPodcastDescription(preview.description)}
                  </p>
                )}
                <h5>最新单集 · 共 {preview.episode_count} 集</h5>
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
                  已关注 · 打开节目
                </button>
              ) : (
                <button
                  type="button"
                  className="modal-submit-btn primary"
                  disabled={actionDisabled}
                  onClick={() => void subscribe()}
                >
                  {busy ? '正在添加…' : actionLabel}
                </button>
              )}
            </div>
          </section>
        )}
      </div>
    </section>
  );
}
