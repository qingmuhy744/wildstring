import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface MatchedTrack {
  title: string;
  matched_title: string;
  track_id: string;
  album?: string;
  duration_ms: number;
  format: string;
}

export interface MissingTrack {
  title: string;
  album: string;
  year: string;
  rank: number;
  reason: string;
}

export interface CatalogGapData {
  artist: string;
  scope: string;
  total_target: number;
  matched_count: number;
  missing_count: number;
  coverage_percent: number;
  matched: MatchedTrack[];
  missing: MissingTrack[];
  summary: string;
}

interface Props {
  data: CatalogGapData;
  onPlayTrack?: (trackId: string) => void;
}

export const CatalogGapCard: React.FC<Props> = ({ data, onPlayTrack }) => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'missing' | 'matched'>(
    data.missing.length > 0 ? 'missing' : 'matched',
  );

  return (
    <div className="catalog-gap-card">
      <div className="gap-card-header">
        <div>
          <h4>{t('catalogGapCard.title', { artist: data.artist })}</h4>
          <span className="gap-card-sub">{t('catalogGapCard.subtitle')}</span>
        </div>
        <div className={`gap-badge ${data.coverage_percent === 100 ? 'perfect' : ''}`}>
          {t('catalogGapCard.coveragePercent', { percent: data.coverage_percent })}
        </div>
      </div>

      <div className="gap-progress-track">
        <div
          className="gap-progress-fill"
          style={{ width: `${Math.max(4, data.coverage_percent)}%` }}
        />
      </div>

      <p className="gap-summary">{data.summary}</p>

      <div className="gap-tabs">
        <button
          type="button"
          className={`gap-tab-btn ${tab === 'missing' ? 'active' : ''}`}
          onClick={() => setTab('missing')}
        >
          {t('catalogGapCard.tabMissing', { count: data.missing_count })}
        </button>
        <button
          type="button"
          className={`gap-tab-btn ${tab === 'matched' ? 'active' : ''}`}
          onClick={() => setTab('matched')}
        >
          {t('catalogGapCard.tabMatched', { count: data.matched_count })}
        </button>
      </div>

      <div className="gap-list">
        {tab === 'missing' ? (
          data.missing.length === 0 ? (
            <div className="gap-empty-hint">{t('catalogGapCard.emptyMissing')}</div>
          ) : (
            data.missing.map((item, idx) => (
              <div className="gap-item missing" key={idx}>
                <div className="gap-item-meta">
                  <div className="gap-item-title">{item.title}</div>
                  <div className="gap-item-desc">
                    {[item.album, item.year].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <span className="gap-status-tag missing">{t('catalogGapCard.statusMissing')}</span>
              </div>
            ))
          )
        ) : data.matched.length === 0 ? (
          <div className="gap-empty-hint">{t('catalogGapCard.emptyMatched')}</div>
        ) : (
          data.matched.map((item) => (
            <div className="gap-item matched" key={item.track_id}>
              <div className="gap-item-meta">
                <div className="gap-item-title">{item.title}</div>
                <div className="gap-item-desc">
                  {[item.album, item.format.toUpperCase()].filter(Boolean).join(' · ')}
                </div>
              </div>
              {onPlayTrack && (
                <button
                  type="button"
                  className="gap-play-btn"
                  onClick={() => onPlayTrack(item.track_id)}
                  title={t('catalogGapCard.playTrackTitle')}
                >
                  {t('catalogGapCard.playButton')}
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
