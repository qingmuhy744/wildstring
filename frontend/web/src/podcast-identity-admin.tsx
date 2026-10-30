import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';

type BackfillRun = {
  processed: number;
  matched: number;
  no_match: number;
  failed: number;
  ambiguous: number;
  finished_at?: string | null;
  stopped_reason?: string | null;
};

export type BackfillStatus = Partial<BackfillRun> & {
  running: boolean;
  paused_until?: number | null;
  last_run: BackfillRun | null;
  total: number;
  with_itunes_id: number;
  unchecked: number;
  counts: Record<string, number>;
};

type DuplicateShow = {
  id: string;
  title: string;
  author: string;
  feed_url: string;
  itunes_id: string | null;
  followers: number;
  episodes: number;
  downloaded: number;
  redirects: boolean;
};

export type DuplicatePair = {
  confidence: 'verified' | 'possible';
  reasons: string[];
  itunes_id: string | null;
  suggested_keep_id: string;
  podcasts: [DuplicateShow, DuplicateShow];
};

type MergeResult = {
  episodes_moved: number;
  episodes_matched: number;
  progress_moved: number;
  progress_replaced: number;
  downloads_moved: number;
  follows_moved: number;
};

const BASE = '/podcasts/identity';
const REASONS: Record<string, string> = {
  itunes_id: '同一个 Apple 编号',
  feed: '订阅地址相同或重定向到同一地址',
  title: '名称相同',
};

const pairKey = (pair: DuplicatePair) => pair.podcasts.map((show) => show.id).join('+');

export function PodcastIdentityAdmin() {
  const [status, setStatus] = useState<BackfillStatus | null>(null);
  const [pairs, setPairs] = useState<DuplicatePair[]>([]);
  const [hidden, setHidden] = useState(false);
  const [retryUnmatched, setRetryUnmatched] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [keep, setKeep] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState('');
  const wasRunning = useRef(false);

  const loadDuplicates = useCallback(async () => {
    const report = await api<{ duplicates: DuplicatePair[] }>(`${BASE}/duplicates`);
    setPairs(report.duplicates);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const value = await api<BackfillStatus>(`${BASE}/backfill`);
      setStatus(value);
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) setHidden(true);
      else setMessage(error instanceof Error ? error.message : '读取失败');
      return null;
    }
  }, []);

  useEffect(() => {
    void loadStatus().then((value) => {
      if (value) void loadDuplicates().catch((error: Error) => setMessage(error.message));
    });
  }, [loadStatus, loadDuplicates]);

  useEffect(() => {
    if (!status?.running) {
      if (wasRunning.current) {
        wasRunning.current = false;
        void loadDuplicates().catch(() => undefined);
      }
      return;
    }
    wasRunning.current = true;
    const timer = window.setTimeout(() => void loadStatus(), 2000);
    return () => window.clearTimeout(timer);
  }, [status, loadStatus, loadDuplicates]);

  if (hidden) return null;

  async function start() {
    setBusy('backfill');
    setMessage('');
    try {
      setStatus(
        await api<BackfillStatus>(`${BASE}/backfill`, {
          method: 'POST',
          body: JSON.stringify({ limit: 200, retry_unmatched: retryUnmatched }),
        }),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法开始回填');
    } finally {
      setBusy('');
    }
  }

  async function merge(pair: DuplicatePair) {
    const keepId = keep[pairKey(pair)] || pair.suggested_keep_id;
    const mergeId = pair.podcasts.find((show) => show.id !== keepId)?.id;
    if (!mergeId) return;
    setBusy(pairKey(pair));
    setMessage('');
    try {
      const result = await api<MergeResult>(`${BASE}/merge`, {
        method: 'POST',
        body: JSON.stringify({ keep_id: keepId, merge_id: mergeId }),
      });
      setMessage(
        `已合并：移入 ${result.episodes_moved} 集，对齐 ${result.episodes_matched} 集，` +
          `转移 ${result.follows_moved} 个关注、${result.progress_moved + result.progress_replaced} 条进度、` +
          `${result.downloads_moved} 个已下载文件。`,
      );
      setConfirming('');
      await Promise.all([loadDuplicates(), loadStatus()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '合并失败');
    } finally {
      setBusy('');
    }
  }

  const run = status?.running ? status : status?.last_run;
  const verified = pairs.filter((pair) => pair.confidence === 'verified');
  const possible = pairs.filter((pair) => pair.confidence === 'possible');

  return (
    <section className="management-card" aria-label="播客去重与回填">
      <h2>播客去重与回填</h2>
      <p className="muted">
        为早期添加的节目补上 Apple Podcasts 编号：按节目名称搜索，但只有 Apple 记录的 RSS
        地址和本节目的地址（或它重定向到的地址）一致时才采用，绝不只凭名称匹配。查询与用户搜索共用
        Apple 的调用额度，并给用户留出余量，所以节目多时会慢慢进行。
      </p>
      {status && (
        <p>
          共 {status.total} 个节目，已有 Apple 编号 {status.with_itunes_id} 个，待检查{' '}
          {status.unchecked} 个。
        </p>
      )}
      {run && (
        <p role="status" aria-label="回填进度">
          {status?.running
            ? status.paused_until
              ? `等待 Apple 频率限制…已检查 ${run.processed} 个`
              : `正在检查…已检查 ${run.processed} 个`
            : `上次回填：检查 ${run.processed} 个`}
          ，匹配 {run.matched}，未找到 {run.no_match}，失败 {run.failed}
          {run.ambiguous ? `（${run.ambiguous} 个在 Apple 有多个编号，取最早的）` : ''}
        </p>
      )}
      <label className="music-library-grant-option">
        <input
          type="checkbox"
          checked={retryUnmatched}
          disabled={Boolean(busy) || status?.running}
          onChange={(event) => setRetryUnmatched(event.target.checked)}
        />
        <span>重新检查此前未找到的节目</span>
      </label>
      <div className="podcast-search-settings-actions">
        <button
          type="button"
          disabled={Boolean(busy) || !status || status.running}
          onClick={() => void start()}
        >
          {status?.running ? '回填进行中…' : '开始回填'}
        </button>
      </div>

      <h3>重复节目</h3>
      {pairs.length === 0 ? (
        <p className="muted">没有发现重复的节目。</p>
      ) : (
        <ul className="podcast-duplicates" aria-label="重复节目">
          {[...verified, ...possible].map((pair) => {
            const id = pairKey(pair);
            const keepId = keep[id] || pair.suggested_keep_id;
            const isVerified = pair.confidence === 'verified';
            return (
              <li key={id} className="podcast-duplicate">
                <p>
                  <span
                    className={`podcast-duplicate-badge ${isVerified ? 'is-verified' : 'is-possible'}`}
                  >
                    {isVerified ? '已核实' : '疑似'}
                  </span>{' '}
                  {pair.reasons.map((reason) => REASONS[reason] || reason).join('、')}
                  {pair.itunes_id ? `（Apple 编号 ${pair.itunes_id}）` : ''}
                </p>
                <div className="podcast-duplicate-shows">
                  {pair.podcasts.map((show) => (
                    <label key={show.id} className="podcast-duplicate-show">
                      {isVerified && (
                        <input
                          type="radio"
                          name={`keep-${id}`}
                          checked={keepId === show.id}
                          disabled={Boolean(busy)}
                          onChange={() => setKeep({ ...keep, [id]: show.id })}
                          aria-label={`保留「${show.title}」${show.feed_url}`}
                        />
                      )}
                      <span>
                        <span>
                          <strong>{show.title}</strong>
                          {show.author ? ` · ${show.author}` : ''}
                        </span>
                        <small className="podcast-duplicate-feed">
                          {show.feed_url}
                          {show.redirects ? '（已重定向）' : ''}
                        </small>
                        <small>
                          关注 {show.followers} · 单集 {show.episodes} · 已下载 {show.downloaded}
                          {show.itunes_id ? '' : ' · 无 Apple 编号'}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
                {isVerified ? (
                  confirming === id ? (
                    <div className="podcast-search-settings-actions">
                      <span>
                        把另一个节目的关注、播放进度和已下载文件并入所选节目，然后删除它？
                      </span>
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() => void merge(pair)}
                      >
                        {busy === id ? '合并中…' : '确认合并'}
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() => setConfirming('')}
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <div className="podcast-search-settings-actions">
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() => setConfirming(id)}
                      >
                        合并到所选节目…
                      </button>
                    </div>
                  )
                ) : (
                  <p className="muted">
                    可信度不足，不会合并。请人工核对；如果确是同一节目，先运行回填核实 Apple 编号。
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
