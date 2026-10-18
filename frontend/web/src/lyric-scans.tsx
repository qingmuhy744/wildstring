import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { OnlineLyrics } from './source-plugins';

const levels = ['无歌词', '静态歌词', '逐行动态', '双语逐行动态', '逐字动态', '双语逐字动态'];
const statuses: Record<string, string> = {
  running: '扫描中',
  queued: '等待',
  paused: '已暂停',
  completed: '扫描结束',
  cancelled: '已取消',
  ready: '可升级',
  review: '待核对',
  no_match: '未匹配',
  failed: '失败',
  locked: '已锁定',
  skipped_goal: '已满足目标',
  skipped_scanned: '已扫跳过',
  stale: '歌曲已变化',
  applied: '已启用',
  restored: '已恢复',
};
type RateSettings = {
  default_profile: string;
  low_seconds: number;
  medium_seconds: number;
  high_seconds: number;
  version: number;
};
type Quality = {
  level: number;
  label: string;
  word_coverage: number;
  translation_coverage: number;
};
type ScanItem = {
  id: string;
  track_id: string;
  title: string;
  status: string;
  error: string | null;
  baseline: Quality | null;
  quality: Quality | null;
  results: Record<string, { status: string; error?: string }>;
};
type Scan = {
  id: string;
  status: string;
  total: number;
  created_at: number;
  counts: Record<string, number>;
  items: ScanItem[];
  options: { scope: string; scope_id: string | null; goal: number; interval_seconds: number };
  cooldowns: { plugin_id: string; cooldown_until: number; reason: string }[];
};

export function LyricScans({ albumId }: { albumId?: string }) {
  const [goal, setGoal] = useState(5),
    [mode, setMode] = useState('upgrade');
  const [preference, setPreference] = useState('timing'),
    [interval, setIntervalValue] = useState(5);
  const [rateProfile, setRateProfile] = useState('low');
  const [defaults, setDefaults] = useState<RateSettings | null>(null);
  const [force, setForce] = useState(false),
    [preview, setPreview] = useState<number | null>(null);
  const [scans, setScans] = useState<Scan[]>([]),
    [batch, setBatch] = useState<Scan | null>(null);
  const [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [confirmation, setConfirmation] = useState<'apply' | 'cancel' | null>(null);
  const endpoint = '/manage/lyric-scans';
  const options = {
    scope: albumId ? 'album' : 'library',
    scope_id: albumId ?? null,
    mode,
    goal: mode === 'missing' ? 1 : goal,
    preference,
    rate_profile: rateProfile,
    interval_seconds: interval,
    force,
  };
  const optionsKey = JSON.stringify(options);
  useEffect(() => setPreview(null), [optionsKey]);
  async function load(id = batch?.id, pageOffset = offset) {
    const list = await api<{ items: Scan[] }>(endpoint);
    setScans(list.items.filter((s) => !albumId || s.options.scope_id === albumId));
    if (id) setBatch(await api<Scan>(`${endpoint}/${id}?offset=${pageOffset}&limit=50`));
  }
  useEffect(() => {
    void load().catch((error) => setMessage(String(error)));
    void api<RateSettings>('/manage/lyric-scan-settings')
      .then((value) => {
        setDefaults(value);
        setRateProfile(value.default_profile);
      })
      .catch((error) => setMessage(String(error)));
  }, [albumId]);
  useEffect(() => {
    if (!batch || batch.status !== 'running') return;
    let disposed = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible')
        void api<Scan>(`${endpoint}/${batch.id}?offset=${offset}&limit=50`)
          .then((result) => {
            if (!disposed) setBatch(result);
          })
          .catch((error) => {
            if (!disposed) setMessage(String(error));
          });
    }, 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [batch?.id, batch?.status, offset]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  async function control(action: string) {
    if (!batch) return;
    await run(async () => {
      setBatch(
        await api(`${endpoint}/${batch.id}/control`, {
          method: 'POST',
          body: JSON.stringify({ action }),
        }),
      );
      setConfirmation(null);
      await load();
    });
  }
  return (
    <section className="management-card lyric-scans" aria-label="歌词补全与洗版">
      <h3>{albumId ? '专辑歌词补全与洗版' : '歌词补全与洗版'}</h3>
      <p className="muted">
        慢速查找更好的歌词，确认后启用。锁定歌曲会跳过；原歌词可恢复，音乐文件保持原样。
      </p>
      <fieldset disabled={busy || !defaults} className="lyric-scan-options">
        <label>
          扫描模式
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="upgrade">歌词洗版</option>
            <option value="missing">仅补缺失</option>
          </select>
        </label>
        {mode === 'upgrade' && (
          <label>
            目标等级
            <select value={goal} onChange={(e) => setGoal(Number(e.target.value))}>
              {levels.slice(1).map((label, i) => (
                <option value={i + 1} key={label}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          洗版偏好
          <select value={preference} onChange={(e) => setPreference(e.target.value)}>
            <option value="timing">逐字优先</option>
            <option value="bilingual">双语优先</option>
          </select>
        </label>
        <label>
          请求频率
          <select value={rateProfile} onChange={(e) => setRateProfile(e.target.value)}>
            <option value="low">低频（{defaults?.low_seconds ?? 10}秒）</option>
            <option value="medium">中频（{defaults?.medium_seconds ?? 5}秒）</option>
            <option value="high">高频（{defaults?.high_seconds ?? 2}秒）</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        {rateProfile === 'custom' && (
          <label>
            来源请求最短间隔（秒）
            <input
              type="number"
              min={1}
              max={120}
              value={interval}
              onChange={(e) => setIntervalValue(Number(e.target.value))}
            />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          强制重扫已查记录和缓存
        </label>
      </fieldset>
      <p className="muted">
        后台默认低频，每来源串行、不突发放量；旧插件未声明请求级限速时按调用级控制。未匹配记录会保留，普通扫描复用已有结果。双语逐字指原文逐字高亮、译文同步显示。
      </p>
      <div className="button-row">
        <button
          disabled={busy || interval < 1 || interval > 120 || !Number.isInteger(interval)}
          onClick={() =>
            void run(async () => {
              const result = await api<{ total: number }>(`${endpoint}/preview`, {
                method: 'POST',
                body: optionsKey,
              });
              setPreview(result.total);
            })
          }
        >
          检查扫描范围
        </button>
        {preview !== null && (
          <>
            <span>本次范围：{preview} 首</span>
            <button
              className="primary"
              disabled={busy || preview === 0}
              onClick={() =>
                void run(async () => {
                  const result = await api<Scan>(endpoint, { method: 'POST', body: optionsKey });
                  setBatch(result);
                  setOffset(0);
                  setSelected([]);
                  await load(result.id, 0);
                })
              }
            >
              开始后台扫描
            </button>
          </>
        )}
        <button disabled={busy} onClick={() => void run(() => load())}>
          刷新任务
        </button>
      </div>
      <p role="status">{message}</p>
      {defaults && (
        <details>
          <summary>扫描频率默认设置</summary>
          <fieldset disabled={busy} className="lyric-scan-options">
            {(['low', 'medium', 'high'] as const).map((key) => {
              const field = `${key}_seconds` as 'low_seconds' | 'medium_seconds' | 'high_seconds';
              return (
                <label key={key}>
                  {{ low: '低频', medium: '中频', high: '高频' }[key]}间隔（秒）
                  <input
                    type="number"
                    min={1}
                    max={120}
                    value={defaults[field]}
                    onChange={(e) => setDefaults({ ...defaults, [field]: Number(e.target.value) })}
                  />
                </label>
              );
            })}
            <label>
              后台默认频率
              <select
                value={defaults.default_profile}
                onChange={(e) => setDefaults({ ...defaults, default_profile: e.target.value })}
              >
                <option value="low">低频</option>
                <option value="medium">中频</option>
                <option value="high">高频</option>
              </select>
            </label>
            <button
              disabled={
                busy ||
                defaults.low_seconds < defaults.medium_seconds ||
                defaults.medium_seconds < defaults.high_seconds ||
                [defaults.low_seconds, defaults.medium_seconds, defaults.high_seconds].some(
                  (v) => !Number.isInteger(v) || v < 1 || v > 120,
                )
              }
              onClick={() =>
                void run(async () => {
                  setDefaults(
                    await api<RateSettings>('/manage/lyric-scan-settings', {
                      method: 'PUT',
                      body: JSON.stringify(defaults),
                    }),
                  );
                  setMessage('默认频率已保存，新建任务使用新设置。');
                })
              }
            >
              保存频率默认值
            </button>
          </fieldset>
        </details>
      )}
      {scans.length > 0 && (
        <details open={!batch}>
          <summary>最近的扫描任务</summary>
          <div className="lyric-scan-history">
            {scans.map((scan) => (
              <button
                key={scan.id}
                onClick={() =>
                  void run(async () => {
                    setOffset(0);
                    setSelected([]);
                    setExpanded('');
                    await load(scan.id, 0);
                  })
                }
              >
                {new Date(scan.created_at * 1000).toLocaleString()} · {scan.total} 首 ·{' '}
                {statuses[scan.status] ?? scan.status}
              </button>
            ))}
          </div>
        </details>
      )}
      {batch && (
        <div aria-label="歌词扫描进度">
          <p className="muted">本任务每来源请求间隔：{batch.options.interval_seconds} 秒</p>
          <h4>
            {statuses[batch.status]} · {batch.total} 首
          </h4>
          <div className="lyric-scan-counts">
            {Object.entries(batch.counts).map(([state, count]) => (
              <span key={state}>
                {statuses[state] ?? state} {count}
              </span>
            ))}
          </div>
          {batch.cooldowns.map((c) => (
            <p key={c.plugin_id}>
              {c.plugin_id} 正在冷却至 {new Date(c.cooldown_until * 1000).toLocaleTimeString()} ·{' '}
              {c.reason}
            </p>
          ))}
          <div className="button-row">
            {batch.status === 'running' && (
              <button disabled={busy} onClick={() => void control('pause')}>
                暂停扫描
              </button>
            )}
            {batch.status === 'paused' && (
              <button disabled={busy} onClick={() => void control('resume')}>
                继续扫描
              </button>
            )}
            {['running', 'paused'].includes(batch.status) && (
              <button disabled={busy} onClick={() => setConfirmation('cancel')}>
                取消任务
              </button>
            )}
            {batch.status !== 'running' && (
              <button disabled={busy} onClick={() => void control('retry_failed')}>
                仅重试失败
              </button>
            )}
            <button
              disabled={busy || !batch.items.some((i) => i.status === 'ready')}
              onClick={() =>
                setSelected(batch.items.filter((i) => i.status === 'ready').map((i) => i.id))
              }
            >
              选择本页可升级
            </button>
            <button disabled={busy || !selected.length} onClick={() => setConfirmation('apply')}>
              确认选中歌词（{selected.length}）
            </button>
          </div>
          {confirmation && (
            <div className="lyric-scan-confirm" role="group" aria-label="确认歌词操作">
              <p>
                {confirmation === 'apply'
                  ? `启用选中的 ${selected.length} 首歌词？已有能力不会降级，歌曲发生变化时会跳过。`
                  : '取消尚未完成的查询？已找到的候选会保留。'}
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  confirmation === 'cancel'
                    ? void control('cancel')
                    : void run(async () => {
                        const result = await api<{ items: { status: string }[] }>(
                          `${endpoint}/${batch.id}/apply`,
                          { method: 'POST', body: JSON.stringify({ item_ids: selected }) },
                        );
                        setMessage(
                          `已启用 ${result.items.filter((i) => i.status === 'applied').length} 首；冲突 ${result.items.filter((i) => i.status === 'conflict').length} 首。`,
                        );
                        setSelected([]);
                        setConfirmation(null);
                        batch.items.forEach((i) =>
                          window.dispatchEvent(
                            new CustomEvent('wildstring:lyrics-updated', { detail: i.track_id }),
                          ),
                        );
                        await load();
                      })
                }
              >
                确定
              </button>
              <button disabled={busy} onClick={() => setConfirmation(null)}>
                返回
              </button>
            </div>
          )}
          <ul className="lyric-scan-items">
            {batch.items.map((item) => (
              <li key={item.id}>
                <div className="lyric-scan-item-heading">
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${item.title}`}
                      disabled={item.status !== 'ready' || busy}
                      checked={selected.includes(item.id)}
                      onChange={(e) =>
                        setSelected((ids) =>
                          e.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id),
                        )
                      }
                    />
                    <strong>{item.title}</strong>
                  </label>
                  <span>{statuses[item.status] ?? item.status}</span>
                </div>
                <p>
                  {item.baseline?.label ?? '尚未检查'}
                  {item.quality && ` → ${item.quality.label}`}
                </p>
                {item.error && <p role="status">来源问题：{item.error}</p>}
                <div className="button-row">
                  <button
                    disabled={busy}
                    onClick={() => setExpanded(expanded === item.id ? '' : item.id)}
                  >
                    预览与其他候选
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const lock = await api<{ version: number; locked: boolean }>(
                          `/manage/tracks/${item.track_id}/lyric-lock`,
                        );
                        await api(`/manage/tracks/${item.track_id}/lyric-lock`, {
                          method: 'PUT',
                          body: JSON.stringify({ ...lock, locked: !lock.locked }),
                        });
                        setMessage(lock.locked ? '已解锁，可在新扫描中查询。' : '当前歌词已锁定。');
                      })
                    }
                  >
                    锁定／解锁歌词
                  </button>
                  {item.status === 'applied' && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api(`/manage/lyric-scan-items/${item.id}/restore`, {
                            method: 'POST',
                          });
                          window.dispatchEvent(
                            new CustomEvent('wildstring:lyrics-updated', { detail: item.track_id }),
                          );
                          await load();
                        })
                      }
                    >
                      恢复洗版前歌词
                    </button>
                  )}
                </div>
                {expanded === item.id && (
                  <OnlineLyrics
                    trackId={item.track_id}
                    applied={() => {
                      void load();
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
          <div className="button-row">
            <button
              disabled={busy || offset === 0}
              onClick={() =>
                void run(async () => {
                  const value = Math.max(0, offset - 50);
                  setOffset(value);
                  setSelected([]);
                  await load(batch.id, value);
                })
              }
            >
              上一页
            </button>
            <span>
              {Math.min(offset + 1, batch.total)}–{Math.min(offset + 50, batch.total)} /{' '}
              {batch.total}
            </span>
            <button
              disabled={busy || offset + 50 >= batch.total}
              onClick={() =>
                void run(async () => {
                  const value = offset + 50;
                  setOffset(value);
                  setSelected([]);
                  await load(batch.id, value);
                })
              }
            >
              下一页
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function LyricScanDialog({ albumId, onClose }: { albumId?: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="editor-dialog lyric-scan-dialog"
      aria-label={albumId ? '专辑歌词补全与洗版' : '歌词补全与洗版'}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <button onClick={onClose} aria-label="关闭歌词扫描">
        关闭
      </button>
      <LyricScans albumId={albumId} />
    </dialog>
  );
}

export function LyricScanEntry() {
  const [open, setOpen] = useState(false);
  return (
    <section className="management-card">
      <h2>歌词补全与洗版</h2>
      <p className="muted">全库慢速补全、歌词升级及频率设置，支持暂停续扫。</p>
      <button onClick={() => setOpen(true)}>打开歌词补全与洗版</button>
      {open && <LyricScanDialog onClose={() => setOpen(false)} />}
    </section>
  );
}
