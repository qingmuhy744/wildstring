import { useEffect, useRef, useState } from 'react';
import { api, type Track, type TrackPage } from './api';
import { Pagination } from './track-list';
import { AISettings } from './ai-settings';

type Directory = {
  path: string;
  available: boolean;
  free_bytes: number | null;
  total_bytes: number | null;
};
type Run = {
  status: string;
  counts: Record<string, number>;
  errors: { path: string; code: string }[];
};
interface Job {
  id: string;
  kind: 'import' | 'scan';
  full: boolean;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  import: Run | null;
  scan: Run | null;
}
interface Jobs {
  items: Job[];
  total: number;
  limit: number;
  offset: number;
}
interface Overview {
  active_job: string | null;
  version: string;
  schema_version: number;
  preferences: { name: string; version: number };
  counts: { tracks: number; size_bytes: number; unavailable: number };
  albums: number;
  artists: number;
  source: Directory;
  library: Directory;
  data: Directory;
  last_scan: Run | null;
  deployment: { host: string; port: number; cookie_secure: boolean };
}
const statuses: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  completed: '已完成',
  completed_with_errors: '部分失败',
  failed: '失败',
  interrupted: '已中断',
};
const counterLabels: Record<string, string> = {
  visited: '检查',
  added: '新增',
  updated: '更新',
  unchanged: '未变化',
  errors: '错误',
  missing: '缺失',
  skipped: '跳过',
  copied: '复制',
  duplicates: '重复',
  assets_copied: '附属文件',
  conflicts: '冲突',
};
const errorLabels: Record<string, string> = {
  metadata_invalid: '标签无法读取',
  file_unreadable: '文件无法读取',
  file_changed: '文件已变化',
  root_unavailable: '曲库路径不可用',
  source_unavailable: '导入源不可用',
  source_directory_unreadable: '目录无法读取',
  import_file_unavailable: '文件导入失败',
  source_changed_managed_copy_preserved: '导入源已变化，已保留库内副本',
  source_changed_during_import: '导入时文件发生变化',
  directory_unreadable: '目录无法读取',
};
function bytes(value: number | null) {
  if (value === null) return '不可用';
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}
function timestamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : '—';
}
function RunDetail({ title, run }: { title: string; run: Run | null }) {
  return (
    run && (
      <section className="run-detail">
        <h4>
          {title} · {statuses[run.status] || run.status}
        </h4>
        <div className="run-counters">
          {Object.entries(run.counts).map(([key, n]) => (
            <span key={key}>
              {counterLabels[key] || key} <b>{n}</b>
            </span>
          ))}
        </div>
        {run.errors.length > 0 && (
          <ul className="run-errors">
            {run.errors.map((item, i) => (
              <li key={i}>
                <code>{item.path}</code>
                <span>{errorLabels[item.code] || item.code}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  );
}

export function Management({
  revision,
  onBack,
  onEdit,
  onChanged,
}: {
  revision: number;
  onBack: () => void;
  onEdit: (track: Track) => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'overview' | 'tracks' | 'jobs' | 'settings'>('overview');
  const finished = useRef<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null),
    [jobs, setJobs] = useState<Jobs | null>(null),
    [tracks, setTracks] = useState<TrackPage | null>(null);
  const [jobOffset, setJobOffset] = useState(0),
    [offset, setOffset] = useState(0),
    [draft, setDraft] = useState(''),
    [query, setQuery] = useState('');
  const [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [tick, setTick] = useState(0),
    [full, setFull] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api<Overview>('/manage/overview', { signal: controller.signal }),
      api<Jobs>(`/manage/jobs?limit=10&offset=${jobOffset}`, { signal: controller.signal }),
    ])
      .then(([info, list]) => {
        setOverview(info);
        setJobs(list);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [tick, revision, jobOffset]);
  useEffect(() => {
    if (!jobs) return;
    const signature = jobs.items
      .filter((job) => job.finished_at)
      .map((job) => job.id)
      .join(',');
    if (finished.current !== null && finished.current !== signature) onChanged();
    finished.current = signature;
  }, [jobs, onChanged]);
  useEffect(() => {
    if (overview) setName(overview.preferences.name);
  }, [overview?.preferences.name]);
  useEffect(() => {
    const timer = setInterval(() => setTick((v) => v + 1), 2000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    if (tab === 'tracks') {
      setTracks(null);
      api<TrackPage>(`/tracks?q=${encodeURIComponent(query)}&limit=25&offset=${offset}`, {
        signal: controller.signal,
      })
        .then(setTracks)
        .catch((reason) => {
          if (!controller.signal.aborted) setError(reason.message);
        });
    }
    return () => controller.abort();
  }, [tab, query, offset, revision]);
  async function start(kind: 'import' | 'scan') {
    setBusy(true);
    setError('');
    try {
      await api<Job>('/manage/jobs', {
        method: 'POST',
        body: JSON.stringify({ kind, full: kind === 'scan' && full }),
      });
      setJobOffset(0);
      setTab('jobs');
      setTick((v) => v + 1);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '任务提交失败。');
    } finally {
      setBusy(false);
    }
  }
  async function saveName() {
    if (!overview) return;
    setBusy(true);
    setError('');
    try {
      const preferences = await api<Overview['preferences']>('/manage/preferences', {
        method: 'PUT',
        body: JSON.stringify({ name, version: overview.preferences.version }),
      });
      setOverview({ ...overview, preferences });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '设置保存失败。');
    } finally {
      setBusy(false);
    }
  }
  const active = !!overview?.active_job;
  return (
    <main className="library management">
      <header className="management-header">
        <div>
          <span className="eyebrow">BEHIND THE MUSIC</span>
          <h1>曲库管理</h1>
          <p className="muted">让收藏井井有条，让音乐继续。</p>
        </div>
        <button
          onClick={() => {
            onChanged();
            onBack();
          }}
        >
          ← 返回音乐
        </button>
      </header>
      <nav className="management-tabs" aria-label="管理分类">
        {(
          [
            ['overview', '概览'],
            ['tracks', '歌曲信息'],
            ['jobs', '任务记录'],
            ['settings', '设置'],
          ] as const
        ).map(([key, label]) => (
          <button key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <p role="alert" className="error">
          {error}
          <button className="text-button" onClick={() => setTick((v) => v + 1)}>
            重新读取
          </button>
        </p>
      )}
      {loading ? (
        <p role="status">读取管理信息…</p>
      ) : (
        overview && (
          <>
            {tab === 'overview' && (
              <>
                <section className="management-metrics" aria-label="曲库概览">
                  {[
                    [overview.counts.tracks, '首歌曲'],
                    [overview.albums, '张专辑'],
                    [overview.artists, '位艺人'],
                    [bytes(overview.counts.size_bytes), '音乐大小'],
                  ].map(([n, label]) => (
                    <div key={label}>
                      <strong>{n}</strong>
                      <span>{label}</span>
                    </div>
                  ))}
                </section>
                <section className="management-card">
                  <span className="eyebrow">YOUR LIBRARY</span>
                  <h2>{overview.preferences.name}</h2>
                  <div className="library-locations">
                    {(
                      [
                        ['导入源', overview.source],
                        ['托管曲库', overview.library],
                      ] as const
                    ).map(([label, item]) => (
                      <div key={label}>
                        <strong>
                          {label}
                          <span className={`availability ${item.available ? '' : 'unavailable'}`}>
                            {item.available ? '可访问' : '不可访问'}
                          </span>
                        </strong>
                        <code>{item.path}</code>
                        <small>可用空间 {bytes(item.free_bytes)}</small>
                      </div>
                    ))}
                  </div>
                  <div className="management-task-actions">
                    <div>
                      <h3>导入新音乐</h3>
                      <p className="muted">从导入源复制新歌曲到曲库，已有副本保留。</p>
                      <button
                        className="primary"
                        disabled={busy || active || !overview.source.available}
                        onClick={() => void start('import')}
                      >
                        导入音乐
                      </button>
                    </div>
                    <div>
                      <h3>更新曲库信息</h3>
                      <p className="muted">检查库内文件变化，保留人工编辑的信息。</p>
                      <label className="management-checkbox">
                        <input
                          type="checkbox"
                          checked={full}
                          onChange={(e) => setFull(e.target.checked)}
                        />
                        重新读取全部标签
                      </label>
                      <button
                        disabled={busy || active || !overview.library.available}
                        onClick={() => void start('scan')}
                      >
                        扫描曲库
                      </button>
                    </div>
                  </div>
                  {active && (
                    <p role="status" className="muted">
                      曲库任务正在排队或执行，可在任务记录中查看进展。
                    </p>
                  )}
                  {!!overview.counts.unavailable && (
                    <p className="muted">
                      有 {overview.counts.unavailable} 首歌曲暂不可用。扫描任务会记录具体原因。
                    </p>
                  )}
                </section>
                <section className="management-card">
                  <h2>最近一次扫描</h2>
                  {overview.last_scan ? (
                    <RunDetail title="扫描" run={overview.last_scan} />
                  ) : (
                    <p className="muted">还没有扫描记录。</p>
                  )}
                </section>
              </>
            )}
            {tab === 'tracks' && (
              <section className="management-card">
                <div className="management-section-heading">
                  <div>
                    <h2>整理歌曲信息</h2>
                    <p className="muted">修改歌名、艺人与专辑，让每首歌回到它的位置。</p>
                  </div>
                  <form
                    className="manage-search"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setQuery(draft);
                      setOffset(0);
                    }}
                  >
                    <input
                      aria-label="搜索待编辑歌曲"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="搜索歌曲、艺人、专辑"
                      maxLength={256}
                    />
                    <button>搜索歌曲</button>
                  </form>
                </div>
                {tracks ? (
                  <>
                    <ul className="manage-track-list">
                      {tracks.items.map((track) => (
                        <li key={track.id}>
                          <div>
                            <strong>{track.title}</strong>
                            <span>
                              {track.artists.join(' / ') || '未知艺人'} ·{' '}
                              {track.album || '未知专辑'}
                            </span>
                          </div>
                          <button aria-label={`编辑 ${track.title}`} onClick={() => onEdit(track)}>
                            编辑信息
                          </button>
                        </li>
                      ))}
                    </ul>
                    {!tracks.total && <p className="muted">没有找到歌曲。</p>}
                    <Pagination page={tracks} onOffset={setOffset} unit="首" />
                  </>
                ) : (
                  <p role="status">读取歌曲…</p>
                )}
              </section>
            )}
            {tab === 'jobs' && (
              <section className="management-card">
                <div className="management-section-heading">
                  <h2>任务记录</h2>
                  <button onClick={() => setTick((v) => v + 1)}>刷新任务</button>
                </div>
                <p className="muted">任务在服务端继续执行，关闭页面不影响处理。</p>
                {!jobs?.total && (
                  <p className="management-empty">还没有网页任务。从概览开始导入或扫描。</p>
                )}
                {jobs?.items.map((job) => (
                  <details className="management-job" key={job.id}>
                    <summary>
                      <div>
                        <strong>
                          {job.kind === 'import' ? '导入音乐' : '扫描曲库'}
                          {job.full ? ' · 全量标签' : ''}
                        </strong>
                        <small>{timestamp(job.created_at)}</small>
                      </div>
                      <span className={`job-status ${job.status}`}>{statuses[job.status]}</span>
                    </summary>
                    <div className="management-job-body">
                      <p className="muted">
                        开始 {timestamp(job.started_at)} · 结束 {timestamp(job.finished_at)}
                      </p>
                      {job.error && (
                        <p role="status">
                          {job.error === 'waiting_for_library'
                            ? '等待其他曲库操作结束'
                            : job.error === 'worker_interrupted'
                              ? '服务中断，任务未完成。可从概览重新提交。'
                              : '执行未完成，请检查服务端日志后重新提交。'}
                        </p>
                      )}
                      <RunDetail title="导入" run={job.import} />
                      <RunDetail title="扫描" run={job.scan} />
                      {job.status === 'queued' && !job.error && (
                        <p className="muted">等待服务端开始处理。</p>
                      )}
                    </div>
                  </details>
                ))}
                {jobs && jobs.total > 10 && (
                  <Pagination page={jobs} onOffset={setJobOffset} unit="项" />
                )}
              </section>
            )}
            {tab === 'settings' && (
              <>
                <AISettings />
                <section className="management-card">
                  <h2>曲库设置</h2>
                  <form
                    className="library-settings-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveName();
                    }}
                  >
                    <label>
                      曲库名称
                      <input
                        required
                        maxLength={100}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </label>
                    <button
                      className="primary"
                      disabled={busy || name.trim() === overview.preferences.name}
                    >
                      {busy ? '保存中…' : '保存设置'}
                    </button>
                  </form>
                </section>
                <section className="management-card">
                  <h2>服务状态</h2>
                  <dl className="management-settings">
                    {[
                      ['版本', overview.version],
                      ['数据库版本', String(overview.schema_version)],
                      ['运行数据', overview.data.path],
                      ['服务端地址', `${overview.deployment.host}:${overview.deployment.port}`],
                      ['安全 Cookie', overview.deployment.cookie_secure ? '已启用' : '未启用'],
                      ['媒体标签写回', '未启用'],
                    ].map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="muted">
                    路径与网络设置由服务端部署配置管理，修改后需重启服务。首次设置或重置密码使用{' '}
                    <code>make docker-admin</code>。
                  </p>
                </section>
              </>
            )}
          </>
        )
      )}
    </main>
  );
}
