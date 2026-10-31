import { useEffect, useState } from 'react';
import { api } from './api';
import { regionName } from './podcast-search';

export type PodcastSearchSettingsValue = {
  version: number;
  regions: string[];
  custom_regions: boolean;
  default_regions: string[];
  filter_explicit: boolean;
  supported_regions: string[];
  max_regions: number;
  can_manage: boolean;
};

const URL = '/podcasts/search-settings';

export function PodcastSearchSettings() {
  const [saved, setSaved] = useState<PodcastSearchSettingsValue | null>(null);
  const [regions, setRegions] = useState<string[]>([]);
  const [filterExplicit, setFilterExplicit] = useState(false);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const apply = (value: PodcastSearchSettingsValue) => {
    setSaved(value);
    setRegions(value.regions);
    setFilterExplicit(value.filter_explicit);
  };

  useEffect(() => {
    let active = true;
    void api<PodcastSearchSettingsValue>(URL)
      .then((value) => {
        if (active) apply(value);
      })
      .catch((error: Error) => {
        if (active) setMessage(error.message);
      });
    return () => {
      active = false;
    };
  }, []);

  if (saved && !saved.can_manage) return null;

  async function save(nextRegions: string[] | null) {
    if (!saved) return;
    setBusy(true);
    setMessage('');
    try {
      apply(
        await api<PodcastSearchSettingsValue>(URL, {
          method: 'PUT',
          body: JSON.stringify({
            version: saved.version,
            regions: nextRegions,
            filter_explicit: filterExplicit,
          }),
        }),
      );
      setMessage('播客搜索设置已保存。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
      const fresh = await api<PodcastSearchSettingsValue>(URL).catch(() => null);
      if (fresh) apply(fresh);
    } finally {
      setBusy(false);
    }
  }

  const move = (index: number, delta: number) =>
    setRegions((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item);
      return next;
    });

  const available = saved ? saved.supported_regions.filter((code) => !regions.includes(code)) : [];
  const isDefault =
    saved !== null &&
    regions.join(',') === saved.default_regions.join(',') &&
    !saved.custom_regions;

  return (
    <section className="management-card" aria-label="播客目录搜索">
      <h2>播客目录搜索</h2>
      <p className="muted">
        搜索节目时并行查询这些 Apple Podcasts 区域，结果合并去重，并按这里的顺序排序。区域越多，
        越容易触发 Apple 的频率限制（每个区域各算一次调用）。
      </p>
      {saved && (
        <>
          <ol className="podcast-search-settings-regions" aria-label="搜索区域">
            {regions.map((code, index) => (
              <li key={code}>
                <span>
                  {regionName(code)} <small>{code.toUpperCase()}</small>
                </span>
                <button
                  type="button"
                  aria-label={`上移${regionName(code)}`}
                  disabled={busy || index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`下移${regionName(code)}`}
                  disabled={busy || index === regions.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`移除${regionName(code)}`}
                  disabled={busy || regions.length === 1}
                  onClick={() => setRegions(regions.filter((item) => item !== code))}
                >
                  移除
                </button>
              </li>
            ))}
          </ol>
          <div className="podcast-search-settings-add">
            <label>
              <span>添加区域</span>
              <select
                value={adding}
                disabled={busy || regions.length >= saved.max_regions}
                onChange={(event) => setAdding(event.target.value)}
              >
                <option value="">选择区域…</option>
                {available.map((code) => (
                  <option key={code} value={code}>
                    {regionName(code)}（{code.toUpperCase()}）
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy || !adding || regions.length >= saved.max_regions}
              onClick={() => {
                setRegions([...regions, adding]);
                setAdding('');
              }}
            >
              添加
            </button>
          </div>
          <p className="muted">
            最多 {saved.max_regions} 个区域。服务器默认：
            {saved.default_regions.map(regionName).join('、')}
            {isDefault ? '（当前使用默认）' : ''}
          </p>
          <label className="music-library-grant-option">
            <input
              type="checkbox"
              checked={filterExplicit}
              disabled={busy}
              onChange={(event) => setFilterExplicit(event.target.checked)}
            />
            <span>从搜索结果中隐藏含成人内容的节目</span>
          </label>
          <p className="muted">关闭时（默认）只在结果上显示「成人」标记。已添加的节目不受影响。</p>
          <div className="podcast-search-settings-actions">
            <button type="button" disabled={busy} onClick={() => void save(regions)}>
              {busy ? '保存中…' : '保存播客搜索设置'}
            </button>
            <button type="button" disabled={busy} onClick={() => void save(null)}>
              恢复默认区域
            </button>
          </div>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
