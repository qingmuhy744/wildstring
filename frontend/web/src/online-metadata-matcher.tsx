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
          <span>联网匹配与快速填充</span>
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
          {open ? '收起在线匹配' : '查找网络元数据 ↗'}
        </button>
      </div>

      {open && (
        <div className="online-matcher-body">
          <div className="matcher-search-bar">
            <div className="matcher-input-group">
              <label>
                <span>歌名</span>
                <input
                  type="text"
                  value={queryTitle}
                  onChange={(e) => setQueryTitle(e.target.value)}
                  placeholder="检索歌名"
                />
              </label>
              <label>
                <span>艺人</span>
                <input
                  type="text"
                  value={queryArtist}
                  onChange={(e) => setQueryArtist(e.target.value)}
                  placeholder="检索艺人"
                />
              </label>
            </div>
            <button
              type="button"
              className="primary-button"
              disabled={searching}
              onClick={handleSearch}
            >
              {searching ? '正在联网检索…' : '重新联网检索'}
            </button>
          </div>

          {loading ? (
            <div className="matcher-loading">正在读取网络候选…</div>
          ) : suggestions.length > 0 ? (
            <div className="matcher-results">
              <div className="matcher-results-caption">
                找到以下网络元数据候选（点击一键填入表单）：
              </div>
              <ul className="matcher-card-list">
                {suggestions.slice(0, 5).map((item) => {
                  const title = item.fields.title || '未知歌名';
                  const artists = (item.fields.artists || []).join(' / ') || '未知艺人';
                  const album = item.fields.album || '未知专辑';
                  const date = item.fields.release_date || item.fields.original_date || '';
                  const trackNo = item.fields.track_number
                    ? `第 ${item.fields.track_number} 首`
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
                          {score !== null && <span className="score-badge">匹配度 {score}%</span>}
                        </div>
                      </div>
                      <div className="matcher-card-action">
                        <button
                          type="button"
                          className={appliedId === item.id ? 'applied-button' : 'fill-button'}
                          onClick={() => handleApply(item)}
                        >
                          {appliedId === item.id ? '✓ 已填入下方' : '一键填入表单'}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <div className="matcher-empty">
              <p>
                暂无现成候选。您可以点击上方的「重新联网检索」，系统将自动通过已启用的音源与
                MusicBrainz 在线查找最佳匹配。
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
