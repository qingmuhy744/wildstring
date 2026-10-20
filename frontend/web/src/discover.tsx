import './recommendations.css';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, eventId, artist, time, type Playlist, type Track, type User } from './api';
import { Cover } from './cover';
import { FavoriteButton, type Favorites } from './favorites';
import { RowMenu } from './row-menu';
import type { Player } from './player';
import { SyncModeControl } from './playback-sync';
import { modeNames, QUEUE_LIMIT, type PlaybackMode } from './playback-state';
import { ModelConnectionChoice, useModelConnections } from './model-connection';
import { RecommendationPreferencesForm, RecommendationSources } from './recommendation-preferences';
import { ListeningRankings } from './listening-rankings';
import { ExternalRecommendations } from './external-recommendations';
import { PlaybackIndicator } from './playback-indicator';
import {
  recommendationSources,
  type DailyRecommendation,
  type RecommendationChoice,
  type RecommendationPreferences,
  type RecommendationWarning,
  type SourceStatus,
} from './recommendation-types';

type Choice = RecommendationChoice;
type Daily = DailyRecommendation;
type Preferences = RecommendationPreferences;
interface Discovery {
  title: string;
  items: Choice[];
  mode: 'ai' | 'local';
  warning?: string;
  connection_id?: string;
  source_status?: SourceStatus[];
  warnings?: RecommendationWarning[];
  degraded?: boolean;
}
function explanation(reason: unknown): string {
  return typeof reason === 'string' ? reason : '来自你的曲库';
}
function Choices({
  items,
  player,
  favorites,
  feedback,
  onChange,
}: {
  items: Choice[];
  player: Player;
  favorites: Favorites;
  feedback?: (id: string, action: string) => void;
  onChange?: (items: Choice[]) => void;
}) {
  return (
    <div className="discovery-list">
      {items.map(({ track, reason, source_ids }, index) => (
        <RowMenu
          key={track.id}
          label={track.title}
          className={`discovery-track ${feedback ? 'daily-track' : ''} ${player.current?.id === track.id ? 'is-current' : ''}`}
          actions={[
            {
              label: favorites.ids.has(track.id) ? '取消收藏' : '收藏',
              icon: 'heart',
              disabled: !favorites.ready || favorites.busy.has(track.id),
              run: () => void favorites.toggle(track),
            },
            ...(feedback
              ? [
                  {
                    label: '不感兴趣',
                    icon: 'remove' as const,
                    run: () => feedback(track.id, 'dismiss_track'),
                  },
                  {
                    label: '少推荐此艺人',
                    icon: 'artist' as const,
                    run: () => feedback(track.id, 'less_artist'),
                  },
                ]
              : []),
          ]}
        >
          {feedback && (
            <span className="daily-track-number">
              {player.current?.id === track.id ? (
                <PlaybackIndicator playing={player.playing} buffering={player.buffering} />
              ) : (
                String(index + 1).padStart(2, '0')
              )}
            </span>
          )}
          <Cover trackId={track.id} title={track.title} />
          <button
            className="track-title"
            aria-current={player.current?.id === track.id ? 'true' : undefined}
            onClick={() => {
              player.start(
                items.map((i) => i.track),
                index,
              );
              feedback?.(track.id, 'accept');
            }}
            aria-label={`播放 ${track.title}`}
          >
            <strong>
              {!feedback && player.current?.id === track.id && (
                <PlaybackIndicator playing={player.playing} buffering={player.buffering} />
              )}
              {track.title}
            </strong>
            <small>
              {artist(track)}
              {feedback && track.album ? ` · ${track.album}` : ''}
            </small>
            {!feedback && <small>{explanation(reason)}</small>}
            {!feedback && !!source_ids?.length && (
              <span className="recommendation-source-pills">
                {source_ids.slice(0, 3).map((id) => (
                  <span key={id}>{recommendationSources[id] || id}</span>
                ))}
              </span>
            )}
          </button>
          {!feedback && <FavoriteButton track={track} favorites={favorites} />}
          {onChange && (
            <div className="candidate-actions">
              <button
                aria-label={`候选上移 ${track.title}`}
                disabled={index === 0}
                onClick={() => {
                  const next = [...items];
                  [next[index - 1], next[index]] = [next[index], next[index - 1]];
                  onChange(next);
                }}
              >
                ↑
              </button>
              <button
                aria-label={`候选下移 ${track.title}`}
                disabled={index === items.length - 1}
                onClick={() => {
                  const next = [...items];
                  [next[index], next[index + 1]] = [next[index + 1], next[index]];
                  onChange(next);
                }}
              >
                ↓
              </button>
              <button
                aria-label={`移除候选 ${track.title}`}
                onClick={() => onChange(items.filter((i) => i.track.id !== track.id))}
              >
                ×
              </button>
            </div>
          )}

          {feedback && <span className="daily-track-time">{time(track.duration_ms / 1000)}</span>}
        </RowMenu>
      ))}
    </div>
  );
}
export function Discover({
  player,
  favorites,
  onSaved,
  onConnections,
}: {
  player: Player;
  favorites: Favorites;
  onSaved: (list: Playlist) => void;
  onConnections: () => void;
}) {
  const connections = useModelConnections();
  const [section, setSection] = useState('daily');
  const [daily, setDaily] = useState<Daily | null>(null),
    [preferences, setPreferences] = useState<Preferences | null>(null);
  const [draftPreferences, setDraftPreferences] = useState<Preferences | null>(null);
  const [prompt, setPrompt] = useState(''),
    [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [busy, setBusy] = useState(''),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const [name, setName] = useState(''),
    [refresh, setRefresh] = useState(0);
  const pending = useRef(false),
    feedbackPending = useRef(new Set<string>());
  const pendingLists = useRef(new Map<string, Playlist>());
  async function saveList(name: string, ids: string[]) {
    const key = JSON.stringify([name, ids]);
    let list = pendingLists.current.get(key);
    if (!list) {
      list = await api<Playlist>('/playlists', {
        method: 'POST',
        body: JSON.stringify({ name, kind: 'manual' }),
      });
      pendingLists.current.set(key, list);
    }
    try {
      const updated = await api<Playlist>(`/playlists/${list.id}/tracks`, {
        method: 'POST',
        body: JSON.stringify({ version: list.version, track_ids: ids }),
      });
      pendingLists.current.delete(key);
      return updated;
    } catch {
      throw new Error('歌单已建立，曲目保存结果尚未确认；请查看歌单，或再次尝试。');
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void api<Preferences>('/recommendations/preferences', { signal: controller.signal })
      .then(async (settings) => {
        if (controller.signal.aborted) return;
        setPreferences(settings);
        setDraftPreferences(settings);
        if (!Array.isArray(settings.sources) && settings.use_ai) {
          setDaily({ id: 'legacy-not-generated', date: '', items: [], engine: 'local' });
          return;
        }
        const daily = await api<Daily>('/recommendations/daily', { signal: controller.signal });
        if (!controller.signal.aborted) setDaily(daily);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : '推荐暂时无法读取，联网后可重试。');
      });
    return () => controller.abort();
  }, [refresh]);
  async function action(label: string, fn: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(label);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '未完成，请重试。');
    } finally {
      pending.current = false;
      setBusy('');
      connections.reload();
    }
  }
  function feedback(id: string, action: string) {
    if (feedbackPending.current.has(id)) return;
    feedbackPending.current.add(id);
    const previous = daily;
    if (action !== 'accept')
      setDaily(
        (current) =>
          current && { ...current, items: current.items.filter((i) => i.track.id !== id) },
      );
    void api('/recommendations/feedback', {
      method: 'POST',
      body: JSON.stringify({ event_id: eventId(), track_id: id, action }),
    })
      .then(() =>
        setMessage(action === 'accept' ? '已记录，继续听喜欢的声音。' : '已记录你的偏好。'),
      )
      .catch(() => {
        setDaily((current) => {
          if (
            !previous ||
            !current ||
            current.id !== previous.id ||
            current.items.some((i) => i.track.id === id)
          )
            return current;
          const item = previous.items.find((i) => i.track.id === id);
          if (!item) return current;
          const items = [...current.items];
          items.splice(Math.min(previous.items.indexOf(item), items.length), 0, item);
          return { ...current, items };
        });
        setError('偏好未保存，已恢复，可重试。');
      })
      .finally(() => feedbackPending.current.delete(id));
  }
  function discover(event: FormEvent) {
    event.preventDefault();
    void action('正在找歌…', async () => {
      let result: Discovery;
      if (!Array.isArray(preferences?.sources)) {
        const page = await api<{ items: Track[] }>(
          `/tracks?q=${encodeURIComponent(prompt.trim())}&limit=30`,
        );
        result = {
          title: prompt.trim().slice(0, 100),
          items: page.items.map((track) => ({ track, reason: '本地关键词匹配' })),
          mode: 'local',
        };
      } else
        result = await api<Discovery>('/ai/discover', {
          method: 'POST',
          body: JSON.stringify({
            prompt,
            limit: 30,
            connection_id: draftPreferences?.connection_id || 'local',
            sources: draftPreferences?.sources || preferences.sources,
          }),
        });
      setDiscovery(result);
      setName(result.title);
    });
  }
  function openPreferences() {
    const details = document.getElementById(
      'recommendation-preferences',
    ) as HTMLDetailsElement | null;
    if (details) {
      details.open = true;
      details.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }
  return (
    <section className="completion-page music-discovery" aria-label="音乐发现">
      <p className="eyebrow">MADE FOR YOUR EARS</p>
      <h1>今天，听点什么。</h1>
      <p className="muted">熟悉的旋律，再听一遍；还没遇见的，留一份收歌线索。</p>
      {connections.error && (
        <p className="error" role="alert">
          {connections.error}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error} <button onClick={() => setRefresh((v) => v + 1)}>重新读取</button>
        </p>
      )}
      {(busy || message) && <p role="status">{busy || message}</p>}
      <details className="ai-discover">
        <summary>
          <span className="eyebrow">ASK YOUR COLLECTION</span>
          <span className="discovery-prompt-title">说说你想听的。</span>
          <span className="muted">
            找歌，或生成一张歌单 <span aria-hidden="true">↗</span>
          </span>
        </summary>
        <form onSubmit={discover}>
          <label>
            找歌或生成歌单
            <textarea
              aria-label="找歌或生成歌单"
              placeholder="找几首许嵩的歌，组成半小时歌单"
              value={prompt}
              maxLength={2000}
              required
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          {draftPreferences && (
            <ModelConnectionChoice
              items={connections.items}
              value={draftPreferences.connection_id || 'local'}
              onChange={(id) =>
                setDraftPreferences({
                  ...draftPreferences,
                  connection_id: id,
                  use_ai: id !== 'local',
                  ...(id === 'local' ? { external_use_ai: false } : {}),
                })
              }
              label="这次找歌使用的连接"
              disabled={!!busy || connections.loading || !Array.isArray(preferences?.sources)}
              onManage={onConnections}
            />
          )}
          <p className="muted">
            点击后从真实本库候选中选歌。模型不可用时会说明降级，不切换其他付费连接；库外线索在“发现新音乐”单独展示。
          </p>
          <button className="primary" disabled={!!busy || !prompt.trim()}>
            {busy === '正在找歌…' ? busy : '生成候选'}
          </button>
        </form>
        {discovery && (
          <div aria-label="歌单候选预览">
            <h3>{discovery.title}</h3>
            <p role="status">
              {discovery.mode === 'local' ? '当前使用本地检索回退。' : 'AI 已从本地曲库选择候选。'}{' '}
              {discovery.warning === 'no_local_matches'
                ? '没有匹配的本地曲目。'
                : discovery.warning === 'ai_unavailable_local_fallback'
                  ? '模型暂不可用，基础找歌仍可使用。'
                  : ''}
            </p>
            <RecommendationSources
              items={discovery.source_status}
              warnings={discovery.warnings}
              degraded={discovery.degraded}
            />
            <Choices
              items={discovery.items}
              player={player}
              favorites={favorites}
              onChange={(items) => setDiscovery((current) => current && { ...current, items })}
            />
            {!discovery.items.length ? (
              <p>没有匹配的曲目，换一种说法试试。</p>
            ) : (
              <>
                <label>
                  歌单名称
                  <input
                    aria-label="候选歌单名称"
                    value={name}
                    maxLength={100}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <div className="toolbar-actions">
                  <button
                    onClick={() =>
                      player.start(
                        discovery.items.map((i) => i.track),
                        0,
                      )
                    }
                  >
                    试听候选
                  </button>
                  <button
                    disabled={!!busy || !name.trim()}
                    onClick={() =>
                      void action('正在保存歌单…', async () => {
                        const list = await saveList(
                          name,
                          discovery.items.map((i) => i.track.id),
                        );
                        setDiscovery(null);
                        onSaved(list);
                        setMessage('已保存，可以在歌单中继续整理。');
                      })
                    }
                  >
                    确认保存歌单
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </details>
      <div className="discovery-sections workspace-tabs" role="group" aria-label="发现分类">
        <button aria-pressed={section === 'daily'} onClick={() => setSection('daily')}>
          每日推荐
        </button>
        <button aria-pressed={section === 'rankings'} onClick={() => setSection('rankings')}>
          收听排行
        </button>
        <button aria-pressed={section === 'external'} onClick={() => setSection('external')}>
          发现新音乐
        </button>
      </div>
      <div hidden={section !== 'daily'}>
        <div className="discovery-heading">
          <div>
            <h2>每日推荐</h2>
            <p className="muted">
              {daily
                ? `${daily.date} · ${daily.items.length} 首 · ${daily.engine.includes('ai') ? 'AI 编排' : '本地推荐'}${daily.engine.includes('lastfm') ? ' · Last.fm 增强' : ''}`
                : '正在准备推荐…'}
            </p>
          </div>
          <div className="toolbar-actions">
            <button
              disabled={!daily?.items.length}
              onClick={() =>
                daily &&
                player.start(
                  daily.items.map((i) => i.track),
                  0,
                )
              }
            >
              播放推荐
            </button>
            <button
              disabled={!!busy}
              onClick={() =>
                void action('正在换一批…', async () => {
                  if (!Array.isArray(preferences?.sources)) {
                    const page = await api<{ items: Track[] }>(
                      `/tracks?limit=${draftPreferences?.count || 20}`,
                    );
                    setDaily({
                      id: 'legacy-local',
                      date: new Date().toLocaleDateString(),
                      engine: 'local',
                      items: page.items.map((track) => ({ track, reason: '本地曲库候选' })),
                    });
                    return;
                  }
                  setDaily(
                    await api<Daily>('/recommendations/daily/refresh', {
                      method: 'POST',
                      body: JSON.stringify(
                        Array.isArray(preferences?.sources)
                          ? {
                              connection_id: draftPreferences?.connection_id || 'local',
                              sources: draftPreferences?.sources || preferences.sources,
                            }
                          : {},
                      ),
                    }),
                  );
                })
              }
            >
              换一批
            </button>
            <button
              disabled={!!busy || !daily?.items.length}
              onClick={() =>
                void action('正在保存歌单…', async () => {
                  const list = await saveList(
                    `每日推荐 ${daily!.date}`,
                    daily!.items.map((i) => i.track.id),
                  );
                  onSaved(list);
                  setMessage('每日推荐已保存为歌单。');
                })
              }
            >
              保存推荐歌单
            </button>
          </div>
        </div>
        {daily && (
          <Choices items={daily.items} player={player} favorites={favorites} feedback={feedback} />
        )}
        <RecommendationSources
          items={daily?.source_status}
          warnings={daily?.warnings}
          degraded={daily?.degraded}
        />
      </div>
      {draftPreferences && (
        <RecommendationPreferencesForm
          value={draftPreferences}
          saved={preferences}
          onChange={setDraftPreferences}
          busy={!!busy}
          connections={connections.items}
          connectionsBusy={connections.loading || connections.unsupported}
          onConnections={onConnections}
          onSave={() =>
            void action('正在保存偏好…', async () => {
              const body = Array.isArray(draftPreferences.sources)
                ? {
                    ...draftPreferences,
                    use_ai: (draftPreferences.connection_id || 'local') !== 'local',
                  }
                : {
                    version: draftPreferences.version,
                    use_ai: false,
                    use_lastfm: draftPreferences.use_lastfm,
                    count: draftPreferences.count,
                  };
              const settings = await api<Preferences>('/recommendations/preferences', {
                method: 'PUT',
                body: JSON.stringify(body),
              });
              setPreferences(settings);
              setDraftPreferences(settings);
              setMessage('偏好已保存。点击“换一批”或“获取收歌建议”生成新结果。');
            })
          }
        />
      )}
      {section === 'rankings' && <ListeningRankings player={player} favorites={favorites} />}
      {section === 'external' && preferences?.external_enabled !== undefined && (
        <ExternalRecommendations
          preferences={preferences}
          player={player}
          onPreferences={openPreferences}
          onUsage={connections.reload}
        />
      )}
    </section>
  );
}
interface SharedPlayback {
  version: number;
  device_id: string;
  track_ids: string[];
  index: number;
  position_ms: number;
  mode: PlaybackMode;
  updated_at: string | null;
  handoff_supported?: boolean;
}
export function Devices({ player, user }: { player: Player; user: User }) {
  const [snapshot, setSnapshot] = useState<SharedPlayback | null>(null),
    [busy, setBusy] = useState(''),
    [message, setMessage] = useState('');
  const request = useRef(false);
  const deviceId = useRef('');
  if (!deviceId.current) {
    const key = `wildstring:device:${user.id}`;
    deviceId.current = localStorage.getItem(key) || eventId();
    localStorage.setItem(key, deviceId.current);
  }
  async function run(label: string, fn: () => Promise<void>) {
    if (request.current) return;
    request.current = true;
    setBusy(label);
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '未完成，请重新读取。');
    } finally {
      request.current = false;
      setBusy('');
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    api<SharedPlayback>('/playback/state', { signal: controller.signal })
      .then((v) => {
        if (!controller.signal.aborted) setSnapshot(v);
      })
      .catch(() => {
        if (!controller.signal.aborted) setMessage('无法读取设备进度。');
      });
    return () => controller.abort();
  }, []);
  return (
    <section className="completion-page" aria-label="跨设备继续">
      <p className="eyebrow">TAKE YOUR MUSIC WITH YOU</p>
      <h1>换个地方，接着听。</h1>
      <p className="muted">
        暂停时自动保存进度。仅对其他设备最近 30
        分钟内的暂停显示一次轻提示；载入后保持暂停，旧记录仍可手动载入。
      </p>
      <SyncModeControl userId={user.id} />
      <div className="management-card">
        <h2>账号共享进度</h2>
        <p>
          {snapshot?.track_ids.length
            ? `${snapshot.track_ids.length} 首队列 · 第 ${snapshot.index + 1} 首 · ${time(snapshot.position_ms / 1000)} · ${modeNames[snapshot.mode]}`
            : '还没有共享的播放进度。'}
        </p>
        <p className="muted">
          {snapshot?.updated_at
            ? `更新时间：${new Date(snapshot.updated_at).toLocaleString()}`
            : ''}
        </p>
        <div className="toolbar-actions">
          <button
            disabled={!!busy}
            onClick={() =>
              void run('正在读取…', async () =>
                setSnapshot(await api<SharedPlayback>('/playback/state')),
              )
            }
          >
            读取最新进度
          </button>
          <button
            disabled={!!busy || !snapshot || !player.current}
            onClick={() =>
              void run('正在共享…', async () => {
                const result = await api<SharedPlayback>('/playback/state', {
                  method: 'PUT',
                  body: JSON.stringify({
                    version: snapshot!.version,
                    device_id: deviceId.current,
                    track_ids: player.queue.map((t) => t.id),
                    index: player.index,
                    position_ms: Math.round(player.position * 1000),
                    mode: player.mode,
                    ...(snapshot?.handoff_supported
                      ? {
                          playback_state: player.audio.current?.ended
                            ? 'ended'
                            : player.audio.current?.paused === false
                              ? 'playing'
                              : 'paused',
                        }
                      : {}),
                  }),
                });
                setSnapshot(result);
                setMessage('当前队列与进度已共享。');
              })
            }
          >
            共享当前播放进度
          </button>
          <button
            className="primary"
            disabled={!!busy || !snapshot?.track_ids.length}
            onClick={() =>
              void run('正在准备继续…', async () => {
                const state = snapshot!;
                if (state.track_ids.length > QUEUE_LIMIT)
                  throw new Error(
                    `这个队列超过网页 ${QUEUE_LIMIT} 首上限，请在原设备缩小后重新共享。`,
                  );
                const tracks: Track[] = [];
                for (let i = 0; i < state.track_ids.length; i += 10)
                  tracks.push(
                    ...(await Promise.all(
                      state.track_ids
                        .slice(i, i + 10)
                        .map((id) => api<Track>(`/tracks/${encodeURIComponent(id)}`)),
                    )),
                  );
                player.setMode(state.mode);
                player.start(tracks, state.index, state.position_ms / 1000, false);
                setMessage('已载入共享进度，点击播放继续。');
              })
            }
          >
            在本设备继续
          </button>
        </div>
      </div>
      <p role="status">{busy || message}</p>
    </section>
  );
}
