import { HelpLabel } from './desktop-help';
import { useEffect, useState } from 'react';
import { api } from './api';

type Preferences = {
  enabled: boolean;
  interval_seconds: number;
  stable_seconds: number;
  version: number;
  download_policy?: { wait_for_album: boolean; partial_suffixes: string[] };
};
type Metadata = {
  title?: string;
  artists?: string[];
  album?: string | null;
  album_artists?: string[];
  track_number?: number | null;
  disc_number?: number | null;
};
type Item = {
  id: string;
  source_path: string;
  state: string;
  metadata: Metadata;
  overrides: Metadata;
  issues: string[];
  version: number;
  can_approve: boolean;
};
type Items = { items: Item[]; total: number; limit: number; offset: number };
const labels: Record<string, string> = {
  download_incomplete: '同专辑仍有下载标记，等待下载完成',
  release_collision: '目标路径已有不同文件，需要核对发行版本',
  cue_release_collision: '分轨目标已有其他版本，需要核对 CUE 发行信息',
  intake_snapshot_changed: '暂存副本发生变化，请重新检查',
  source_missing: '确认后源文件已移走，暂存副本仍保留',
  cue_lossy_image_unsupported: '暂不自动分割有损整轨音频',
  conversion_failed: '转换失败，可重试并查看文件状态',
  retry: '等待重新检查',
  waiting: '等待文件稳定',
  ready: '等待处理',
  review: '待整理',
  approved: '等待入库',
  failed: '处理失败',
  conflict: '存在冲突',
  missing_title: '缺少歌名',
  missing_artists: '缺少歌曲艺人',
  missing_album: '缺少专辑',
  album_artist_ambiguous: '专辑艺人不明确，可能是合辑',
  cue_invalid: 'CUE 内容无效',
  cue_conflicting_sheets: '多个 CUE 内容不一致',
  cue_metadata_incomplete: 'CUE 缺少歌曲或专辑信息',
  cue_hidden_pregap: '首曲前有隐藏音轨，需要单独处理',
  cue_out_of_bounds: 'CUE 时间超出音频范围',
  cue_index_order: 'CUE 索引顺序不正确',
  cue_synthetic_gap: 'CUE 含需另行处理的合成间隙',
  cue_multiple_images: '多镜像 CUE 尚需单独处理',
  cue_inexact_sample: 'CUE 无法精确定位采样',
  wav_not_integer_pcm: 'WAV 不是可支持的整数 PCM',
  wav_precision_unsupported: '暂不支持此 WAV 精度或声道',
  flac_precision_unsupported: '暂不支持此 FLAC 精度的分轨',
  insufficient_storage: '磁盘空间不足',
  ffmpeg_unavailable: '转换工具不可用',
  intake_file_unavailable: '无法读取或解析文件',
  managed_copy_missing: '库内副本缺失，已停止自动恢复',
  source_changed_managed_copy_preserved: '源文件变化，已保留库内副本',
  pcm_verification_failed: '转换后音频校验未通过',
  flac_verification_failed: '转换后解码校验未通过',
  flac_parameters_changed: '转换后音频参数不一致',
};
export function IntakePanel() {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [suffixText, setSuffixText] = useState('');
  const [items, setItems] = useState<Items | null>(null);
  const [offset, setOffset] = useState(0),
    [tick, setTick] = useState(0);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null),
    [fields, setFields] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    api<Preferences>('/manage/intake/settings', { signal: controller.signal })
      .then((value) => {
        setPreferences(value);
        setSuffixText(value.download_policy?.partial_suffixes.join(', ') || '');
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let reading = false;
    async function refresh() {
      if (reading) return;
      reading = true;
      try {
        const value = await api<Items>(`/manage/intake/items?limit=20&offset=${offset}`, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setItems(value);
      } catch (reason) {
        if (!controller.signal.aborted) setError((reason as Error).message);
      } finally {
        reading = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [offset, tick]);
  function edit(item: Item) {
    const data = { ...item.metadata, ...item.overrides };
    setEditing(item);
    setFields([
      data.title || '',
      (data.artists || []).join('\n'),
      data.album || '',
      (data.album_artists || []).join('\n'),
      String(data.track_number || ''),
      String(data.disc_number || ''),
    ]);
    setError('');
  }
  async function act(item: Item, action: 'approve' | 'ignore' | 'retry') {
    setBusy(true);
    setError('');
    setNotice('');
    const lines = (s: string) =>
      s
        .split('\n')
        .map((v) => v.trim())
        .filter(Boolean);
    const body =
      action === 'approve'
        ? {
            version: item.version,
            overrides: {
              title: fields[0].trim(),
              artists: lines(fields[1]),
              album: fields[2].trim() || null,
              album_artists: lines(fields[3]),
              track_number: fields[4] ? Number(fields[4]) : null,
              disc_number: fields[5] ? Number(fields[5]) : null,
            },
          }
        : { version: item.version };
    try {
      await api(`/manage/intake/items/${item.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setEditing(null);
      setTick((value) => value + 1);
      setNotice(
        action === 'approve'
          ? '已确认，后台将继续导入。'
          : action === 'ignore'
            ? '已忽略；源文件变化后会重新检查。'
            : '已安排重新检查。',
      );
    } catch (reason) {
      setError(`${(reason as Error).message}。若文件或记录已变化，请取消编辑并重新打开。`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="management-card">
        <span className="eyebrow">AUTOMATIC IMPORT</span>
        <h2>自动导入</h2>
        <p className="muted">
          定期发现新文件，稳定后检查并导入；信息不完整的歌曲留在待整理中。手动“导入音乐”表示源文件已准备就绪。
        </p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (!preferences) return;
            setBusy(true);
            setError('');
            setNotice('');
            try {
              setPreferences(
                await api<Preferences>('/manage/intake/settings', {
                  method: 'PUT',
                  body: JSON.stringify({
                    ...preferences,
                    ...(preferences.download_policy
                      ? {
                          download_policy: {
                            ...preferences.download_policy,
                            partial_suffixes: suffixText.split(/[,\s]+/).filter(Boolean),
                          },
                        }
                      : {}),
                  }),
                }),
              );
              setNotice('自动导入设置已保存。');
            } catch (reason) {
              setError((reason as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={!preferences || busy} className="intake-settings">
            <label className="management-checkbox">
              <input
                type="checkbox"
                checked={preferences?.enabled || false}
                onChange={(event) =>
                  setPreferences((value) => value && { ...value, enabled: event.target.checked })
                }
              />
              自动发现并导入新音乐
            </label>
            <label>
              <HelpLabel hint="importInterval">检查间隔（秒）</HelpLabel>
              <input
                type="number"
                min="15"
                max="86400"
                required
                value={preferences?.interval_seconds ?? 60}
                onChange={(event) =>
                  setPreferences(
                    (value) => value && { ...value, interval_seconds: Number(event.target.value) },
                  )
                }
              />
            </label>
            <label>
              <HelpLabel hint="importStable">等待文件稳定（秒）</HelpLabel>
              <input
                type="number"
                min="5"
                max="86400"
                required
                value={preferences?.stable_seconds ?? 120}
                onChange={(event) =>
                  setPreferences(
                    (value) => value && { ...value, stable_seconds: Number(event.target.value) },
                  )
                }
              />
            </label>
            {preferences?.download_policy && (
              <>
                <label className="management-checkbox">
                  <input
                    type="checkbox"
                    checked={preferences.download_policy.wait_for_album}
                    onChange={(event) =>
                      setPreferences((value) =>
                        value?.download_policy
                          ? {
                              ...value,
                              download_policy: {
                                ...value.download_policy,
                                wait_for_album: event.target.checked,
                              },
                            }
                          : value,
                      )
                    }
                  />
                  同专辑有下载标记时整张等待（含 CD / Disc 子目录）
                </label>
                <label>
                  <HelpLabel hint="downloadSuffix">
                    下载中文件／目录后缀（空格或逗号分隔）
                  </HelpLabel>
                  <input
                    required
                    value={suffixText}
                    maxLength={300}
                    onChange={(event) => setSuffixText(event.target.value)}
                  />
                </label>
                <p className="muted">
                  建议下载器把未完成任务放在独立目录，完成后移入导入源。仅靠文件短时间不变，无法判断整个下载任务已完成。导入只复制，原件可继续做种。
                </p>
              </>
            )}
            <button className="primary">保存自动导入设置</button>
          </fieldset>
        </form>
      </section>
      <section className="management-card" aria-label="待整理音乐">
        <div className="management-section-heading">
          <div>
            <h2>
              待整理 <small>{items?.total ?? '…'}</small>
            </h2>
            <p className="muted">补充缺失信息后继续入库；转换错误与版本冲突单独处理。</p>
          </div>
          <button disabled={busy} onClick={() => setTick((value) => value + 1)}>
            刷新待整理
          </button>
        </div>
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {items?.items.length === 0 && <p className="muted">没有需要处理的音乐。</p>}
        <ul className="intake-list">
          {items?.items.map((item) => (
            <li key={item.id}>
              <div>
                <strong>{labels[item.state] || item.state}</strong>
                <code>{item.source_path}</code>
                <p className="muted">
                  {item.issues.map((code) => labels[code] || code).join(' · ')}
                </p>
              </div>
              {editing?.id === item.id ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(editing, 'approve');
                  }}
                  className="intake-edit"
                  aria-label="补充导入信息"
                >
                  <p className="muted">确认后使用这些信息归档并更新曲库。</p>
                  {[
                    '歌名',
                    '歌曲艺人（每行一位）',
                    '专辑',
                    '专辑艺人（每行一位）',
                    '曲号',
                    '碟号',
                  ].map((label, i) => (
                    <label key={label}>
                      {label}
                      {i === 1 || i === 3 ? (
                        <textarea
                          rows={2}
                          value={fields[i]}
                          onChange={(event) =>
                            setFields((value) =>
                              value.map((field, n) => (n === i ? event.target.value : field)),
                            )
                          }
                        />
                      ) : (
                        <input
                          type={i >= 4 ? 'number' : 'text'}
                          min={i >= 4 ? 1 : undefined}
                          max={i >= 4 ? 99999 : undefined}
                          required={i === 0 || i === 2}
                          maxLength={i < 4 ? 1000 : undefined}
                          value={fields[i]}
                          onChange={(event) =>
                            setFields((value) =>
                              value.map((field, n) => (n === i ? event.target.value : field)),
                            )
                          }
                        />
                      )}
                    </label>
                  ))}
                  <div className="intake-buttons">
                    <button className="primary" disabled={busy}>
                      确认信息并继续导入
                    </button>
                    <button type="button" disabled={busy} onClick={() => setEditing(null)}>
                      取消编辑
                    </button>
                  </div>
                </form>
              ) : (
                <div className="intake-buttons">
                  {item.can_approve && (
                    <button disabled={busy} onClick={() => edit(item)}>
                      补充信息
                    </button>
                  )}
                  {item.state === 'failed' && (
                    <button disabled={busy} onClick={() => void act(item, 'retry')}>
                      重新检查
                    </button>
                  )}
                  {['review', 'waiting', 'failed', 'conflict'].includes(item.state) && (
                    <button disabled={busy} onClick={() => void act(item, 'ignore')}>
                      忽略此项
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        {items && items.total > items.limit && (
          <div className="intake-buttons">
            <button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - items.limit))}
            >
              上一页
            </button>
            <span>
              {Math.floor(offset / items.limit) + 1} / {Math.ceil(items.total / items.limit)}
            </span>
            <button
              disabled={offset + items.limit >= items.total}
              onClick={() => setOffset(offset + items.limit)}
            >
              下一页
            </button>
          </div>
        )}
      </section>
    </>
  );
}
