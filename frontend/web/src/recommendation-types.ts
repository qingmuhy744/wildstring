import type { Track } from './api';
export type RecommendationChoice = { track: Track; reason: string; source_ids?: string[] };
export interface SourceStatus {
  id: string;
  status: 'ok' | 'disabled' | 'empty' | 'unavailable';
  matched: number;
  candidate_count?: number;
  unmatched?: number;
  cached?: boolean;
  error_code?: string;
}
export interface RecommendationWarning {
  source: string;
  code: string;
}
export interface DailyRecommendation {
  id: string;
  date: string;
  items: RecommendationChoice[];
  engine: string;
  connection_id?: string;
  source_status?: SourceStatus[];
  warnings?: RecommendationWarning[];
  degraded?: boolean;
}
export interface RecommendationPreferences {
  version: number;
  use_ai: boolean;
  use_lastfm: boolean;
  count: number;
  connection_id?: string;
  sources?: string[];
  lastfm_tags?: string[];
  external_enabled?: boolean;
  external_refresh_days?: number;
  external_sources?: string[];
  external_use_ai?: boolean;
  daily_enabled?: boolean;
  daily_time?: string;
}
export const recommendationSources: Record<string, string> = {
  ai: '模型编排',
  local: '本地规则',
  personal: '我常听',
  community: '大家常听',
  discovery: '本地探索',
  revisit: '很久没听',
  lastfm_similar: 'Last.fm 相似关系',
  lastfm_charts: 'Last.fm 公共榜单',
  lastfm_tags: 'Last.fm 公共标签',
  lastfm_artists: 'Last.fm 相关艺人',
};
