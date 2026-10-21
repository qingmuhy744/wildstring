import { HelpText } from './desktop-help';
import { hints } from './help-content';
import { HelpLabel } from './desktop-help';
import { useEffect, useRef, useState } from 'react';
import { api, eventId } from './api';
import type { AgentDraft, AgentPage } from './agent-api';
import { OnlineLyrics } from './source-plugins';
import { MetadataRefreshDialog } from './metadata-refresh';
import { errorText } from './workspace-ui';
import { JobDiagnostics, type ProviderJob } from './provider-diagnostics';
import './metadata-review.css';

type Values = Record<string, unknown>;
type Candidate = {
  id: string;
  metadata_version: number;
  fields: Values;
  provider: string;
  source_url: string | null;
  cover_url: string | null;
  candidate_digest: string;
  duplicate_count?: number;
  match: Record<string, unknown>;
  stale?: boolean;
  stale_reason?: string | null;
};
export type ReviewTrack = {
  id: string;
  title: string;
  album: string;
  album_id: string;
  artists: string[];
  metadata_version: number;
  has_cover: boolean;
  current: Values;
  original: Values;
  overrides: Values;
  suggestions: Candidate[];
  disc_number: number | null;
  track_number: number | null;
};
type Album = { id: string; title: string; artists: string[]; count: number };
type ReviewPage = AgentPage<ReviewTrack> & {
  album_id: string;
  batch_id?: string | null;
  provider_names: Record<string, string>;
  release_lock?: {
    album_id: string;
    provider: string;
    release_id: string;
    source_url: string;
    version: number;
    snapshot: Values;
  } | null;
};
type Choice = { source: string; fields: string[] };
const names: Record<string, string> = {
  title: '歌名',
  artists: '歌曲艺人',
  album: '专辑',
  album_artists: '专辑艺人',
  artist_credit: '艺人署名',
  album_artist_credit: '专辑艺人署名',
  track_number: '曲序',
  disc_number: '碟号',
  track_total: '总曲数',
  disc_total: '总碟数',
  release_date: '发行日期',
  original_date: '首次发行日期',
  composers: '作曲',
  lyricists: '作词',
  arrangers: '编曲',
  vocalists: '演唱',
  genres: '风格',
  tags: '标签',
  external_ids: '外部标识',
  description: '简介',
};
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const candidateStale = (candidate: Candidate, track: ReviewTrack) =>
  candidate.stale ?? candidate.metadata_version !== track.metadata_version;
const display = (v: unknown): string =>
  v == null
    ? '未设置'
    : Array.isArray(v)
      ? v.join(' / ') || '未设置'
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v);
function candidateLabel(
  candidate: Candidate,
  track: ReviewTrack,
  providers: Record<string, string>,
) {
  const album =
    typeof candidate.fields.album === 'string' && candidate.fields.album
      ? candidate.fields.album
      : '未提供专辑';
  const title =
    typeof candidate.fields.title === 'string' && candidate.fields.title !== track.title
      ? candidate.fields.title
      : '';
  const date =
    typeof candidate.fields.release_date === 'string' ? candidate.fields.release_date : '';
  const score = candidate.match.score;
  return [
    providers[candidate.provider] || candidate.provider,
    title,
    album,
    date,
    typeof score === 'number' && Number.isFinite(score)
      ? `匹配度 ${Math.round(score <= 1 ? score * 100 : score)}%`
      : '',
    candidate.match.album_release_lock ? '与锁定发行冲突' : '',
    candidate.stale_reason || (candidateStale(candidate, track) ? '查询依据已变化' : ''),
  ]
    .filter(Boolean)
    .join(' · ');
}

function defaultChoice(track: ReviewTrack): Choice {
  const source = track.suggestions.find((s) => !candidateStale(s, track));
  return {
    source: source?.id || '',
    fields: source
      ? Object.keys(source.fields).filter(
          (k) => !same(track.current[k], source.fields[k]) && !Object.hasOwn(track.overrides, k),
        )
      : [],
  };
}

function releaseId(candidate: Candidate | undefined): string {
  if (!candidate) return '';
  if (typeof candidate.match.release_id === 'string') return candidate.match.release_id;
  const external = candidate.fields.external_ids;
  return external && typeof external === 'object' && !Array.isArray(external)
    ? typeof (external as Values).release === 'string'
      ? ((external as Values).release as string)
      : ''
    : '';
}

export function MetadataReviewWorkbench({
  initialTrackId,
  initialBatchId,
  onApplied,
  onBusy,
  onClose,
}: {
  initialTrackId?: string;
  initialBatchId?: string;
  onClose?: () => void;
  onApplied?: () => void | Promise<void>;
  onBusy?: (busy: boolean) => void;
}) {
  const [albums, setAlbums] = useState<Album[]>([]),
    [albumTotal, setAlbumTotal] = useState(0),
    [filter, setFilter] = useState('');
  const [page, setPage] = useState<ReviewPage | null>(null),
    [active, setActive] = useState(''),
    [choices, setChoices] = useState<Record<string, Choice>>({});
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [onlyChanges, setOnlyChanges] = useState(true),
    [tab, setTab] = useState('fields'),
    [cover, setCover] = useState<AgentDraft | null>(null),
    [coverAll, setCoverAll] = useState(false),
    [coverReady, setCoverReady] = useState(false);
  const [showSongs, setShowSongs] = useState(false);
  const [refresh, setRefresh] = useState(false),
    [conflicts, setConflicts] = useState<Record<string, string>>({});
  const [lockBusy, setLockBusy] = useState(false);
  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);
  const [jobs, setJobs] = useState<ProviderJob[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    setJobs([]);
    if (active)
      void api<{ jobs: ProviderJob[] }>(`/manage/providers/tracks/${encodeURIComponent(active)}`, {
        signal: controller.signal,
      })
        .then((value) => {
          if (!controller.signal.aborted) setJobs(value.jobs);
        })
        .catch(() => {});
    return () => controller.abort();
  }, [active, page]);
  const sequence = useRef(0),
    request = useRef(false),
    key = useRef({ signature: '', value: eventId() });
  const current = page?.items.find((t) => t.id === active),
    candidate = current?.suggestions.find((s) => s.id === choices[current.id]?.source);
  const selected = page?.items.filter((t) => (choices[t.id]?.fields.length || 0) > 0) || [];
  const fieldCount = selected.reduce((n, t) => n + choices[t.id].fields.length, 0);
  async function loadAlbums(append = false) {
    const result = await api<AgentPage<Album>>(
      `/agent/metadata-review/albums?limit=100&offset=${append ? albums.length : 0}`,
    );
    setAlbums((prior) => (append ? [...prior, ...result.items] : result.items));
    setAlbumTotal(result.total);
    return result.items;
  }
  async function load(query: string, next?: string, preserveOtherChoices = false) {
    const generation = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const result = await api<ReviewPage>(`/agent/metadata-review?limit=500&${query}`);
      if (generation !== sequence.current) return;
      setPage(result);
      setChoices((previous) =>
        Object.fromEntries(
          result.items.map((t) => {
            const choice = previous[t.id];
            if (
              preserveOtherChoices &&
              t.id !== next &&
              choice &&
              page?.items.find((old) => old.id === t.id)?.metadata_version === t.metadata_version &&
              t.suggestions.some((source) => source.id === choice.source)
            )
              return [t.id, choice];
            const fallback = defaultChoice(t);
            return [
              t.id,
              preserveOtherChoices && t.id === next ? { ...fallback, fields: [] } : fallback,
            ];
          }),
        ),
      );
      setActive(
        next && result.items.some((t) => t.id === next)
          ? next
          : result.items.find((t) => defaultChoice(t).fields.length)?.id ||
              result.items[0]?.id ||
              '',
      );
      setCover(null);
      setCoverReady(false);
      setConflicts({});
    } catch (reason) {
      if (generation === sequence.current) setError(errorText(reason));
    } finally {
      if (generation === sequence.current) setLoading(false);
    }
  }
  function pageQuery(value: ReviewPage, offset = value.offset) {
    return value.batch_id
      ? `batch_id=${encodeURIComponent(value.batch_id)}&offset=${offset}`
      : `album_id=${encodeURIComponent(value.album_id)}&offset=${offset}`;
  }
  useEffect(() => {
    let mounted = true;
    void loadAlbums()
      .then((items) => {
        if (!mounted) return;
        return load(
          initialTrackId
            ? `track_id=${encodeURIComponent(initialTrackId)}`
            : initialBatchId
              ? `batch_id=${encodeURIComponent(initialBatchId)}`
              : `album_id=${encodeURIComponent(items[0]?.id || '')}`,
          initialTrackId,
        );
      })
      .catch((e) => setError(errorText(e)));
    return () => {
      mounted = false;
      sequence.current++;
    };
  }, [initialTrackId, initialBatchId]);
  function choose(id: string, fields: string[]) {
    setChoices((old) => ({ ...old, [id]: { ...old[id], fields } }));
  }
  function nextItem() {
    if (!page || !current) return;
    setNotice('');
    setError('');
    const index = page.items.indexOf(current);
    setActive(page.items[(index + 1) % page.items.length]?.id || '');
    setTab('fields');
    setCover(null);
    setCoverReady(false);
  }
  async function rejectCurrent() {
    if (request.current || busy || loading || !current || !candidate || !page) return;
    request.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/agent/metadata-review/reject', {
        method: 'POST',
        body: JSON.stringify({
          track_id: current.id,
          suggestion_id: candidate.id,
          metadata_version: current.metadata_version,
          candidate_digest: candidate.candidate_digest,
        }),
      });
      await load(pageQuery(page), active, true);
      await loadAlbums();
      setNotice('已拒绝当前候选及其旧的重复记录，现有资料保持不变；其他候选和后续查询不受影响。');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      request.current = false;
      setBusy(false);
    }
  }
  async function accept(single = false) {
    if (request.current || busy || loading || !page || (cover && !coverReady)) return;
    const tracks = single ? selected.filter((t) => t.id === active) : selected;
    if (!tracks.length && !cover) return;
    request.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const items = tracks.map((t) => {
        const c = t.suggestions.find((s) => s.id === choices[t.id].source)!;
        return {
          track_id: t.id,
          suggestion_id: c.id,
          metadata_version: t.metadata_version,
          candidate_digest: c.candidate_digest,
          fields: choices[t.id].fields,
        };
      });
      const signature = JSON.stringify([items, cover?.id]);
      if (signature !== key.current.signature) key.current = { signature, value: eventId() };
      if (items.length) {
        const result = await api<{
          status: string;
          conflicts?: { track_id: string; error_code: string }[];
        }>('/agent/metadata-review/accept', {
          method: 'POST',
          body: JSON.stringify({
            items,
            idempotency_key: key.current.value,
            ...(cover ? { cover_draft_id: cover.id } : {}),
          }),
        });
        if (result.status !== 'applied') {
          setConflicts(
            Object.fromEntries((result.conflicts || []).map((c) => [c.track_id, c.error_code])),
          );
          setError('此批次未应用；有歌曲或候选发生变化，请重新读取后核对。');
          return;
        }
      } else if (cover)
        await api(`/agent/drafts/${cover.id}/accept`, {
          method: 'POST',
          body: JSON.stringify({
            version: cover.version,
            preview_digest: cover.preview_digest,
            idempotency_key: key.current.value,
          }),
        });
      const next = single
        ? page.items[(page.items.findIndex((t) => t.id === active) + 1) % page.items.length]?.id
        : undefined;
      window.dispatchEvent(new Event('wildstring:artwork-updated'));
      await onApplied?.();
      await load(pageQuery(page), next);
      await loadAlbums();
      setNotice(
        `已应用 ${tracks.length} 首的 ${items.reduce((n, i) => n + i.fields.length, 0)} 个字段${cover ? '及已预览封面' : ''}。`,
      );
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      request.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    function shortcut(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void accept();
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  });
  async function prepareCover() {
    if (!current || !candidate || busy || !page) return;
    setBusy(true);
    setError('');
    setCoverReady(false);
    try {
      const targets = (coverAll ? page.items : [current]).map((t) => ({
        track_id: t.id,
        metadata_version: t.metadata_version,
      }));
      const result = await api<AgentDraft>('/agent/metadata-review/cover', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'cover',
          title: `封面核对 · ${current.album || current.title}`,
          payload: {
            suggestion_id: candidate.id,
            metadata_version: current.metadata_version,
            targets,
          },
        }),
      });
      setCover(result);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function updateReleaseLock(clear = false) {
    if (!page || lockBusy) return;
    setLockBusy(true);
    setError('');
    try {
      if (clear) {
        const query = page.release_lock ? `?version=${page.release_lock.version}` : '';
        await api(`/manage/albums/${encodeURIComponent(page.album_id)}/release-lock${query}`, {
          method: 'DELETE',
        });
      } else {
        const id = releaseId(candidate);
        if (!candidate || !id) {
          setError('当前候选没有可锁定的发行版本 ID，请选择带发行信息的来源。');
          return;
        }
        await api(`/manage/albums/${encodeURIComponent(page.album_id)}/release-lock`, {
          method: 'PUT',
          body: JSON.stringify({
            provider: candidate.provider,
            release_id: id,
            source_url: candidate.source_url || '',
            snapshot: { album: current?.album, track_count: page.total, match: candidate.match },
            ...(page.release_lock ? { version: page.release_lock.version } : {}),
          }),
        });
      }
      await load(pageQuery(page), active, true);
      setNotice(
        clear
          ? '已解除专辑发行版本锁定。'
          : '已锁定当前发行版本；其他发行候选仍会保留，但不能自动应用。',
      );
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLockBusy(false);
    }
  }
  const disabled = busy || loading;
  return (
    <section className="metadata-review" aria-label="批量核对工作台">
      <header className="review-heading">
        <div>
          <h2>批量核对资料</h2>
          <p className="muted">只勾选需要的变化。已有人工值默认保留；勾选后会替换该字段。</p>
        </div>
        <div className="review-heading-actions">
          <button disabled={disabled} onClick={() => page && void load(pageQuery(page), active)}>
            重新读取候选
          </button>
          <button disabled={disabled || !current} onClick={() => setRefresh(true)}>
            重新查询
          </button>
          {onClose && (
            <button aria-label="关闭批量核对" disabled={busy} onClick={onClose}>
              关闭
            </button>
          )}
        </div>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="review-layout">
        <aside aria-label="待核对专辑">
          <label>
            筛选专辑
            <input value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          <ul>
            {albums
              .filter((a) =>
                `${a.title} ${a.artists.join(' ')}`.toLowerCase().includes(filter.toLowerCase()),
              )
              .map((a) => (
                <li key={a.id}>
                  <button
                    disabled={disabled}
                    aria-pressed={page?.album_id === a.id}
                    onClick={() => void load(`album_id=${encodeURIComponent(a.id)}`)}
                  >
                    <strong>{a.title}</strong>
                    <small>
                      {a.artists.join(' / ')} · {a.count} 首待核对
                    </small>
                  </button>
                </li>
              ))}
          </ul>
          {albums.length < albumTotal && (
            <button disabled={disabled} onClick={() => void loadAlbums(true)}>
              更多专辑
            </button>
          )}
        </aside>
        <main>
          <div className="review-album">
            <h3>{current?.album || page?.items[0]?.album || '暂无待核对专辑'}</h3>
            <p>
              {page?.total || 0} 首 · 本页 {page?.items.length || 0} 首
            </p>
            {!page?.batch_id && page?.release_lock ? (
              <p className="muted">
                已锁定发行版本：{page.release_lock.provider} · {page.release_lock.release_id}{' '}
                <button
                  disabled={disabled || lockBusy}
                  onClick={() => void updateReleaseLock(true)}
                >
                  解除锁定
                </button>
              </p>
            ) : !page?.batch_id ? (
              <p className="muted">
                尚未锁定发行版本；选择带 release ID 的候选后可固定，避免自动整理拆分专辑。{' '}
                <button
                  disabled={disabled || lockBusy || !releaseId(candidate)}
                  onClick={() => void updateReleaseLock()}
                >
                  锁定当前来源
                </button>
              </p>
            ) : (
              <p className="muted">
                本页按查询批次汇总候选；专辑发行版本锁定请在单张专辑核对时设置。
              </p>
            )}
            <button
              disabled={disabled || !page?.items.length}
              onClick={() =>
                setChoices(
                  Object.fromEntries((page?.items || []).map((t) => [t.id, defaultChoice(t)])),
                )
              }
            >
              勾选本页变化（保留人工值）
            </button>
            <button
              disabled={disabled}
              onClick={() =>
                setChoices((old) =>
                  Object.fromEntries(
                    Object.entries(old).map(([id, c]) => [id, { ...c, fields: [] }]),
                  ),
                )
              }
            >
              清空选择
            </button>
            <button
              className="review-song-toggle"
              aria-expanded={showSongs}
              onClick={() => setShowSongs(!showSongs)}
            >
              {showSongs ? '收起歌曲列表' : `选择歌曲（已选 ${selected.length} 首）`}
            </button>
          </div>
          {loading && <p role="status">正在读取专辑差异…</p>}
          {showSongs && (
            <div className="review-song-list" aria-label="专辑歌曲">
              {page?.items.map((t) => (
                <div key={t.id} className={active === t.id ? 'active' : ''}>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${t.title}`}
                    checked={!!choices[t.id]?.fields.length}
                    disabled={disabled}
                    onChange={(e) => choose(t.id, e.target.checked ? defaultChoice(t).fields : [])}
                  />
                  <button
                    disabled={disabled}
                    onClick={() => {
                      setActive(t.id);
                      setNotice('');
                      setError('');
                      setCover(null);
                      setCoverReady(false);
                    }}
                  >
                    <span>
                      {t.disc_number || 1}.{t.track_number || '—'} {t.title}
                    </span>
                    <small>
                      {conflicts[t.id]
                        ? '版本或来源冲突'
                        : t.suggestions.some((s) => !candidateStale(s, t))
                          ? `${choices[t.id]?.fields.length || 0} 个字段已选`
                          : '暂无有效候选'}
                    </small>
                  </button>
                </div>
              ))}
            </div>
          )}
          {page && page.total > page.limit && (
            <div className="workspace-actions">
              <button
                disabled={disabled || page.offset === 0}
                onClick={() => void load(pageQuery(page, Math.max(0, page.offset - page.limit)))}
              >
                上一页
              </button>
              <button
                disabled={disabled || page.offset + page.limit >= page.total}
                onClick={() => void load(pageQuery(page, page.offset + page.limit))}
              >
                下一页
              </button>
            </div>
          )}
          {current && (
            <article className="review-detail" aria-label="当前歌曲差异">
              <h3>{current.title}</h3>
              <p>{current.artists.join(' / ')}</p>
              <div className="workspace-actions">
                <label>
                  <HelpLabel hint="candidate">候选来源</HelpLabel>
                  <select
                    aria-label="候选来源"
                    value={choices[current.id]?.source || ''}
                    disabled={disabled}
                    onChange={(e) => {
                      setNotice('');
                      setError('');
                      const c = current.suggestions.find((s) => s.id === e.target.value)!;
                      setChoices((old) => ({
                        ...old,
                        [current.id]: {
                          source: c.id,
                          fields: !candidateStale(c, current)
                            ? Object.keys(c.fields).filter(
                                (k) =>
                                  !same(current.current[k], c.fields[k]) &&
                                  !Object.hasOwn(current.overrides, k),
                              )
                            : [],
                        },
                      }));
                      setCover(null);
                      setCoverReady(false);
                    }}
                  >
                    <option value="" disabled>
                      选择来源
                    </option>
                    {current.suggestions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {candidateLabel(c, current, page?.provider_names || {})}
                      </option>
                    ))}
                  </select>
                </label>
                <button disabled={disabled} onClick={() => setRefresh(true)}>
                  更新元数据
                </button>
              </div>
              {candidate && (candidate.duplicate_count || 1) > 1 && (
                <p className="muted review-candidate-note">
                  已合并 {candidate.duplicate_count} 条相同候选记录；不同发行版本仍分别保留。
                </p>
              )}
              {jobs.length > 0 && (
                <details open={jobs.some((j) => j.status === 'failed')}>
                  <summary>本曲最近查询记录</summary>
                  {jobs.map((job) => (
                    <JobDiagnostics key={job.id} job={job} />
                  ))}
                </details>
              )}
              <nav className="workspace-tabs" aria-label="核对内容">
                {[
                  ['fields', '文字资料'],
                  ['cover', '封面对比'],
                  ['lyrics', '歌词预览'],
                ].map(([id, label]) => (
                  <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
                    {label}
                  </button>
                ))}
              </nav>
              {tab === 'fields' && (
                <>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={onlyChanges}
                      onChange={(e) => setOnlyChanges(e.target.checked)}
                    />
                    只看变化字段
                  </label>
                  {candidate && !candidateStale(candidate, current) ? (
                    <>
                      <p className="muted">
                        来源：{page?.provider_names[candidate.provider] || candidate.provider} ·
                        信息版本 {candidate.metadata_version}
                        {candidate.stale_reason ? `（${candidate.stale_reason}）` : ''}
                      </p>
                      <table className="review-diff">
                        <thead>
                          <tr>
                            <th>字段</th>
                            <th>当前值</th>
                            <th>建议值</th>
                            <th>来源</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(candidate.fields)
                            .filter(([k, v]) => !onlyChanges || !same(current.current[k], v))
                            .map(([field, value]) => (
                              <tr key={field}>
                                <th>
                                  <label>
                                    <input
                                      type="checkbox"
                                      checked={choices[current.id]?.fields.includes(field) || false}
                                      aria-label={`采用 ${names[field] || field}`}
                                      disabled={disabled || candidateStale(candidate, current)}
                                      onChange={(e) =>
                                        choose(
                                          current.id,
                                          e.target.checked
                                            ? [...choices[current.id].fields, field]
                                            : choices[current.id].fields.filter((k) => k !== field),
                                        )
                                      }
                                    />
                                    {names[field] || field}
                                  </label>
                                  {Object.hasOwn(current.overrides, field) && (
                                    <small>
                                      <HelpText hint="manualValue">人工值</HelpText>
                                    </small>
                                  )}
                                </th>
                                <td data-label="当前值">{display(current.current[field])}</td>
                                <td data-label="建议值">{display(value)}</td>
                                <td data-label="来源">
                                  {candidate.source_url ? (
                                    <a href={candidate.source_url} target="_blank" rel="noreferrer">
                                      {page?.provider_names[candidate.provider] ||
                                        candidate.provider}{' '}
                                      ↗
                                    </a>
                                  ) : (
                                    candidate.provider
                                  )}
                                  <button
                                    disabled={disabled}
                                    onClick={() => {
                                      const on = !choices[current.id].fields.includes(field);
                                      setChoices((old) =>
                                        Object.fromEntries(
                                          (page?.items || []).map((t) => {
                                            const c = t.suggestions.find(
                                              (s) => s.id === old[t.id]?.source,
                                            );
                                            const fields = old[t.id]?.fields || [];
                                            return [
                                              t.id,
                                              {
                                                ...old[t.id],
                                                fields:
                                                  c && field in c.fields && !candidateStale(c, t)
                                                    ? on
                                                      ? [...new Set([...fields, field])]
                                                      : fields.filter((k) => k !== field)
                                                    : fields,
                                              },
                                            ];
                                          }),
                                        ),
                                      );
                                    }}
                                  >
                                    本页同字段
                                    {choices[current.id].fields.includes(field) ? '取消' : '勾选'}
                                  </button>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                      <details>
                        <summary>文件原始值与匹配依据</summary>
                        <dl>
                          {Object.entries(current.original).map(([k, v]) => (
                            <div key={k}>
                              <dt>{names[k] || k}</dt>
                              <dd>{display(v)}</dd>
                            </div>
                          ))}
                        </dl>
                        <pre>{JSON.stringify(candidate.match, null, 2)}</pre>
                      </details>
                    </>
                  ) : current.suggestions.length ? (
                    <p className="review-stale-notice" role="status">
                      当前候选的歌曲信息版本或查询依据已经变化，不能直接应用。请重新查询生成新的候选。
                      <button disabled={disabled} onClick={() => setRefresh(true)}>
                        重新查询本专辑
                      </button>
                    </p>
                  ) : (
                    <p>当前没有有效候选，可以查询新资料或跳过。</p>
                  )}
                </>
              )}
              {tab === 'cover' && (
                <>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={coverAll}
                      onChange={(e) => {
                        setCoverAll(e.target.checked);
                        setCover(null);
                        setCoverReady(false);
                      }}
                      disabled={disabled}
                    />
                    将此封面用于本页同专辑歌曲（{coverAll ? page?.items.length : 1} 首）
                  </label>
                  {candidate?.cover_url ? (
                    <button
                      disabled={disabled || candidateStale(candidate, current)}
                      onClick={() => void prepareCover()}
                    >
                      固定并预览此封面
                    </button>
                  ) : (
                    <p>此候选没有封面。</p>
                  )}
                  <div className="review-covers">
                    <figure>
                      {current.has_cover ? (
                        <img
                          src={`/api/v1/tracks/${current.id}/cover?size=320&v=${current.metadata_version}`}
                          alt="当前封面"
                        />
                      ) : (
                        <div className="review-no-cover">暂无封面</div>
                      )}
                      <figcaption>当前封面</figcaption>
                    </figure>
                    <figure>
                      {cover ? (
                        <img
                          key={cover.id}
                          src={`/api/v1/agent/drafts/${cover.id}/cover-preview?v=${cover.version}`}
                          alt="将采用的固定封面"
                          onLoad={() => setCoverReady(true)}
                          onError={() => {
                            setCoverReady(false);
                            setError('封面快照无法显示，本次不能应用。');
                          }}
                        />
                      ) : (
                        <div className="review-no-cover">先固定并预览候选</div>
                      )}
                      <figcaption>
                        将采用的封面
                        {cover
                          ? ` · ${Array.isArray(cover.payload.targets) ? cover.payload.targets.length : 1} 首`
                          : ''}
                      </figcaption>
                    </figure>
                  </div>
                </>
              )}
              {tab === 'lyrics' && (
                <OnlineLyrics
                  trackId={current.id}
                  applied={() => {
                    void onApplied?.();
                  }}
                />
              )}
            </article>
          )}
        </main>
      </div>
      <footer className="review-actions">
        <span>
          已选 {selected.length} 首 · {fieldCount} 个字段{cover ? ' · 含已预览封面' : ''}
        </span>
        <div>
          <button
            disabled={disabled || !current}
            data-help={hints.reviewSkip}
            onClick={() => {
              if (current) choose(current.id, []);
              nextItem();
            }}
          >
            本次跳过 / 下一首
          </button>
          <button
            disabled={disabled || !candidate}
            onClick={() => void rejectCurrent()}
            data-help={hints.reviewReject}
          >
            拒绝当前建议
          </button>
          <button
            disabled={
              disabled ||
              (!choices[active]?.fields.length && !cover) ||
              (!!cover && (!coverReady || coverAll))
            }
            data-help={hints.reviewAccept}
            onClick={() => void accept(true)}
          >
            接受本曲并下一首
          </button>
          <button
            className="primary"
            disabled={disabled || (!selected.length && !cover) || (!!cover && !coverReady)}
            data-help={hints.reviewAccept}
            onClick={() => void accept()}
          >
            {busy ? '应用中…' : '接受选中项'}
          </button>
        </div>
      </footer>
      {refresh && current && (
        <MetadataRefreshDialog
          target={{ scope: 'album', id: current.album_id, label: current.album }}
          onClose={() => setRefresh(false)}
          onQueued={() => setNotice('查询已排队，完成后点击重新读取。')}
        />
      )}
    </section>
  );
}

export function MetadataReviewDialog({
  trackId,
  batchId,
  onClose,
  onApplied,
}: {
  trackId?: string;
  batchId?: string;
  onClose: () => void;
  onApplied?: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    dialog.current?.showModal();
    return () => {
      document.documentElement.style.overflow = previous;
    };
  }, []);
  return (
    <dialog
      className="metadata-review-dialog"
      ref={dialog}
      aria-label="批量核对资料"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <MetadataReviewWorkbench
        initialTrackId={trackId}
        initialBatchId={batchId}
        onApplied={onApplied}
        onBusy={setBusy}
        onClose={onClose}
      />
    </dialog>
  );
}
