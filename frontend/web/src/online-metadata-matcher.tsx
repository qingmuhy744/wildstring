import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Icon } from './icons';

export interface MetadataSuggestionItem {
  id: string;
  provider: string;
  source_url?: string;
  cover_url?: string;
  status: string;
  match: {
    score?: number;
    [key: string]: unknown;
  };
  fields: {
    title?: string;
    artists?: string[];
    album?: string;
    album_artists?: string[];
    track_number?: number;
    disc_number?: number;
    release_date?: string;
    original_date?: string;
    genres?: string[];
    label?: string;
    catalog_number?: string;
    [key: string]: unknown;
  };
}

interface SourceOption {
  id: string;
  name: string;
  kind?: string;
}

interface ProviderResponse {
  suggestions: MetadataSuggestionItem[];
  jobs: Array<{ id: string; status: string; updated_at?: number }>;
  provider_names: Record<string, string>;
  available_sources?: SourceOption[];
}

export function OnlineMetadataMatcher({
  trackId,
  currentTitle,
  currentArtist,
  onApply,
}: {
  trackId: string;
  currentTitle: string;
  currentArtist: string;
  onApply: (fields: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [queryTitle, setQueryTitle] = useState(currentTitle);
  const [queryArtist, setQueryArtist] = useState(currentArtist);
  const [suggestions, setSuggestions] = useState<MetadataSuggestionItem[]>([]);
  const [providerNames, setProviderNames] = useState<Record<string, string>>({});
  const [availableSources, setAvailableSources] = useState<SourceOption[]>([]);
  const [selectedSources, setSelectedSources] = useState<string[] | null>(null);
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchGeneration = useRef(0);

  const filteredSelection = selectedSources
    ? selectedSources.filter((id) => availableSources.some((source) => source.id === id))
    : null;
  const activeSelection =
    filteredSelection &&
    filteredSelection.length > 0 &&
    filteredSelection.length < availableSources.length
      ? filteredSelection
      : null;

  function toggleSource(id: string) {
    if (!activeSelection) {
      setSelectedSources([id]);
      return;
    }
    const next = activeSelection.includes(id)
      ? activeSelection.filter((item) => item !== id)
      : [...activeSelection, id];
    setSelectedSources(next.length === 0 || next.length >= availableSources.length ? null : next);
  }

  const applyResponse = (res: ProviderResponse) => {
    setSuggestions(res.suggestions || []);
    setProviderNames(res.provider_names || {});
    if (res.available_sources) {
      setAvailableSources(res.available_sources);
    }
    return res;
  };

  // 加载现存的建议
  const fetchSuggestions = async () => {
    try {
      setLoading(true);
      const res = await api<ProviderResponse>(
        `/manage/providers/tracks/${encodeURIComponent(trackId)}`,
      );
      applyResponse(res);
    } catch {
      // 忽略读取错误
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      void fetchSuggestions();
    }
    return () => {
      searchGeneration.current += 1;
      clearTimeout(pollTimer.current);
    };
  }, [open, trackId]);

  // 触发联网查询并用渐进退避轮询等待当前任务结束
  const handleSearch = async () => {
    searchGeneration.current += 1;
    const generation = searchGeneration.current;
    clearTimeout(pollTimer.current);
    try {
      setSearching(true);
      const payload: Record<string, unknown> = {
        track_ids: [trackId],
        interactive: true,
        force: true,
      };
      if (activeSelection) {
        payload.sources = activeSelection;
      }
      const trimmedTitle = queryTitle.trim();
      const trimmedArtist = queryArtist.trim();
      if (trimmedTitle) payload.query_title = trimmedTitle;
      if (trimmedArtist) payload.query_artist = trimmedArtist;
      await api('/manage/providers/query', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const delays = [250, 500, 1000, 1500, 2000];
      let attempt = 0;
      const poll = async () => {
        if (searchGeneration.current !== generation) return;
        try {
          const res = applyResponse(
            await api<ProviderResponse>(`/manage/providers/tracks/${encodeURIComponent(trackId)}`),
          );
          if (searchGeneration.current !== generation) return;
          const active = (res.jobs || []).some(
            (job) => job.status === 'queued' || job.status === 'running',
          );
          if (active && attempt < 12) {
            const delay = delays[Math.min(attempt, delays.length - 1)];
            attempt += 1;
            pollTimer.current = setTimeout(() => void poll(), delay);
            return;
          }
        } catch {
          // 忽略轮询读取错误，结束忙碌状态
        }
        if (searchGeneration.current === generation) {
          setSearching(false);
        }
      };
      pollTimer.current = setTimeout(() => void poll(), delays[0]);
      attempt = 1;
    } catch {
      if (searchGeneration.current === generation) {
        setSearching(false);
      }
    }
  };

  const handleApply = (item: MetadataSuggestionItem) => {
    onApply(item.fields);
    setAppliedId(item.id);
    setTimeout(() => setAppliedId(null), 3000);
  };

  return (
    <div className="online-metadata-matcher">
      <div className="online-matcher-header">
        <div className="online-matcher-title">
          <Icon name="assistant" />
          <span>{t('onlineMetadataMatcher.headerTitle')}</span>
        </div>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setOpen(!open);
            setQueryTitle(currentTitle);
            setQueryArtist(currentArtist);
          }}
        >
          {open
            ? t('onlineMetadataMatcher.collapseMatcher')
            : t('onlineMetadataMatcher.findOnlineMetadata')}
        </button>
      </div>

      {open && (
        <div className="online-matcher-body">
          <div className="matcher-search-bar">
            <div className="matcher-input-group">
              <label>
                <span>{t('onlineMetadataMatcher.fieldTitle')}</span>
                <input
                  type="text"
                  value={queryTitle}
                  onChange={(e) => setQueryTitle(e.target.value)}
                  placeholder={t('onlineMetadataMatcher.searchTitlePlaceholder')}
                />
              </label>
              <label>
                <span>{t('onlineMetadataMatcher.fieldArtist')}</span>
                <input
                  type="text"
                  value={queryArtist}
                  onChange={(e) => setQueryArtist(e.target.value)}
                  placeholder={t('onlineMetadataMatcher.searchArtistPlaceholder')}
                />
              </label>
            </div>
            {availableSources.length >= 2 && (
              <div
                className="matcher-source-chips"
                role="group"
                aria-label={t('onlineMetadataMatcher.sourceSelectorAria')}
              >
                <button
                  type="button"
                  disabled={searching}
                  aria-pressed={activeSelection === null}
                  onClick={() => setSelectedSources(null)}
                >
                  {t('onlineMetadataMatcher.allSources')}
                </button>
                {availableSources.map((source) => (
                  <button
                    key={source.id}
                    type="button"
                    disabled={searching}
                    aria-pressed={activeSelection !== null && activeSelection.includes(source.id)}
                    onClick={() => toggleSource(source.id)}
                  >
                    {source.name}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              className="primary-button"
              disabled={searching}
              onClick={handleSearch}
            >
              {searching
                ? t('onlineMetadataMatcher.searching')
                : t('onlineMetadataMatcher.searchButton')}
            </button>
          </div>

          {loading ? (
            <div className="matcher-loading">{t('onlineMetadataMatcher.loadingCandidates')}</div>
          ) : suggestions.length > 0 ? (
            <div className="matcher-results">
              <div className="matcher-results-caption">
                {t('onlineMetadataMatcher.resultsCaption')}
              </div>
              <ul className="matcher-card-list">
                {suggestions.slice(0, 5).map((item) => {
                  const title = item.fields.title || t('onlineMetadataMatcher.unknownTitle');
                  const artists =
                    (item.fields.artists || []).join(' / ') ||
                    t('onlineMetadataMatcher.unknownArtist');
                  const album = item.fields.album || t('onlineMetadataMatcher.unknownAlbum');
                  const date = item.fields.release_date || item.fields.original_date || '';
                  const trackNo = item.fields.track_number
                    ? t('onlineMetadataMatcher.trackNo', { number: item.fields.track_number })
                    : '';
                  const rawScore = item.match?.score;
                  const score =
                    typeof rawScore === 'number'
                      ? Math.round(rawScore <= 1 ? rawScore * 100 : rawScore)
                      : null;
                  const providerLabel = providerNames[item.provider] || item.provider;

                  return (
                    <li key={item.id} className="matcher-card">
                      <div className="matcher-card-art">
                        {item.cover_url ? (
                          <img
                            src={`/api/v1/manage/providers/suggestions/${item.id}/cover-preview`}
                            alt=""
                            onError={(e) => {
                              (e.target as HTMLElement).style.display = 'none';
                            }}
                          />
                        ) : (
                          <div className="matcher-art-fallback">
                            <Icon name="album" />
                          </div>
                        )}
                      </div>
                      <div className="matcher-card-info">
                        <div className="matcher-card-main">
                          <strong>{title}</strong>
                          <span className="matcher-meta-dot">·</span>
                          <span className="matcher-artist">{artists}</span>
                        </div>
                        <div className="matcher-card-sub">
                          <span>《{album}》</span>
                          {date && <span>{date}</span>}
                          {trackNo && <span>{trackNo}</span>}
                        </div>
                        <div className="matcher-card-badges">
                          <span className="source-badge">{providerLabel}</span>
                          {score !== null && (
                            <span className="score-badge">
                              {t('onlineMetadataMatcher.matchScore', { score })}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="matcher-card-action">
                        <button
                          type="button"
                          className={appliedId === item.id ? 'applied-button' : 'fill-button'}
                          onClick={() => handleApply(item)}
                        >
                          {appliedId === item.id
                            ? t('onlineMetadataMatcher.applied')
                            : t('onlineMetadataMatcher.fillForm')}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <div className="matcher-empty">
              <p>{t('onlineMetadataMatcher.emptyPrompt')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
