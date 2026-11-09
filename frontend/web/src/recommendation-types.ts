import type { TFunction } from 'i18next';
import i18n from './i18n';
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
  get ai() {
    return i18n.t('recommendationTypes.sources.ai');
  },
  get local() {
    return i18n.t('recommendationTypes.sources.local');
  },
  get personal() {
    return i18n.t('recommendationTypes.sources.personal');
  },
  get community() {
    return i18n.t('recommendationTypes.sources.community');
  },
  get discovery() {
    return i18n.t('recommendationTypes.sources.discovery');
  },
  get revisit() {
    return i18n.t('recommendationTypes.sources.revisit');
  },
  get lastfm_similar() {
    return i18n.t('recommendationTypes.sources.lastfm_similar');
  },
  get lastfm_charts() {
    return i18n.t('recommendationTypes.sources.lastfm_charts');
  },
  get lastfm_tags() {
    return i18n.t('recommendationTypes.sources.lastfm_tags');
  },
  get lastfm_artists() {
    return i18n.t('recommendationTypes.sources.lastfm_artists');
  },
};
/** Source ids are stable API values; Chinese labels remain the fallback for unknown ids. */
export function recommendationSourceName(t: TFunction, id: string): string {
  return t(`recommendationTypes.sources.${id}`, {
    defaultValue: t(`recommendations.sources.${id}`, {
      defaultValue: recommendationSources[id] || id,
    }),
  });
}
