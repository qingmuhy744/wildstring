import { useEffect, useRef, useState } from 'react';
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
            throw new Error(`当前播放队列最多 ${QUEUE_LIMIT} 首，请缩小排行时间范围。`);
          items.push(...page.items);
          offset += page.items.length;
          if (offset >= page.total) break;
          if (!page.items.length) throw new Error('排行读取不完整，请刷新后重试。');
        }
      }
      if (c.signal.aborted || token !== epoch.current) return;
      const index = id ? items.findIndex((item) => item.track.id === id) : 0;
      if (index < 0) throw new Error('歌曲已不在当前榜单，请刷新。');
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
  return (
    <section className="listening-rankings" aria-label="收听排行">
      <div className="discovery-heading">
        <div>
          <span className="eyebrow">ON REPEAT</span>
          <h2>那些反复响起的。</h2>
          <p className="muted">
            {scope === 'personal'
              ? '这是你在野弦听过的歌曲。'
              : '这是本站用户的汇总收听热度，不展示个人记录。'}
          </p>
        </div>
        <div className="toolbar-actions">
          <button disabled={!rows.length || playing} onClick={() => void play()}>
            <Icon name="playlist" />
            {playing ? '正在准备队列…' : '播放排行'}
          </button>
          <button
            disabled={loading || playing}
            onClick={() => setRevision((value) => value + 1)}
            aria-label="刷新收听排行"
          >
            <Icon name="refresh" />
          </button>
        </div>
      </div>
      <div className="ranking-controls">
        <div className="workspace-tabs" role="group" aria-label="排行范围">
          <button aria-pressed={scope === 'personal'} onClick={() => setScope('personal')}>
            我常听
          </button>
          <button aria-pressed={scope === 'community'} onClick={() => setScope('community')}>
            大家常听
          </button>
        </div>
        <label>
          <span className="sr-only">排行时间范围</span>
          <select
            aria-label="排行时间范围"
            value={period}
            disabled={playing}
            onChange={(event) => setPeriod(event.target.value)}
          >
            <option value="7d">近 7 天</option>
            <option value="30d">近 30 天</option>
            <option value="90d">近 90 天</option>
            <option value="all">全部时间</option>
          </select>
        </label>
        <label>
          <span className="sr-only">排行指标</span>
          <select
            aria-label="排行指标"
            value={metric}
            disabled={playing}
            onChange={(event) => setMetric(event.target.value)}
          >
            <option value="plays">播放次数</option>
            <option value="listened_ms">收听时长</option>
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
              aria-label={`播放排行 ${item.track.title}`}
              disabled={playing}
              onClick={() => void play(item.track.id)}
            >
              <strong>{item.track.title}</strong>
              <small>{artist(item.track)}</small>
              <small>{item.reason}</small>
            </button>
            <span className="ranking-stat">
              {metric === 'plays' ? `${item.play_count} 次` : listeningTime(item.listened_ms)}
            </span>
            <FavoriteButton track={item.track} favorites={favorites} />
          </article>
        ))}
      </div>
      {!rows.length && !loading && !error && (
        <p className="workspace-empty">
          {scope === 'personal'
            ? '这段时间还没有收听记录，先放一首喜欢的歌。'
            : '这段时间还没有可用的全站收听记录。'}
        </p>
      )}
      {loading && (
        <p role="status" className="muted">
          正在读取收听排行…
        </p>
      )}
      {rows.length < total && (
        <button disabled={loading || playing} onClick={() => void more()}>
          查看更多排行 · {rows.length} / {total}
        </button>
      )}
    </section>
  );
}
