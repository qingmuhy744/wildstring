import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, artist, listeningTime, type Track } from './api';
import { Cover } from './cover';
import { FavoriteButton, type Favorites } from './favorites';
import type { Player } from './player';
import { QUEUE_LIMIT } from './playback-state';
import { errorText } from './workspace-ui';
import { Icon } from './icons';
interface RankingRow {
  rank: number;
  track: Track;
  play_count: number;
  listened_ms: number;
  reason: string;
}
interface RankingPage {
  items: RankingRow[];
  total: number;
  limit: number;
  offset: number;
  scope: string;
  period: string;
  metric: string;
  generated_at: string;
}
export function ListeningRankings({ player, favorites }: { player: Player; favorites: Favorites }) {
  const { t } = useTranslation();
  const [scope, setScope] = useState('personal'),
    [period, setPeriod] = useState('30d'),
    [metric, setMetric] = useState('plays'),
    [rows, setRows] = useState<RankingRow[]>([]),
    [total, setTotal] = useState(0),
    [loading, setLoading] = useState(false),
    [playing, setPlaying] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  const request = useRef<AbortController | null>(null),
    queueRequest = useRef<AbortController | null>(null),
    epoch = useRef(0);
  const query = new URLSearchParams({ scope, period, metric }).toString();
  async function load(offset: number, signal: AbortSignal) {
    const page = await api<RankingPage>(
      `/recommendations/rankings?${query}&limit=20&offset=${offset}`,
      { signal },
    );
    if (!signal.aborted) {
      setRows((old) => (offset ? [...old, ...page.items] : page.items));
      setTotal(page.total);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    ++epoch.current;
    request.current?.abort();
    queueRequest.current?.abort();
    request.current = controller;
    setRows([]);
    setTotal(0);
    setLoading(true);
    setError('');
    void load(0, controller.signal)
      .catch((reason) => {
        if (!controller.signal.aborted) setError(errorText(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      ++epoch.current;
      controller.abort();
      request.current?.abort();
      queueRequest.current?.abort();
    };
  }, [query, revision]);
  async function more() {
    if (loading) return;
    const c = new AbortController();
    request.current = c;
    setLoading(true);
    setError('');
    try {
      await load(rows.length, c.signal);
    } catch (reason) {
      if (!c.signal.aborted) setError(errorText(reason));
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }
  async function play(id?: string) {
    if (playing) return;
    const c = new AbortController(),
      token = epoch.current;
    queueRequest.current = c;
    setPlaying(true);
    setError('');
    try {
      let items = rows;
      if (rows.length < total) {
        items = [];
        let offset = 0;
        while (!c.signal.aborted) {
          const page = await api<RankingPage>(
            `/recommendations/rankings?${query}&limit=100&offset=${offset}`,
            { signal: c.signal },
          );
          if (page.total > QUEUE_LIMIT)
            throw new Error(t('rankings.queueLimit', { limit: QUEUE_LIMIT }));
          items.push(...page.items);
          offset += page.items.length;
          if (offset >= page.total) break;
          if (!page.items.length) throw new Error(t('rankings.incomplete'));
        }
      }
      if (c.signal.aborted || token !== epoch.current) return;
      const index = id ? items.findIndex((item) => item.track.id === id) : 0;
      if (index < 0) throw new Error(t('rankings.missing'));
      player.start(
        items.map((item) => item.track),
        index,
      );
    } catch (reason) {
      if (!c.signal.aborted) setError(errorText(reason));
    } finally {
      if (queueRequest.current === c) {
        queueRequest.current = null;
        setPlaying(false);
      }
    }
  }
  const days = period === 'all' ? 0 : Number(period.slice(0, -1));
  const reason =
    scope === 'personal'
      ? period === 'all'
        ? t('rankings.reasonPersonalAll')
        : t('rankings.reasonPersonalPeriod', { days })
      : period === 'all'
        ? t('rankings.reasonCommunityAll')
        : t('rankings.reasonCommunityPeriod', { days });
  return (
    <section className="listening-rankings" aria-label={t('rankings.aria')}>
      <div className="discovery-heading">
        <div>
          <h2>{t('rankings.title')}</h2>
          <p className="muted">
            {scope === 'personal' ? t('rankings.personalNote') : t('rankings.communityNote')}
          </p>
        </div>
        <div className="toolbar-actions">
          <button disabled={!rows.length || playing} onClick={() => void play()}>
            <Icon name="playlist" />
            {playing ? t('rankings.preparing') : t('rankings.play')}
          </button>
          <button
            disabled={loading || playing}
            onClick={() => setRevision((value) => value + 1)}
            aria-label={t('rankings.refreshAria')}
          >
            <Icon name="refresh" />
          </button>
        </div>
      </div>
      <div className="ranking-controls">
        <div className="workspace-tabs" role="group" aria-label={t('rankings.scopeAria')}>
          <button aria-pressed={scope === 'personal'} onClick={() => setScope('personal')}>
            {t('rankings.personal')}
          </button>
          <button aria-pressed={scope === 'community'} onClick={() => setScope('community')}>
            {t('rankings.community')}
          </button>
        </div>
        <label>
          <span className="sr-only">{t('rankings.periodAria')}</span>
          <select
            aria-label={t('rankings.periodAria')}
            value={period}
            disabled={playing}
            onChange={(event) => setPeriod(event.target.value)}
          >
            <option value="7d">{t('rankings.period7')}</option>
            <option value="30d">{t('rankings.period30')}</option>
            <option value="90d">{t('rankings.period90')}</option>
            <option value="all">{t('rankings.periodAll')}</option>
          </select>
        </label>
        <label>
          <span className="sr-only">{t('rankings.metricAria')}</span>
          <select
            aria-label={t('rankings.metricAria')}
            value={metric}
            disabled={playing}
            onChange={(event) => setMetric(event.target.value)}
          >
            <option value="plays">{t('rankings.plays')}</option>
            <option value="listened_ms">{t('rankings.listened')}</option>
          </select>
        </label>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="discovery-list">
        {rows.map((item) => (
          <article className="discovery-track ranking-track" key={item.track.id}>
            <span className="ranking-position">{String(item.rank).padStart(2, '0')}</span>
            <Cover trackId={item.track.id} title={item.track.title} />
            <button
              className="track-title"
              aria-label={t('rankings.playAria', { title: item.track.title })}
              disabled={playing}
              onClick={() => void play(item.track.id)}
            >
              <strong>{item.track.title}</strong>
              <small>{artist(item.track)}</small>
              <small>{reason}</small>
            </button>
            <span className="ranking-stat">
              {metric === 'plays'
                ? t('rankings.playsCount', { count: item.play_count })
                : listeningTime(item.listened_ms)}
            </span>
            <FavoriteButton track={item.track} favorites={favorites} />
          </article>
        ))}
      </div>
      {!rows.length && !loading && !error && (
        <p className="workspace-empty">
          {scope === 'personal' ? t('rankings.emptyPersonal') : t('rankings.emptyCommunity')}
        </p>
      )}
      {loading && (
        <p role="status" className="muted">
          {t('rankings.loading')}
        </p>
      )}
      {rows.length < total && (
        <button disabled={loading || playing} onClick={() => void more()}>
          {t('rankings.more', { loaded: rows.length, total })}
        </button>
      )}
    </section>
  );
}
