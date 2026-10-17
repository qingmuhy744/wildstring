import { useEffect, useRef, useState } from 'react';
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
            ? '已记在想收清单。'
            : 'clear' === action
              ? '已移出想收清单。'
              : '已记录，不再推荐这条线索。',
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
      if (mounted.current) setNotice(`已复制：${content}`);
    } catch {
      if (mounted.current) setError(`无法写入剪贴板，请手动复制：${content}`);
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
    <section className="external-recommendations" aria-label="发现新音乐">
      <div className="discovery-heading">
        <div>
          <span className="eyebrow">BEYOND YOUR SHELVES</span>
          <h2>还没收进来的声音。</h2>
          <p className="muted">
            来自真实资料的收歌线索，留给你自己去找。这里的“新发现”也可能是一首老歌。
          </p>
        </div>
        <div className="toolbar-actions">
          <button type="button" onClick={onPreferences}>
            更新频率与来源
          </button>
          <button
            className="primary"
            disabled={!enabled || loading || busyIds.size > 0}
            onClick={() => void load(true)}
          >
            <Icon name="refresh" />
            {loading ? '正在整理建议…' : batch?.items.length ? '换一批收歌建议' : '获取收歌建议'}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
          <button disabled={loading} onClick={() => void load()}>
            重新读取建议
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
            <h3>给下一次收歌，留一点灵感。</h3>
            <p className="muted">
              开启后按你选择的频率更新，只提供歌曲信息和来源。下载由你安排，放进导入文件夹后再交给曲库处理。
            </p>
            <button onClick={onPreferences}>设置收歌建议</button>
          </div>
        </div>
      ) : (
        <>
          <p className="muted external-batch-status">
            {preferences.external_refresh_days === 0
              ? '仅手动更新'
              : `每 ${preferences.external_refresh_days ?? 7} 天更新`}
            {batch?.generated_at ? ` · 上次 ${localDate(batch.generated_at)}` : ''}
            {batch?.next_refresh_at ? ` · 下次 ${localDate(batch.next_refresh_at)}` : ''}
            {batch?.cached ? ' · 已保存的建议' : ''}
            {batch?.stale ? ' · 资料已过期，当前显示之前的结果' : ''}
          </p>
          <p className="external-boundary">
            库外歌曲暂不可播放；收进曲库后会重新匹配。
            {preferences.external_use_ai
              ? '本次整理可使用已选模型及共用额度。'
              : '使用资料来源与本地规则，不调用模型。'}
          </p>
          <div className="workspace-tabs" role="group" aria-label="收歌建议分类">
            <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              全部线索
            </button>
            <button aria-pressed={filter === 'wanted'} onClick={() => setFilter('wanted')}>
              我想收 · {allItems.filter((item) => item.wanted).length}
            </button>
          </div>
          {loading && (
            <p role="status" className="muted">
              正在读取真实候选与来源，音乐会继续播放…
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
                      <p>{item.artists.join(' / ') || '艺人资料待核对'}</p>
                      {item.album && <small>{item.album}</small>}
                    </div>
                    <span className="workspace-badge">
                      {item.local_track ? '已在曲库' : '收歌线索'}
                    </span>
                  </div>
                  <p className="external-reason">{item.reason}</p>
                  <details>
                    <summary>来源与依据</summary>
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
                        aria-label={`播放已入库 ${item.name}`}
                      >
                        播放本库歌曲
                      </button>
                    )}
                    <button
                      disabled={busyIds.has(item.external_id)}
                      aria-pressed={item.wanted}
                      onClick={() => void feedback(item, item.wanted ? 'clear' : 'want')}
                    >
                      {item.wanted ? '已加入想收' : '想收这首'}
                    </button>
                    <button onClick={() => void copy(item)}>复制歌名与艺人</button>
                    {link && (
                      <a
                        className="external-source-link"
                        href={link}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        查看 Last.fm 资料 ↗
                      </a>
                    )}
                    <button
                      className="text-button"
                      disabled={busyIds.has(item.external_id)}
                      onClick={() => void feedback(item, 'dismiss')}
                    >
                      不再推荐
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          {!visible.length && !loading && !error && (
            <p className="workspace-empty">
              {filter === 'wanted'
                ? '还没有想收的线索，看到喜欢的名字就记下来。'
                : batch?.status === 'unavailable'
                  ? '外部资料暂不可用，之后可以重新读取。'
                  : batch?.status === 'manual'
                    ? '点击“获取收歌建议”，准备第一批线索。'
                    : '暂时没有可核对的新线索，换一个标签或之后再看看。'}
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
