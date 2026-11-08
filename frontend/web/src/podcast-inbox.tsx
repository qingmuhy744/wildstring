import { useEffect, useState } from 'react';
import { api, type Track } from './api';
import type { PodcastEpisode, PodcastSummary } from './podcasts';
import { podcastEpisodeToTrack } from './podcast-track';
import {
  addInbox,
  getInbox,
  getPodcastQueue,
  getQueuePreferences,
  putPodcastQueue,
  removeInbox,
  saveQueueDefaults,
  saveShowDelivery,
  type NewEpisodeAction,
  type QueuePreferences,
} from './podcast-remote';

const actions: { value: NewEpisodeAction; label: string }[] = [
  { value: 'ignore', label: '关闭（仅关注）' },
  { value: 'queue_last', label: '自动加到队尾' },
  { value: 'queue_next', label: '自动插到下一集' },
];

function normalizeDeliveryAction(action: NewEpisodeAction | undefined): NewEpisodeAction {
  if (!action || action === 'inbox') return 'queue_last';
  return action;
}

function ActionSelect({
  label,
  ariaLabel,
  hideLabel,
  value,
  disabled,
  onChange,
}: {
  label: string;
  ariaLabel?: string;
  hideLabel?: boolean;
  value: NewEpisodeAction;
  disabled?: boolean;
  onChange: (value: NewEpisodeAction) => void;
}) {
  const normalizedValue = normalizeDeliveryAction(value);
  const selectNode = (
    <select
      className="podcast-select"
      aria-label={ariaLabel || label}
      value={normalizedValue}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as NewEpisodeAction)}
    >
      {actions.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  );
  if (hideLabel) return selectNode;
  return (
    <label>
      {label}
      {selectNode}
    </label>
  );
}

export function PodcastDeliverySelect({ showId }: { showId: string }) {
  const [action, setAction] = useState<NewEpisodeAction>('queue_last');
  const [limit, setLimit] = useState(3);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void getQueuePreferences()
      .then((prefs) => {
        if (controller.signal.aborted) return;
        const show = prefs.shows[showId];
        setAction(normalizeDeliveryAction(show?.action ?? prefs.default_action));
        setLimit(show?.auto_limit ?? prefs.auto_limit);
        setStatus('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('error');
      });
    return () => controller.abort();
  }, [showId, reloadKey]);

  async function save(nextAction: NewEpisodeAction, nextLimit: number) {
    const bounded = Math.max(1, Math.min(100, Number.isFinite(nextLimit) ? nextLimit : 3));
    setAction(nextAction);
    setLimit(bounded);
    try {
      await saveShowDelivery(showId, nextAction, bounded);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }

  return (
    <div className="podcast-delivery" aria-busy={status === 'loading'}>
      {status === 'loading' ? (
        <p role="status">正在读取新集自动待播</p>
      ) : (
        <ActionSelect
          label="新集自动待播"
          value={action}
          onChange={(value) => void save(value, limit)}
        />
      )}
      {status === 'error' && (
        <p className="podcast-settings-error" role="alert">
          暂时无法保存新集自动待播。
          <button type="button" onClick={() => setReloadKey((value) => value + 1)}>
            重试
          </button>
        </p>
      )}
    </div>
  );
}

export function PodcastQueueDefaults() {
  const [action, setAction] = useState<NewEpisodeAction>('queue_last');
  const [limit, setLimit] = useState(3);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void getQueuePreferences()
      .then((prefs) => {
        if (controller.signal.aborted) return;
        setAction(normalizeDeliveryAction(prefs.default_action));
        setLimit(prefs.auto_limit);
        setStatus('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('error');
      });
    return () => controller.abort();
  }, [reloadKey]);

  async function save(nextAction: NewEpisodeAction, nextLimit: number) {
    const bounded = Math.max(1, Math.min(100, Number.isFinite(nextLimit) ? nextLimit : 3));
    setAction(nextAction);
    setLimit(bounded);
    try {
      await saveQueueDefaults(nextAction, bounded);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }

  return (
    <div className="podcast-settings-section podcast-queue-defaults">
      {status === 'loading' ? (
        <p role="status">正在读取新集自动待播</p>
      ) : (
        <ActionSelect
          label="新关注节目默认"
          value={action}
          onChange={(value) => void save(value, limit)}
        />
      )}
      {status === 'error' && (
        <p className="podcast-settings-error" role="alert">
          暂时无法读取新集自动待播。
          <button type="button" onClick={() => setReloadKey((value) => value + 1)}>
            重试
          </button>
        </p>
      )}
    </div>
  );
}

interface UnifiedPendingRow {
  episode_id: string;
  origin: 'manual' | 'rule';
  source: 'queue' | 'inbox';
  title: string;
  showTitle?: string;
  episode?: PodcastEpisode;
  show?: PodcastSummary;
}

export function PodcastInboxDialog({
  onClose,
  onBrowse,
  onQueueTrack,
  onPlayTrack,
  onPlayQueue,
  onRemoveQueuedEpisode,
}: {
  onClose: () => void;
  onBrowse: () => void;
  onQueueTrack: (track: Track, next: boolean) => void | boolean | Promise<unknown>;
  onPlayTrack?: (track: Track) => void | Promise<unknown>;
  onPlayQueue?: () => void | Promise<unknown>;
  onRemoveQueuedEpisode?: (episodeId: string) => void;
}) {
  const [rows, setRows] = useState<UnifiedPendingRow[]>([]);
  const [queueVersion, setQueueVersion] = useState(0);
  const [followedShows, setFollowedShows] = useState<PodcastSummary[]>([]);
  const [defaultAction, setDefaultAction] = useState<NewEpisodeAction>('queue_last');
  const [defaultLimit, setDefaultLimit] = useState(3);
  const [showActions, setShowActions] = useState<Record<string, NewEpisodeAction>>({});
  const [showLimits, setShowLimits] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [problem, setProblem] = useState('');

  async function load() {
    setStatus('loading');
    setProblem('');
    try {
      const [inbox, remoteQueue, prefs, followed] = await Promise.all([
        getInbox(),
        getPodcastQueue().catch(() => ({ version: 0, device_id: '', items: [] })),
        getQueuePreferences().catch((): QueuePreferences => ({
          default_action: 'queue_last',
          auto_limit: 3,
          shows: {},
        })),
        api<PodcastSummary[]>('/podcasts').catch(() => [] as PodcastSummary[]),
      ]);
      const podcastCache = new Map<string, Promise<PodcastSummary>>();
      for (const show of followed) {
        podcastCache.set(show.id, Promise.resolve(show));
      }
      const fetchShow = (podcastId: string) => {
        const cached = podcastCache.get(podcastId);
        if (cached) return cached;
        const request = api<{ podcast: PodcastSummary }>(
          `/podcasts/${encodeURIComponent(podcastId)}`,
        ).then((detail) => detail.podcast);
        podcastCache.set(podcastId, request);
        return request;
      };
      const resolvedQueue = await Promise.all(
        remoteQueue.items.map(async (item): Promise<UnifiedPendingRow> => {
          try {
            const episode = await api<PodcastEpisode>(
              `/podcasts/episodes/${encodeURIComponent(item.episode_id)}`,
            );
            const show = await fetchShow(episode.podcast_id);
            return {
              episode_id: item.episode_id,
              origin: item.origin,
              source: 'queue',
              title: episode.title,
              showTitle: show.title,
              episode,
              show,
            };
          } catch {
            return {
              episode_id: item.episode_id,
              origin: item.origin,
              source: 'queue',
              title: '这一集已经无法读取',
            };
          }
        }),
      );
      const seenEpisodeIds = new Set(resolvedQueue.map((item) => item.episode_id));
      const resolvedInbox = await Promise.all(
        inbox.items
          .filter((item) => !seenEpisodeIds.has(item.episode_id))
          .map(async (item): Promise<UnifiedPendingRow> => {
            try {
              const episode = await api<PodcastEpisode>(
                `/podcasts/episodes/${encodeURIComponent(item.episode_id)}`,
              );
              const show = await fetchShow(item.podcast_id || episode.podcast_id);
              return {
                episode_id: item.episode_id,
                origin: item.source === 'rule' ? 'rule' : 'manual',
                source: 'inbox',
                title: episode.title,
                showTitle: show.title,
                episode,
                show,
              };
            } catch {
              return {
                episode_id: item.episode_id,
                origin: 'manual',
                source: 'inbox',
                title: '这一集已经无法读取',
              };
            }
          }),
      );
      const nextShowActions: Record<string, NewEpisodeAction> = {};
      const nextShowLimits: Record<string, number> = {};
      for (const show of followed) {
        nextShowActions[show.id] = normalizeDeliveryAction(
          prefs.shows?.[show.id]?.action ?? prefs.default_action,
        );
        nextShowLimits[show.id] = prefs.shows?.[show.id]?.auto_limit ?? prefs.auto_limit;
      }
      for (const [id, pref] of Object.entries(prefs.shows || {})) {
        nextShowActions[id] = normalizeDeliveryAction(pref.action);
        nextShowLimits[id] = pref.auto_limit;
      }
      const sortedShows = [...followed].sort((a, b) =>
        Boolean(a.followed) === Boolean(b.followed) ? 0 : a.followed ? -1 : 1,
      );
      setRows([...resolvedQueue, ...resolvedInbox]);
      setQueueVersion(remoteQueue.version);
      setFollowedShows(sortedShows);
      setDefaultAction(normalizeDeliveryAction(prefs.default_action));
      setDefaultLimit(prefs.auto_limit);
      setShowActions(nextShowActions);
      setShowLimits(nextShowLimits);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function playRow(item: UnifiedPendingRow) {
    if (!item.episode || !item.show) {
      setProblem('这一集已经无法读取。可以移除它，或稍后重试。');
      return;
    }
    const track = podcastEpisodeToTrack(item.episode, item.show);
    if (onPlayTrack) {
      await Promise.resolve(onPlayTrack(track));
    } else {
      await Promise.resolve(onQueueTrack(track, true));
    }
    if (item.source === 'inbox') {
      await removeInbox(item.episode_id).catch(() => {});
    }
    onClose();
  }

  async function removeRow(item: UnifiedPendingRow) {
    try {
      if (item.source === 'inbox') {
        await removeInbox(item.episode_id);
      } else if (onRemoveQueuedEpisode) {
        onRemoveQueuedEpisode(item.episode_id);
      } else {
        const nextItems = rows
          .filter((entry) => entry.source === 'queue' && entry.episode_id !== item.episode_id)
          .map((entry) => ({ episode_id: entry.episode_id, origin: entry.origin }));
        const saved = await putPodcastQueue(queueVersion, nextItems);
        setQueueVersion(saved.version);
      }
      setRows((current) => current.filter((entry) => entry.episode_id !== item.episode_id));
    } catch {
      setProblem('暂时无法从待播移除。请重试。');
    }
  }

  async function playAllPending() {
    const playable = rows.filter((entry) => entry.episode && entry.show);
    if (!playable.length) {
      setProblem('待播列表中没有可播放的单集。');
      return;
    }
    try {
      const inboxRows = playable.filter((entry) => entry.source === 'inbox');
      for (const item of inboxRows) {
        await Promise.resolve(
          onQueueTrack(podcastEpisodeToTrack(item.episode!, item.show!), false),
        );
        await removeInbox(item.episode_id).catch(() => {});
      }
      if (onPlayQueue && rows.some((entry) => entry.source === 'queue')) {
        await Promise.resolve(onPlayQueue());
        onClose();
        return;
      }
      const first = playable[0];
      if (onPlayTrack && first.episode && first.show) {
        await Promise.resolve(onPlayTrack(podcastEpisodeToTrack(first.episode, first.show)));
        onClose();
        return;
      }
      if (onPlayQueue) {
        await Promise.resolve(onPlayQueue());
        onClose();
      }
    } catch {
      setProblem('暂时无法开始播放待播列表。请重试。');
    }
  }

  async function updateShowDelivery(showId: string, nextAction: NewEpisodeAction) {
    const limit = showLimits[showId] ?? defaultLimit;
    setShowActions((current) => ({ ...current, [showId]: nextAction }));
    try {
      await saveShowDelivery(showId, nextAction, limit);
    } catch {
      setProblem('暂时无法保存节目新集自动待播。请重试。');
    }
  }

  const playableCount = rows.filter((item) => item.episode && item.show).length;

  return (
    <div className="podcasts-modal-backdrop" onClick={onClose}>
      <div
        className="podcasts-modal podcast-search-modal podcast-inbox"
        role="dialog"
        aria-modal="true"
        aria-labelledby="podcast-inbox-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="podcast-inbox-header">
          <h3 id="podcast-inbox-title">待播列表</h3>
        </div>
        {status === 'loading' && (
          <div className="podcast-inbox-list" role="status" aria-label="正在读取待播列表">
            <span className="podcast-inbox-skeleton" />
            <span className="podcast-inbox-skeleton" />
            <span className="podcast-inbox-skeleton" />
          </div>
        )}
        {status === 'error' && (
          <div role="alert">
            <p>暂时无法读取待播列表。请重试。</p>
            <button type="button" className="podcasts-action-btn" onClick={() => void load()}>
              重试
            </button>
          </div>
        )}
        {status === 'ready' && !rows.length && (
          <div className="podcasts-empty" role="status">
            <p>待播列表为空。在单集右侧点「+ 待播」，或开启下方「新集自动加入待播」。</p>
            <button type="button" className="podcasts-action-btn" onClick={onBrowse}>
              浏览节目
            </button>
          </div>
        )}
        {problem && (
          <p className="podcast-inbox-problem" role="alert">
            {problem}
          </p>
        )}
        {status === 'ready' && rows.length > 0 && (
          <section className="podcast-inbox-section" aria-label="待播单集">
            <div className="podcast-inbox-section-header">
              <h4>
                待播单集 <small>{rows.length}</small>
              </h4>
              {playableCount > 0 && (
                <button
                  type="button"
                  className="podcasts-action-btn primary"
                  onClick={() => void playAllPending()}
                >
                  ▶ 播放全部
                </button>
              )}
            </div>
            <ul className="podcast-inbox-list">
              {rows.map((item) => (
                <li className="podcast-inbox-item" key={item.episode_id}>
                  <div className="podcast-inbox-copy">
                    <strong>{item.title}</strong>
                    {item.showTitle && <span>{item.showTitle}</span>}
                  </div>
                  <div className="podcast-inbox-actions">
                    {item.episode && item.show && (
                      <button
                        type="button"
                        className="podcasts-action-btn"
                        onClick={() =>
                          void playRow(item).catch(() => setProblem('暂时无法播放该单集。请重试。'))
                        }
                      >
                        播放
                      </button>
                    )}
                    <button
                      type="button"
                      className="podcasts-action-btn"
                      onClick={() => void removeRow(item)}
                    >
                      移除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {status === 'ready' && followedShows.length > 0 && (
          <section className="podcast-inbox-section" aria-label="新集自动加入待播">
            <div className="podcast-inbox-section-header">
              <h4>新集自动加入待播</h4>
            </div>
            <ul className="podcast-inbox-list">
              {followedShows.map((show) => {
                const currentAction = showActions[show.id] ?? defaultAction;
                return (
                  <li className="podcast-inbox-item" key={`delivery-${show.id}`}>
                    <div className="podcast-inbox-copy">
                      <strong>{show.title}</strong>
                      <span>
                        {show.followed ? '已关注' : '未关注 · 关注后生效'}
                        {show.author ? ` · ${show.author}` : ''}
                      </span>
                    </div>
                    <div className="podcast-inbox-actions">
                      <ActionSelect
                        label="新集自动待播"
                        ariaLabel={`${show.title}新集自动待播`}
                        hideLabel
                        value={currentAction}
                        onChange={(value) => void updateShowDelivery(show.id, value)}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <button type="button" className="modal-cancel-btn" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}

export async function rememberForLater(episodeId: string) {
  await addInbox(episodeId);
}
