import { useEffect, useState } from 'react';
import { api, type Track } from './api';
import type { PodcastEpisode, PodcastSummary } from './podcasts';
import { podcastEpisodeToTrack } from './podcast-track';
import {
  addInbox,
  getInbox,
  getQueuePreferences,
  removeInbox,
  saveQueueDefaults,
  saveShowDelivery,
  type InboxItem,
  type NewEpisodeAction,
} from './podcast-remote';

const actions: { value: NewEpisodeAction; label: string }[] = [
  { value: 'inbox', label: '进稍后听' },
  { value: 'queue_last', label: '加到队尾' },
  { value: 'queue_next', label: '插到当前之后' },
  { value: 'ignore', label: '不处理' },
];

function ActionSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: NewEpisodeAction;
  disabled?: boolean;
  onChange: (value: NewEpisodeAction) => void;
}) {
  return (
    <label>
      {label}
      <select
        className="podcast-select"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as NewEpisodeAction)}
      >
        {actions.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function PodcastDeliverySelect({ showId }: { showId: string }) {
  const [action, setAction] = useState<NewEpisodeAction>('inbox');
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
        setAction(show?.action ?? prefs.default_action);
        setLimit(show?.auto_limit ?? prefs.auto_limit);
        setStatus('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('error');
      });
    return () => controller.abort();
  }, [showId, reloadKey]);

  async function save(nextAction: NewEpisodeAction, nextLimit: number) {
    const bounded = Math.max(0, Math.min(100, Number.isFinite(nextLimit) ? nextLimit : 0));
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
        <p role="status">正在读取新集处理</p>
      ) : (
        <>
          <ActionSelect
            label="新集处理"
            value={action}
            onChange={(value) => void save(value, limit)}
          />
          <label>
            最多自动入队
            <input
              aria-label="最多自动入队"
              type="number"
              min={0}
              max={100}
              value={limit}
              onChange={(event) => void save(action, Number(event.target.value))}
            />
            集
          </label>
        </>
      )}
      {status === 'error' && (
        <p className="podcast-settings-error" role="alert">
          暂时无法保存新集处理。
          <button type="button" onClick={() => setReloadKey((value) => value + 1)}>
            重试
          </button>
        </p>
      )}
    </div>
  );
}

export function PodcastQueueDefaults() {
  const [action, setAction] = useState<NewEpisodeAction>('inbox');
  const [limit, setLimit] = useState(3);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void getQueuePreferences()
      .then((prefs) => {
        if (controller.signal.aborted) return;
        setAction(prefs.default_action);
        setLimit(prefs.auto_limit);
        setStatus('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('error');
      });
    return () => controller.abort();
  }, [reloadKey]);

  async function save(nextAction: NewEpisodeAction, nextLimit: number) {
    const bounded = Math.max(0, Math.min(100, Number.isFinite(nextLimit) ? nextLimit : 0));
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
        <p role="status">正在读取新集处理</p>
      ) : (
        <>
          <ActionSelect
            label="默认新集处理"
            value={action}
            onChange={(value) => void save(value, limit)}
          />
          <label>
            默认最多自动入队
            <input
              aria-label="默认最多自动入队"
              type="number"
              min={0}
              max={100}
              value={limit}
              onChange={(event) => void save(action, Number(event.target.value))}
            />
            集
          </label>
        </>
      )}
      {status === 'error' && (
        <p className="podcast-settings-error" role="alert">
          暂时无法读取新集处理。
          <button type="button" onClick={() => setReloadKey((value) => value + 1)}>
            重试
          </button>
        </p>
      )}
    </div>
  );
}

interface InboxRow extends InboxItem {
  title: string;
  showTitle?: string;
  episode?: PodcastEpisode;
  show?: PodcastSummary;
}

export function PodcastInboxDialog({
  onClose,
  onBrowse,
  onQueueTrack,
}: {
  onClose: () => void;
  onBrowse: () => void;
  onQueueTrack: (track: Track, next: boolean) => void | boolean | Promise<unknown>;
}) {
  const [items, setItems] = useState<InboxRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [problem, setProblem] = useState('');

  async function load() {
    setStatus('loading');
    setProblem('');
    try {
      const inbox = await getInbox();
      const detailed = await Promise.all(
        inbox.items.map(async (item) => {
          try {
            const episode = await api<PodcastEpisode>(
              `/podcasts/episodes/${encodeURIComponent(item.episode_id)}`,
            );
            const detail = await api<{ podcast: PodcastSummary }>(
              `/podcasts/${encodeURIComponent(item.podcast_id)}`,
            );
            return {
              ...item,
              title: episode.title,
              showTitle: detail.podcast.title,
              episode,
              show: detail.podcast,
            };
          } catch {
            return { ...item, title: '这一集已经无法读取' };
          }
        }),
      );
      setItems(detailed);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function queueItem(item: InboxRow) {
    if (!item.episode || !item.show) {
      setProblem('这一集已经无法读取。可以移除它，或稍后重试。');
      return;
    }
    await Promise.resolve(onQueueTrack(podcastEpisodeToTrack(item.episode, item.show), false));
    await removeInbox(item.episode_id);
    setItems((current) => current.filter((entry) => entry.episode_id !== item.episode_id));
  }

  return (
    <div className="podcasts-modal-backdrop" onClick={onClose}>
      <div
        className="podcasts-modal podcast-search-modal podcast-inbox"
        role="dialog"
        aria-modal="true"
        aria-labelledby="podcast-inbox-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="podcast-inbox-title">稍后听</h3>
        {status === 'loading' && (
          <div className="podcast-inbox-list" role="status" aria-label="正在读取稍后听">
            <span className="podcast-inbox-skeleton" />
            <span className="podcast-inbox-skeleton" />
            <span className="podcast-inbox-skeleton" />
          </div>
        )}
        {status === 'error' && (
          <div role="alert">
            <p>暂时无法读取稍后听。请重试。</p>
            <button type="button" className="podcasts-action-btn" onClick={() => void load()}>
              重试
            </button>
          </div>
        )}
        {status === 'ready' && !items.length && (
          <div className="podcasts-empty" role="status">
            <p>关注的节目更新后会出现在这里。</p>
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
        {status === 'ready' && !!items.length && (
          <ul className="podcast-inbox-list">
            {items.map((item) => (
              <li className="podcast-inbox-item" key={item.episode_id}>
                <div className="podcast-inbox-copy">
                  <strong>{item.title}</strong>
                  {item.showTitle && <span>{item.showTitle}</span>}
                </div>
                <div className="podcast-inbox-actions">
                  <button
                    type="button"
                    className="podcasts-action-btn"
                    onClick={() =>
                      void queueItem(item).catch(() => setProblem('暂时无法加入待播。请重试。'))
                    }
                  >
                    加入待播
                  </button>
                  <button
                    type="button"
                    className="podcasts-action-btn"
                    onClick={() =>
                      void removeInbox(item.episode_id)
                        .then(() =>
                          setItems((current) =>
                            current.filter((entry) => entry.episode_id !== item.episode_id),
                          ),
                        )
                        .catch(() => setProblem('暂时无法移除。请重试。'))
                    }
                  >
                    移除
                  </button>
                </div>
              </li>
            ))}
          </ul>
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
