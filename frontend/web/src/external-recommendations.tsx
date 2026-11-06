import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type Track } from './api';
import type { Player } from './player';
import { Icon } from './icons';
import { errorText, localDate } from './workspace-ui';
import { RecommendationSources } from './recommendation-preferences';
import type {
  RecommendationPreferences,
  RecommendationWarning,
  SourceStatus,
} from './recommendation-types';
interface ExternalSuggestion {
  external_id: string;
  name: string;
  artists: string[];
  album: string | null;
  source_url: string;
  reason: string;
  evidence: { source: string; summary: string; url?: string }[];
  local_track: Track | null;
  wanted: boolean;
}
interface ExternalBatch {
  id: string;
  items: ExternalSuggestion[];
  wanted_items?: ExternalSuggestion[];
  generated_at: string | null;
  next_refresh_at: string | null;
  status: 'disabled' | 'manual' | 'ready' | 'empty' | 'unavailable';
  cached: boolean;
  stale: boolean;
  warnings: RecommendationWarning[];
  degraded: boolean;
  source_status: SourceStatus[];
  connection_id: string;
}
function sourceLink(raw: string) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (url.hostname === 'last.fm' || url.hostname.endsWith('.last.fm'))
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
export function ExternalRecommendations({
  preferences,
  player,
  onPreferences,
  onUsage,
}: {
  preferences: RecommendationPreferences;
  player: Player;
  onPreferences: () => void;
  onUsage: () => void;
}) {
  const { t } = useTranslation();
  const [batch, setBatch] = useState<ExternalBatch | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [filter, setFilter] = useState('all'),
    [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const mounted = useRef(true),
    request = useRef<AbortController | null>(null),
    pending = useRef(new Set<string>());
  async function load(manual = false) {
    if (request.current || pending.current.size) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const result = await api<ExternalBatch>(
        `/recommendations/external${manual ? '/refresh' : ''}`,
        {
          method: manual ? 'POST' : 'GET',
          ...(manual ? { body: '{}' } : {}),
          signal: controller.signal,
        },
      );
      if (!controller.signal.aborted && mounted.current) setBatch(result);
    } catch (reason) {
      if (!controller.signal.aborted && mounted.current) setError(errorText(reason));
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (mounted.current) {
          setLoading(false);
          onUsage();
        }
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      request.current?.abort();
      request.current = null;
    };
  }, []);
  async function feedback(item: ExternalSuggestion, action: 'want' | 'dismiss' | 'clear') {
    if (pending.current.has(item.external_id)) return;
    pending.current.add(item.external_id);
    setBusyIds(new Set(pending.current));
    setError('');
    const before = batch;
    setBatch(
      (current) =>
        current && {
          ...current,
          items:
            action === 'dismiss'
              ? current.items.filter((value) => value.external_id !== item.external_id)
              : current.items.map((value) =>
                  value.external_id === item.external_id
                    ? { ...value, wanted: action === 'want' }
                    : value,
                ),
          wanted_items: (current.wanted_items || []).filter(
            (value) => value.external_id !== item.external_id,
          ),
        },
    );
    try {
      await api('/recommendations/external/feedback', {
        method: 'POST',
        body: JSON.stringify({ external_id: item.external_id, action }),
      });
      if (mounted.current)
        setNotice(
          action === 'want'
            ? t('external.noticeWant')
            : 'clear' === action
              ? t('external.noticeClear')
              : t('external.noticeDismiss'),
        );
    } catch (reason) {
      if (mounted.current) {
        setBatch((current) => {
          if (!current || current.id !== before?.id) return current;
          const items = current.items.filter((value) => value.external_id !== item.external_id);
          items.splice(
            Math.min(
              before.items.findIndex((value) => value.external_id === item.external_id),
              items.length,
            ),
            0,
            item,
          );
          return {
            ...current,
            items,
            wanted_items: [
              ...(current.wanted_items || []).filter(
                (value) => value.external_id !== item.external_id,
              ),
              ...(before.wanted_items || []).filter(
                (value) => value.external_id === item.external_id,
              ),
            ],
          };
        });
        setError(errorText(reason));
      }
    } finally {
      pending.current.delete(item.external_id);
      if (mounted.current) setBusyIds(new Set(pending.current));
    }
  }
  async function copy(item: ExternalSuggestion) {
    const content = `${item.artists.join(' / ')} - ${item.name}`;
    try {
      if (!navigator.clipboard) throw new Error('clipboard_unavailable');
      await navigator.clipboard.writeText(content);
      if (mounted.current) setNotice(t('external.copied', { content }));
    } catch {
      if (mounted.current) setError(t('external.copyError', { content }));
    }
  }
  const allItems = [
    ...new Map(
      [...(batch?.wanted_items || []), ...(batch?.items || [])].map((item) => [
        item.external_id,
        item,
      ]),
    ).values(),
  ];
  const visible = allItems.filter((item) => filter !== 'wanted' || item.wanted);
  const enabled = !!preferences.external_enabled;
  return (
    <section className="external-recommendations" aria-label={t('external.aria')}>
      <div className="discovery-heading">
        <div>
          <span className="eyebrow">BEYOND YOUR SHELVES</span>
          <h2>{t('external.title')}</h2>
          <p className="muted">{t('external.subtitle')}</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" onClick={onPreferences}>
            {t('external.settings')}
          </button>
          <button
            className="primary"
            disabled={!enabled || loading || busyIds.size > 0}
            onClick={() => void load(true)}
          >
            <Icon name="refresh" />
            {loading
              ? t('external.loading')
              : batch?.items.length
                ? t('external.refresh')
                : t('external.get')}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
          <button disabled={loading} onClick={() => void load()}>
            {t('external.reload')}
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className="workspace-notice">
          {notice}
        </p>
      )}
      {!enabled ? (
        <div className="external-intro">
          <Icon name="album" />
          <div>
            <h3>{t('external.introTitle')}</h3>
            <p className="muted">{t('external.introBody')}</p>
            <button onClick={onPreferences}>{t('external.introAction')}</button>
          </div>
        </div>
      ) : (
        <>
          <p className="muted external-batch-status">
            {preferences.external_refresh_days === 0
              ? t('external.manual')
              : t('external.everyDays', { days: preferences.external_refresh_days ?? 7 })}
            {batch?.generated_at ? t('external.last', { date: localDate(batch.generated_at) }) : ''}
            {batch?.next_refresh_at
              ? t('external.next', { date: localDate(batch.next_refresh_at) })
              : ''}
            {batch?.cached ? t('external.cached') : ''}
            {batch?.stale ? t('external.stale') : ''}
          </p>
          <p className="external-boundary">
            {t('external.boundary')}{' '}
            {preferences.external_use_ai ? t('external.boundaryAi') : t('external.boundaryLocal')}
          </p>
          <div className="workspace-tabs" role="group" aria-label={t('external.filterAria')}>
            <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              {t('external.all')}
            </button>
            <button aria-pressed={filter === 'wanted'} onClick={() => setFilter('wanted')}>
              {t('external.wanted', { count: allItems.filter((item) => item.wanted).length })}
            </button>
          </div>
          {loading && (
            <p role="status" className="muted">
              {t('external.loadingList')}
            </p>
          )}
          <div className="external-suggestion-grid">
            {visible.map((item) => {
              const link = sourceLink(item.source_url);
              return (
                <article className="external-suggestion" key={item.external_id}>
                  <div className="external-suggestion-head">
                    <span className="external-placeholder">
                      <Icon name="album" />
                    </span>
                    <div>
                      <h3>{item.name}</h3>
                      <p>{item.artists.join(' / ') || t('external.artistUnknown')}</p>
                      {item.album && <small>{item.album}</small>}
                    </div>
                    <span className="workspace-badge">
                      {item.local_track ? t('external.inLibrary') : t('external.clue')}
                    </span>
                  </div>
                  <p className="external-reason">{item.reason}</p>
                  <details>
                    <summary>{t('external.evidence')}</summary>
                    {item.evidence.map((evidence, index) => (
                      <p className="muted" key={index}>
                        <strong>{evidence.source}</strong> · {evidence.summary}
                      </p>
                    ))}
                  </details>
                  <div className="external-suggestion-actions">
                    {item.local_track && (
                      <button
                        onClick={() => player.start([item.local_track!], 0)}
                        aria-label={t('external.playLocalAria', { name: item.name })}
                      >
                        {t('external.playLocal')}
                      </button>
                    )}
                    <button
                      disabled={busyIds.has(item.external_id)}
                      aria-pressed={item.wanted}
                      onClick={() => void feedback(item, item.wanted ? 'clear' : 'want')}
                    >
                      {item.wanted ? t('external.wantedOn') : t('external.wantedOff')}
                    </button>
                    <button onClick={() => void copy(item)}>{t('external.copy')}</button>
                    {link && (
                      <a
                        className="external-source-link"
                        href={link}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t('external.lastfm')}
                      </a>
                    )}
                    <button
                      className="text-button"
                      disabled={busyIds.has(item.external_id)}
                      onClick={() => void feedback(item, 'dismiss')}
                    >
                      {t('external.dismiss')}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          {!visible.length && !loading && !error && (
            <p className="workspace-empty">
              {filter === 'wanted'
                ? t('external.emptyWanted')
                : batch?.status === 'unavailable'
                  ? t('external.emptyUnavailable')
                  : batch?.status === 'manual'
                    ? t('external.emptyManual')
                    : t('external.emptyOther')}
            </p>
          )}
          <RecommendationSources
            items={batch?.source_status}
            warnings={batch?.warnings}
            degraded={batch?.degraded}
          />
        </>
      )}
    </section>
  );
}
