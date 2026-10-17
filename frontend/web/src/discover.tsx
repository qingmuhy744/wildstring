import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, eventId, artist, time, type Playlist, type Track, type User } from './api';
import { Cover } from './cover';
import { FavoriteButton, type Favorites } from './favorites';
import type { Player } from './player';
import { SyncModeControl } from './playback-sync';
import { modeNames, QUEUE_LIMIT, type PlaybackMode } from './playback-state';

type Choice = { track: Track; reason: string };
interface Daily {
  id: string;
  date: string;
  items: Choice[];
  engine: string;
}
interface Preferences {
  version: number;
  use_ai: boolean;
  use_lastfm: boolean;
  count: number;
}
interface Discovery {
  title: string;
  items: Choice[];
  mode: 'ai' | 'local';
  warning?: string;
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
      {items.map(({ track, reason }, index) => (
        <article key={track.id} className="discovery-track">
          <Cover trackId={track.id} title={track.title} />
          <button
            className="track-title"
            onClick={() => {
              player.start(
                items.map((i) => i.track),
                index,
              );
              feedback?.(track.id, 'accept');
            }}
            aria-label={`播放 ${track.title}`}
          >
            <strong>{track.title}</strong>
            <small>{artist(track)}</small>
            <small>{explanation(reason)}</small>
          </button>
          <FavoriteButton track={track} favorites={favorites} />
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

          {feedback && (
            <details className="recommendation-feedback">
              <summary aria-label={`调整推荐 ${track.title}`}>⋯</summary>
              <div>
                <button onClick={() => feedback(track.id, 'dismiss_track')}>少推荐这首</button>
                <button onClick={() => feedback(track.id, 'less_artist')}>少推荐此艺人</button>
              </div>
            </details>
          )}
        </article>
      ))}
    </div>
  );
}
export function Discover({
  player,
  favorites,
  onSaved,
}: {
  player: Player;
  favorites: Favorites;
  onSaved: (list: Playlist) => void;
}) {
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
    void Promise.all([
      api<Daily>('/recommendations/daily', { signal: controller.signal }),
      api<Preferences>('/recommendations/preferences', { signal: controller.signal }),
    ])
      .then(([daily, settings]) => {
        if (!controller.signal.aborted) {
          setDaily(daily);
          setPreferences(settings);
          setDraftPreferences(settings);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('推荐暂时无法读取，联网后可重试。');
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
      const result = await api<Discovery>('/ai/discover', {
        method: 'POST',
        body: JSON.stringify({ prompt, limit: 30 }),
      });
      setDiscovery(result);
      setName(result.title);
    });
  }
  return (
    <section className="completion-page" aria-label="音乐发现">
      <p className="eyebrow">MADE FOR YOUR EARS</p>
      <h1>今天，听点什么。</h1>
      <p className="muted">从自己的曲库，找到下一段回响。</p>
      {error && (
        <p className="error" role="alert">
          {error} <button onClick={() => setRefresh((v) => v + 1)}>重新读取</button>
        </p>
      )}
      {(busy || message) && <p role="status">{busy || message}</p>}
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
                setDaily(
                  await api<Daily>('/recommendations/daily/refresh', {
                    method: 'POST',
                    body: '{}',
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
      {draftPreferences && (
        <details className="discovery-preferences">
          <summary>推荐偏好</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void action('正在保存偏好…', async () => {
                const settings = await api<Preferences>('/recommendations/preferences', {
                  method: 'PUT',
                  body: JSON.stringify(draftPreferences),
                });
                setPreferences(settings);
                setDraftPreferences(settings);
                setMessage('偏好已保存，点击“换一批”生成新的推荐。');
              });
            }}
          >
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={draftPreferences.use_ai}
                onChange={(e) =>
                  setDraftPreferences({ ...draftPreferences, use_ai: e.target.checked })
                }
              />
              使用 AI 编排候选
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={draftPreferences.use_lastfm}
                onChange={(e) =>
                  setDraftPreferences({ ...draftPreferences, use_lastfm: e.target.checked })
                }
              />
              使用 Last.fm 相似关系
            </label>
            <p className="muted">
              开启后会向已配置的服务发送必要曲目资料；服务不可用时使用本地推荐。默认关闭。
            </p>
            <label>
              每日首数
              <input
                type="number"
                min="5"
                max="50"
                value={draftPreferences.count}
                onChange={(e) =>
                  setDraftPreferences({ ...draftPreferences, count: Number(e.target.value) })
                }
              />
            </label>
            <button
              disabled={!!busy || JSON.stringify(preferences) === JSON.stringify(draftPreferences)}
            >
              保存推荐偏好
            </button>
          </form>
        </details>
      )}
      <section className="ai-discover">
        <p className="eyebrow">ASK YOUR COLLECTION</p>
        <h2>说说你想听的。</h2>
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
          <p className="muted">点击后从本曲库选歌；模型未配置或不可用时，明确使用本地检索。</p>
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
      </section>
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
      <p className="muted">暂停时自动保存进度。默认发现其他设备的新记录时询问，载入后保持暂停。</p>
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
