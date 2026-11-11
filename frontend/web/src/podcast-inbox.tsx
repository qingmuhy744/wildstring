import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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

const ACTION_KEYS: { value: NewEpisodeAction; key: string }[] = [
  { value: 'ignore', key: 'actionIgnore' },
  { value: 'queue_last', key: 'actionQueueLast' },
  { value: 'queue_next', key: 'actionQueueNext' },
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
  const { t } = useTranslation();
  const normalizedValue = normalizeDeliveryAction(value);
  const selectNode = (
    <select
      className="podcast-select"
      aria-label={ariaLabel || label}
      value={normalizedValue}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as NewEpisodeAction)}
    >
      {ACTION_KEYS.map((item) => (
        <option key={item.value} value={item.value}>
          {t(`podcastInbox.${item.key}`)}
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
  const { t } = useTranslation();
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
        <p role="status">{t('podcastInbox.readingDelivery')}</p>
      ) : (
        <ActionSelect
          label={t('podcastInbox.deliveryLabel')}
          value={action}
          onChange={(value) => void save(value, limit)}
        />
      )}
      {status === 'error' && (
        <p className="podcast-settings-error" role="alert">
          {t('podcastInbox.saveDeliveryFailed')}
          <button type="button" onClick={() => setReloadKey((value) => value + 1)}>
            {t('podcastInbox.retry')}
          </button>
        </p>
      )}
    </div>
  );
}

export function PodcastQueueDefaults() {
  const { t } = useTranslation();
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
        <p role="status">{t('podcastInbox.readingDelivery')}</p>
      ) : (
        <ActionSelect
          label={t('podcastInbox.defaultDeliveryLabel')}
          value={action}
          onChange={(value) => void save(value, limit)}
        />
      )}
      {status === 'error' && (
        <p className="podcast-settings-error" role="alert">
          {t('podcastInbox.readDeliveryFailed')}
          <button type="button" onClick={() => setReloadKey((value) => value + 1)}>
            {t('podcastInbox.retry')}
          </button>
        </p>
      )}
    </div>
  );
}

interface UnifiedPendingRow {
  episode_id: string;
  addedAt: string;
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
}: {
  onClose: () => void;
  onBrowse: () => void;
  onQueueTrack: (track: Track, next: boolean) => void | boolean | Promise<unknown>;
  onPlayTrack?: (track: Track) => void | Promise<unknown>;
  onPlayQueue?: () => void | Promise<unknown>;
  onRemoveQueuedEpisode?: (episodeId: string) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'episodes' | 'rules'>('episodes');
  const [rows, setRows] = useState<UnifiedPendingRow[]>([]);
  const [queueVersion, setQueueVersion] = useState(0);
  const [followedShows, setFollowedShows] = useState<PodcastSummary[]>([]);
  const [defaultAction, setDefaultAction] = useState<NewEpisodeAction>('queue_last');
  const [defaultLimit, setDefaultLimit] = useState(3);
  const [showActions, setShowActions] = useState<Record<string, NewEpisodeAction>>({});
  const [showLimits, setShowLimits] = useState<Record<string, number>>({});
  const [selectedShows, setSelectedShows] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [problem, setProblem] = useState('');
  const pointerDrag = useRef<number | null>(null);

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
              addedAt: item.added_at ?? '',
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
              addedAt: item.added_at ?? '',
              origin: item.origin,
              source: 'queue',
              title: t('podcastInbox.unreadableEpisode'),
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
                addedAt: item.added_at ?? '',
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
                addedAt: item.added_at ?? '',
                origin: 'manual',
                source: 'inbox',
                title: t('podcastInbox.unreadableEpisode'),
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
      // Explicit queue entries keep their playback/manual order; unqueued inbox rows follow by join time.
      const sortedInbox = [...resolvedInbox].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
      setRows([...resolvedQueue, ...sortedInbox]);
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

  useEffect(() => {
    const synced = (event: Event) => {
      const saved = (event as CustomEvent<{ version: number }>).detail;
      if (saved && typeof saved.version === 'number') {
        setQueueVersion(saved.version);
      }
    };
    window.addEventListener('wildstring:podcast-queue-saved', synced);
    return () => window.removeEventListener('wildstring:podcast-queue-saved', synced);
  }, []);

  async function playRow(item: UnifiedPendingRow) {
    if (!item.episode || !item.show) {
      setProblem(t('podcastInbox.unreadableEpisodeHelp'));
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
      } else {
        const nextItems = rows
          .filter((entry) => entry.source === 'queue' && entry.episode_id !== item.episode_id)
          .map((entry) => ({
            episode_id: entry.episode_id,
            origin: entry.origin,
            added_at: entry.addedAt,
          }));
        const saved = await putPodcastQueue(queueVersion, nextItems);
        setQueueVersion(saved.version);
        window.dispatchEvent(
          new CustomEvent('wildstring:podcast-queue-updated', { detail: saved }),
        );
      }
      setRows((current) => current.filter((entry) => entry.episode_id !== item.episode_id));
    } catch {
      setProblem(t('podcastInbox.removeFailed'));
    }
  }

  async function moveRow(from: number, to: number) {
    if (from === to || to < 0 || to >= rows.length) return;
    const previous = rows;
    const next = [...rows];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setRows(next);
    setProblem('');
    try {
      const saved = await putPodcastQueue(
        queueVersion,
        next.map((item) => ({
          episode_id: item.episode_id,
          origin: 'manual' as const,
          added_at: item.addedAt,
        })),
      );
      setQueueVersion(saved.version);
      window.dispatchEvent(new CustomEvent('wildstring:podcast-queue-updated', { detail: saved }));
      setRows(
        next.map((item) => ({ ...item, source: 'queue' as const, origin: 'manual' as const })),
      );
    } catch {
      setRows(previous);
      setProblem(t('podcastInbox.reorderFailed'));
      // Another device may have advanced the queue; refresh the version so a retry can apply.
      const fresh = await getPodcastQueue().catch(() => null);
      if (fresh) setQueueVersion(fresh.version);
    }
  }

  async function playAllPending() {
    const playable = rows.filter((entry) => entry.episode && entry.show);
    if (!playable.length) {
      setProblem(t('podcastInbox.noPlayableEpisodes'));
      return;
    }
    try {
      if (playable.some((entry) => entry.source === 'inbox')) {
        const saved = await putPodcastQueue(
          queueVersion,
          playable.map((item) => ({
            episode_id: item.episode_id,
            origin: item.source === 'queue' ? item.origin : ('manual' as const),
            added_at: item.addedAt,
          })),
        );
        setQueueVersion(saved.version);
        window.dispatchEvent(
          new CustomEvent('wildstring:podcast-queue-updated', { detail: saved }),
        );
      }
      if (onPlayQueue) {
        await Promise.resolve(onPlayQueue());
        onClose();
        return;
      }
      const first = playable[0];
      if (onPlayTrack && first.episode && first.show) {
        await Promise.resolve(onPlayTrack(podcastEpisodeToTrack(first.episode, first.show)));
        onClose();
      }
    } catch {
      setProblem(t('podcastInbox.playQueueFailed'));
    }
  }

  async function updateShowDelivery(showId: string, nextAction: NewEpisodeAction) {
    const limit = showLimits[showId] ?? defaultLimit;
    setShowActions((current) => ({ ...current, [showId]: nextAction }));
    try {
      await saveShowDelivery(showId, nextAction, limit);
    } catch {
      setProblem(t('podcastInbox.saveShowDeliveryFailed'));
    }
  }

  /** Applies one action to every selected show at once; rows that fail roll back individually. */
  async function updateSelectedDelivery(nextAction: NewEpisodeAction) {
    if (!selectedShows.length || bulkBusy) return;
    const targets = [...selectedShows];
    const previous = { ...showActions };
    setBulkBusy(true);
    setProblem('');
    setShowActions((current) => {
      const next = { ...current };
      for (const id of targets) next[id] = nextAction;
      return next;
    });
    const results = await Promise.allSettled(
      targets.map((id) => saveShowDelivery(id, nextAction, showLimits[id] ?? defaultLimit)),
    );
    const failed = targets.filter((_, index) => results[index].status === 'rejected');
    setShowActions((current) => {
      const next = { ...current };
      for (const id of failed) {
        if (previous[id]) next[id] = previous[id];
        else delete next[id];
      }
      return next;
    });
    setBulkBusy(false);
    if (failed.length) setProblem(t('podcastInbox.bulkDeliveryFailed', { count: failed.length }));
    else setSelectedShows([]);
  }

  function toggleShowSelection(showId: string) {
    setSelectedShows((current) =>
      current.includes(showId) ? current.filter((id) => id !== showId) : [...current, showId],
    );
  }

  const playableCount = rows.filter((item) => item.episode && item.show).length;
  const sortedRuleShows = [...followedShows].sort((a, b) => {
    const actionA = showActions[a.id] ?? defaultAction;
    const actionB = showActions[b.id] ?? defaultAction;
    const activeA = actionA !== 'ignore' ? 0 : 1;
    const activeB = actionB !== 'ignore' ? 0 : 1;
    if (activeA !== activeB) return activeA - activeB;
    return Boolean(a.followed) === Boolean(b.followed) ? 0 : a.followed ? -1 : 1;
  });

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
          <h3 id="podcast-inbox-title">{t('podcastInbox.inboxTitle')}</h3>
          {status === 'ready' && playableCount > 0 && (
            <button
              type="button"
              className="podcasts-action-btn primary"
              onClick={() => void playAllPending()}
            >
              {t('podcastInbox.playAll')}
            </button>
          )}
        </div>
        {status === 'ready' && (
          <div
            className="podcast-inbox-tabs"
            role="tablist"
            aria-label={t('podcastInbox.inboxTitle')}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'episodes'}
              className={`podcast-inbox-tab${tab === 'episodes' ? ' active' : ''}`}
              onClick={() => setTab('episodes')}
            >
              {t('podcastInbox.pendingEpisodesTitle')} <small>{rows.length}</small>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'rules'}
              className={`podcast-inbox-tab${tab === 'rules' ? ' active' : ''}`}
              onClick={() => setTab('rules')}
            >
              {t('podcastInbox.autoQueueSectionTitle')} <small>{followedShows.length}</small>
            </button>
          </div>
        )}
        {status === 'loading' && (
          <div
            className="podcast-inbox-list"
            role="status"
            aria-label={t('podcastInbox.readingInboxAria')}
          >
            <span className="podcast-inbox-skeleton" />
            <span className="podcast-inbox-skeleton" />
            <span className="podcast-inbox-skeleton" />
          </div>
        )}
        {status === 'error' && (
          <div role="alert">
            <p>{t('podcastInbox.readInboxFailed')}</p>
            <button type="button" className="podcasts-action-btn" onClick={() => void load()}>
              {t('podcastInbox.retry')}
            </button>
          </div>
        )}
        {problem && (
          <p className="podcast-inbox-problem" role="alert">
            {problem}
          </p>
        )}
        {status === 'ready' && tab === 'episodes' && !rows.length && (
          <div className="podcasts-empty" role="status">
            <p>{t('podcastInbox.emptyInbox')}</p>
            <button type="button" className="podcasts-action-btn" onClick={onBrowse}>
              {t('podcastInbox.browseShows')}
            </button>
          </div>
        )}
        {status === 'ready' && tab === 'episodes' && rows.length > 0 && (
          <section
            className="podcast-inbox-section"
            aria-label={t('podcastInbox.pendingSectionAria')}
          >
            <ul className="podcast-inbox-list">
              {rows.map((item, index) => (
                <li className="podcast-inbox-item" key={item.episode_id} data-pending-index={index}>
                  <span
                    className="podcast-inbox-handle"
                    aria-hidden="true"
                    onPointerDown={(event) => {
                      if (event.pointerType === 'mouse') return;
                      pointerDrag.current = index;
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerUp={(event) => {
                      const from = pointerDrag.current;
                      pointerDrag.current = null;
                      if (from === null) return;
                      const target = document
                        .elementFromPoint(event.clientX, event.clientY)
                        ?.closest<HTMLElement>('[data-pending-index]');
                      const to = Number(target?.dataset.pendingIndex);
                      if (Number.isInteger(to) && to !== from) void moveRow(from, to);
                    }}
                    onPointerCancel={() => {
                      pointerDrag.current = null;
                    }}
                  >
                    ⠿
                  </span>
                  <div className="podcast-inbox-copy">
                    <strong>{item.title}</strong>
                    {item.showTitle && <span>{item.showTitle}</span>}
                  </div>
                  <div className="podcast-inbox-actions">
                    <span
                      className="podcast-inbox-reorder"
                      role="group"
                      aria-label={t('podcastInbox.reorderAria', { title: item.title })}
                    >
                      <button
                        type="button"
                        aria-label={t('podcastInbox.moveUp', { title: item.title })}
                        disabled={index === 0}
                        onClick={() => void moveRow(index, index - 1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={t('podcastInbox.moveDown', { title: item.title })}
                        disabled={index === rows.length - 1}
                        onClick={() => void moveRow(index, index + 1)}
                      >
                        ↓
                      </button>
                    </span>
                    {item.episode && item.show && (
                      <button
                        type="button"
                        className="podcasts-action-btn"
                        onClick={() =>
                          void playRow(item).catch(() =>
                            setProblem(t('podcastInbox.playEpisodeFailed')),
                          )
                        }
                      >
                        {t('podcastInbox.play')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="podcasts-action-btn"
                      onClick={() => void removeRow(item)}
                    >
                      {t('podcastInbox.remove')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {status === 'ready' && tab === 'rules' && (
          <section
            className="podcast-inbox-section"
            aria-label={t('podcastInbox.autoQueueSectionAria')}
          >
            {sortedRuleShows.length === 0 ? (
              <div className="podcasts-empty" role="status">
                <p>{t('podcastInbox.emptyInbox')}</p>
                <button type="button" className="podcasts-action-btn" onClick={onBrowse}>
                  {t('podcastInbox.browseShows')}
                </button>
              </div>
            ) : (
              <>
                <div className="podcast-inbox-bulk-bar">
                  <label className="podcast-inbox-select-all">
                    <input
                      type="checkbox"
                      checked={
                        selectedShows.length > 0 && selectedShows.length === sortedRuleShows.length
                      }
                      onChange={(event) =>
                        setSelectedShows(
                          event.target.checked ? sortedRuleShows.map((show) => show.id) : [],
                        )
                      }
                    />
                    {t('podcastInbox.selectAllShows')}
                  </label>
                  {selectedShows.length > 0 && (
                    <div className="podcast-inbox-bulk-actions" role="group">
                      <span className="podcast-inbox-bulk-count">
                        {t('podcastInbox.selectedShows', { count: selectedShows.length })}
                      </span>
                      <button
                        type="button"
                        disabled={bulkBusy}
                        onClick={() => void updateSelectedDelivery('queue_last')}
                      >
                        {t('podcastInbox.actionQueueLast')}
                      </button>
                      <button
                        type="button"
                        disabled={bulkBusy}
                        onClick={() => void updateSelectedDelivery('ignore')}
                      >
                        {t('podcastInbox.actionIgnore')}
                      </button>
                      <button
                        type="button"
                        className="podcast-inbox-bulk-clear"
                        disabled={bulkBusy}
                        onClick={() => setSelectedShows([])}
                      >
                        {t('podcastInbox.clearSelection')}
                      </button>
                    </div>
                  )}
                </div>
                <ul className="podcast-inbox-list">
                  {sortedRuleShows.map((show) => {
                    const currentAction = showActions[show.id] ?? defaultAction;
                    const selected = selectedShows.includes(show.id);
                    return (
                      <li
                        className={`podcast-inbox-item compact${selected ? ' selected' : ''}`}
                        key={`delivery-${show.id}`}
                      >
                        <input
                          type="checkbox"
                          className="podcast-inbox-select"
                          checked={selected}
                          aria-label={t('podcastInbox.selectShowAria', { title: show.title })}
                          onChange={() => toggleShowSelection(show.id)}
                        />
                        <div className="podcast-inbox-copy">
                          <strong>{show.title}</strong>
                        </div>
                        <div className="podcast-inbox-actions">
                          <ActionSelect
                            label={t('podcastInbox.deliveryLabel')}
                            ariaLabel={t('podcastInbox.showDeliveryAria', { title: show.title })}
                            hideLabel
                            disabled={selected}
                            value={currentAction}
                            onChange={(value) => void updateShowDelivery(show.id, value)}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>
        )}
        <button type="button" className="modal-cancel-btn" onClick={onClose}>
          {t('podcastInbox.close')}
        </button>
      </div>
    </div>
  );
}

export async function rememberForLater(episodeId: string) {
  await addInbox(episodeId);
}
