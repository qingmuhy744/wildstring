import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
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

interface ProviderResponse {
  suggestions: MetadataSuggestionItem[];
  jobs: Array<{ id: string; status: string }>;
  provider_names: Record<string, string>;
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
  const [appliedId, setAppliedId] = useState<string | null>(null);

  // 加载现存的建议
  const fetchSuggestions = async () => {
    try {
      setLoading(true);
      const res = await api<ProviderResponse>(
        `/manage/providers/tracks/${encodeURIComponent(trackId)}`,
      );
      setSuggestions(res.suggestions || []);
      setProviderNames(res.provider_names || {});
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
  }, [open, trackId]);

  // 触发联网查询
  const handleSearch = async () => {
    try {
      setSearching(true);
      await api('/manage/providers/query', {
        method: 'POST',
        body: JSON.stringify({ track_ids: [trackId] }),
      });
      // 轮询几次等待爬取完成
      setTimeout(async () => {
        await fetchSuggestions();
        setSearching(false);
      }, 1500);
    } catch {
      setSearching(false);
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
                  const score = item.match.score ? Math.round(item.match.score) : null;
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
