import './recommendations.css';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { api, eventId, artist, time, type Playlist, type Track, type User } from './api';
import { Cover } from './cover';
import { Icon } from './icons';
import { FavoriteButton, type Favorites } from './favorites';
import { RowMenu } from './row-menu';
import { RecommendationLyricsDialog, RecommendationPlaylistDialog } from './recommendation-dialogs';
import type { Player } from './player';
import { SyncModeControl } from './playback-sync';
import { modeNames, QUEUE_LIMIT, type PlaybackMode } from './playback-state';
import { ModelConnectionChoice, useModelConnections } from './model-connection';
import { RecommendationPreferencesForm, RecommendationSources } from './recommendation-preferences';
import { ListeningRankings } from './listening-rankings';
import { ExternalRecommendations } from './external-recommendations';
import { PlaybackIndicator } from './playback-indicator';
import {
  recommendationSourceName,
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
const reasonKeys: Record<string, string> = {
  来自你的收藏: 'discover.reasons.liked',
  根据你之前的收听反馈: 'discover.reasons.feedback',
  来自你听过或收藏的艺人: 'discover.reasons.artist',
  重听曲库里的熟悉旋律: 'discover.reasons.revisit',
  探索曲库中尚未听过的歌曲: 'discover.reasons.explore',
  来自曲库用户近30天的实际收听热度: 'discover.reasons.community',
  探索本曲库中你尚未听过的歌曲: 'discover.reasons.discovery',
  你已超过30天没有重听这首歌: 'discover.reasons.revisit30',
  'Last.fm 公共来源中找到与本库标题、艺人一致的歌曲': 'discover.reasons.lastfm',
  '根据你听过或收藏歌曲的 Last.fm 相似关系，在本地曲库找到': 'discover.reasons.lastfmSimilar',
  从本地曲库中选取: 'discover.reasons.localPick',
  本地关键词匹配: 'discoverPage.reasons.localMatch',
  本地曲库候选: 'discoverPage.reasons.localCandidate',
};
function explanation(t: TFunction, reason: unknown): string {
  if (typeof reason !== 'string') return t('discover.row.reasonFallback');
  const key = reasonKeys[reason];
  return key ? t(key) : reason;
}
/** Server dates are ISO days; anything else (legacy local batches) is shown as given. */
function dailyDate(date: string | undefined, language: string): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return date || '';
  return new Intl.DateTimeFormat(language.startsWith('zh') ? 'zh-CN' : 'en', {
    month: 'long',
    day: 'numeric',
  }).format(new Date(`${date}T00:00:00`));
}
/** Names the sources that actually contributed, so the summary says why these songs are here. */
function dailySummary(daily: Daily, t: TFunction): string {
  const sources = (daily.source_status || [])
    .filter((source) => source.status === 'ok' && source.matched > 0)
    .slice(0, 2)
    .map((source) => recommendationSourceName(t, source.id));
  const engine = daily.engine.includes('ai')
    ? t('discover.daily.engineAi')
    : sources.length
      ? ''
      : t('discover.daily.engineLocal');
  return [t('discover.daily.count', { count: daily.items.length }), ...sources, engine]
    .filter(Boolean)
    .join(' · ');
}
/** The first covers give each day's batch its own face; short batches show a single cover. */
function DailyMosaic({ tracks }: { tracks: Track[] }) {
  const shown = tracks.length >= 4 ? tracks.slice(0, 4) : tracks.slice(0, 1);
  return (
    <div className={`daily-mosaic ${shown.length === 4 ? 'is-grid' : ''}`} aria-hidden="true">
      {shown.map((track) => (
        <Cover key={track.id} trackId={track.id} title={track.title} />
      ))}
    </div>
  );
}
const discoveryTitleKeys: Record<string, string> = {
  曲库里的发现: 'discover.ai.localTitle',
  为你选的歌: 'discover.ai.defaultTitle',
  曲库中没有可推荐的歌曲: 'discover.ai.noTitle',
};
function discoveryTitle(title: string, t: TFunction): string {
  const key = discoveryTitleKeys[title];
  return key ? t(key) : title;
}
function dailySource(ids: string[] | undefined, t: TFunction): string | undefined {
  return ids?.map((id) => recommendationSourceName(t, id)).find(Boolean);
}
function Choices({
  items,
  player,
  favorites,
  feedback,
  onChange,
  onPlaylist,
  onLyrics,
  onNotice,
  onOpenAlbum,
  selected,
  onSelect,
}: {
  items: Choice[];
  player: Player;
  favorites: Favorites;
  feedback?: (id: string, action: string) => void;
  onChange?: (items: Choice[]) => void;
  onPlaylist: (tracks: Track[]) => void;
  onLyrics: (track: Track) => void;
  onNotice: (message: string) => void;
  onOpenAlbum: (track: Track) => void;
  selected?: Set<string>;
  onSelect?: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="discovery-list">
      {items.map(({ track, reason, source_ids }, index) => (
        <RowMenu
          key={track.id}
          label={track.title}
          className={`discovery-track ${feedback ? 'daily-track' : ''} ${player.current?.id === track.id ? 'is-current' : ''} ${selected?.has(track.id) ? 'is-selected' : ''}`}
          actions={[
            {
              label: t('discover.row.next'),
              icon: 'next',
              run: () =>
                onNotice(
                  player.playNext(track)
                    ? t('discover.row.nextNotice', { title: track.title })
                    : t('discover.row.queueFull'),
                ),
            },
            {
              label: t('discover.row.queue'),
              icon: 'queue',
              run: () =>
                onNotice(
                  player.enqueue(track)
                    ? t('discover.row.queueNotice', { title: track.title })
                    : t('discover.row.queueFull'),
                ),
            },
            {
              label: t('discover.row.playlist'),
              icon: 'playlist',
              run: () => onPlaylist([track]),
            },
            { label: t('discover.row.lyrics'), icon: 'draft', run: () => onLyrics(track) },
            ...(track.album_id
              ? [
                  {
                    label: t('discover.row.album'),
                    icon: 'album' as const,
                    run: () => onOpenAlbum(track),
                  },
                ]
              : []),
            {
              label: favorites.ids.has(track.id)
                ? t('discover.row.unfavorite')
                : t('discover.row.favorite'),
              icon: 'heart',
              disabled: !favorites.ready || favorites.busy.has(track.id),
              run: () => void favorites.toggle(track),
            },
            ...(feedback
              ? [
                  {
                    label: t('discover.row.dismiss'),
                    icon: 'remove' as const,
                    run: () => feedback(track.id, 'dismiss_track'),
                  },
                  {
                    label: t('discover.row.lessArtist'),
                    icon: 'artist' as const,
                    run: () => feedback(track.id, 'less_artist'),
                  },
                ]
              : []),
          ]}
        >
          {feedback && (
            <span className="daily-track-number">
              {onSelect ? (
                <input
                  type="checkbox"
                  aria-label={t('discover.row.select', { title: track.title })}
                  checked={selected?.has(track.id) ?? false}
                  onChange={() => onSelect(track.id)}
                />
              ) : player.current?.id === track.id ? (
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
              if (onSelect) {
                onSelect(track.id);
                return;
              }
              player.start(
                items.map((i) => i.track),
                index,
              );
              feedback?.(track.id, 'accept');
            }}
            aria-label={t('discover.row.play', { title: track.title })}
          >
            <strong>
              {!feedback && player.current?.id === track.id && (
                <PlaybackIndicator playing={player.playing} buffering={player.buffering} />
              )}
              {track.title}
            </strong>
            <small title={feedback ? explanation(t, reason) : undefined}>
              {artist(track)}
              {feedback && (dailySource(source_ids, t) || track.album)
                ? ` · ${dailySource(source_ids, t) || track.album}`
                : ''}
            </small>
            {!feedback && <small>{explanation(t, reason)}</small>}
            {!feedback && !!source_ids?.length && (
              <span className="recommendation-source-pills">
                {source_ids.slice(0, 3).map((id) => (
                  <span key={id}>{recommendationSourceName(t, id)}</span>
                ))}
              </span>
            )}
          </button>
          {!feedback && <FavoriteButton track={track} favorites={favorites} />}
          {onChange && (
            <div className="candidate-actions">
              <button
                aria-label={t('discover.row.moveUp', { title: track.title })}
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
                aria-label={t('discover.row.moveDown', { title: track.title })}
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
                aria-label={t('discover.row.remove', { title: track.title })}
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
  playlists,
  onOpenAlbum,
}: {
  player: Player;
  favorites: Favorites;
  onSaved: (list: Playlist) => void;
  onConnections: () => void;
  playlists: Playlist[];
  onOpenAlbum: (track: Track) => void;
}) {
  const { t, i18n } = useTranslation();
  const connections = useModelConnections();
  const [section, setSection] = useState('daily');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [playlistTracks, setPlaylistTracks] = useState<Track[] | null>(null);
  const [lyricTrack, setLyricTrack] = useState<Track | null>(null);
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
  const chosen =
    daily?.items.filter(({ track }) => selected.has(track.id)).map(({ track }) => track) || [];
  function selectTrack(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function queueSelection(next = false) {
    if (player.addToQueue(chosen, next)) {
      setMessage(
        next
          ? t('discover.daily.queuedNext', { count: chosen.length })
          : t('discover.daily.queued', { count: chosen.length }),
      );
      setSelected(new Set());
      setSelecting(false);
    } else setError(t('discover.daily.queueFull'));
  }
  const choiceActions = {
    onPlaylist: setPlaylistTracks,
    onLyrics: setLyricTrack,
    onNotice: setMessage,
    onOpenAlbum,
  };
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
      throw new Error(t('discover.messages.savePlaylistError'));
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
          setError(reason instanceof Error ? reason.message : t('discover.messages.loadError'));
      });
    return () => controller.abort();
  }, [refresh]);
  async function action(labelKey: string, fn: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(labelKey);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('discover.messages.actionError'));
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
        setMessage(
          action === 'accept'
            ? t('discover.messages.feedbackAccepted')
            : t('discover.messages.feedbackSaved'),
        ),
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
        setError(t('discover.messages.feedbackFailed'));
      })
      .finally(() => feedbackPending.current.delete(id));
  }
  function discover(event: FormEvent) {
    event.preventDefault();
    void action('discover.ai.busy', async () => {
      let result: Discovery;
      if (!Array.isArray(preferences?.sources)) {
        const page = await api<{ items: Track[] }>(
          `/tracks?q=${encodeURIComponent(prompt.trim())}&limit=30`,
        );
        result = {
          title: prompt.trim().slice(0, 100),
          items: page.items.map((track) => ({
            track,
            reason: t('discoverPage.reasons.localMatch'),
          })),
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
    <section className="completion-page music-discovery" aria-label={t('discover.aria')}>
      <header className="discovery-hero">
        <h1>{t('discover.title')}</h1>
      </header>
      {connections.error && (
        <p className="error" role="alert">
          {connections.error}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error} <button onClick={() => setRefresh((v) => v + 1)}>{t('discover.reload')}</button>
        </p>
      )}
      {(busy || message) && <p role="status">{busy ? t(busy) : message}</p>}
      <details className="ai-discover">
        <summary>
          <Icon name="assistant" />
          <span className="discovery-prompt-title">{t('discover.ai.title')}</span>
          <span className="muted">
            {t('discover.ai.hint')} <span aria-hidden="true">↗</span>
          </span>
        </summary>
        <form onSubmit={discover}>
          <label>
            {t('discover.ai.formLabel')}
            <textarea
              aria-label={t('discover.ai.formLabel')}
              placeholder={t('discover.ai.placeholder')}
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
              label={t('discover.ai.connection')}
              disabled={!!busy || connections.loading || !Array.isArray(preferences?.sources)}
              onManage={onConnections}
            />
          )}
          <p className="muted">{t('discover.ai.note')}</p>
          <button className="primary" disabled={!!busy || !prompt.trim()}>
            {busy === 'discover.ai.busy' ? t(busy) : t('discover.ai.generate')}
          </button>
        </form>
        {discovery && (
          <div aria-label={t('discover.ai.previewAria')}>
            <h3>{discoveryTitle(discovery.title, t)}</h3>
            <p role="status">
              {discovery.mode === 'local'
                ? t('discover.ai.localFallback')
                : t('discover.ai.aiPicked')}{' '}
              {discovery.warning === 'no_local_matches'
                ? t('discover.ai.noMatches')
                : discovery.warning === 'ai_unavailable_local_fallback'
                  ? t('discover.ai.aiUnavailable')
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
              {...choiceActions}
              onChange={(items) => setDiscovery((current) => current && { ...current, items })}
            />
            {!discovery.items.length ? (
              <p>{t('discover.ai.empty')}</p>
            ) : (
              <>
                <label>
                  {t('discover.ai.name')}
                  <input
                    aria-label={t('discover.ai.nameAria')}
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
                    {t('discover.ai.preview')}
                  </button>
                  <button
                    disabled={!!busy || !name.trim()}
                    onClick={() =>
                      void action('discover.ai.saving', async () => {
                        const list = await saveList(
                          name,
                          discovery.items.map((i) => i.track.id),
                        );
                        setDiscovery(null);
                        onSaved(list);
                        setMessage(t('discover.ai.saved'));
                      })
                    }
                  >
                    {t('discover.ai.save')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </details>
      <div
        className="discovery-sections workspace-tabs"
        role="group"
        aria-label={t('discover.tabs.aria')}
      >
        <button aria-pressed={section === 'daily'} onClick={() => setSection('daily')}>
          {t('discover.tabs.daily')}
        </button>
        <button aria-pressed={section === 'rankings'} onClick={() => setSection('rankings')}>
          {t('discover.tabs.rankings')}
        </button>
        <button aria-pressed={section === 'external'} onClick={() => setSection('external')}>
          {t('discover.tabs.external')}
        </button>
      </div>
      <div hidden={section !== 'daily'}>
        <div className="daily-hero">
          <DailyMosaic tracks={daily?.items.slice(0, 4).map((item) => item.track) ?? []} />
          <div className="daily-hero-copy">
            <h2>{dailyDate(daily?.date, i18n.language) || t('discover.daily.fallbackTitle')}</h2>
            <p className="muted">
              {daily ? dailySummary(daily, t) : t('discover.daily.preparing')}
            </p>
          </div>
          <div className="toolbar-actions daily-hero-actions">
            <button
              className="primary"
              disabled={!daily?.items.length}
              onClick={() =>
                daily &&
                player.start(
                  daily.items.map((i) => i.track),
                  0,
                )
              }
            >
              <Icon name="play" />
              {t('discover.daily.play')}
            </button>
            <button
              className="daily-icon-action"
              aria-label={t('discover.daily.refresh')}
              title={t('discover.daily.refresh')}
              disabled={!!busy}
              onClick={() =>
                void action('discover.daily.refreshBusy', async () => {
                  setSelected(new Set());
                  setSelecting(false);
                  if (!Array.isArray(preferences?.sources)) {
                    const page = await api<{ items: Track[] }>(
                      `/tracks?limit=${draftPreferences?.count || 20}`,
                    );
                    setDaily({
                      id: 'legacy-local',
                      date: new Date().toLocaleDateString(),
                      engine: 'local',
                      items: page.items.map((track) => ({
                        track,
                        reason: t('discoverPage.reasons.localCandidate'),
                      })),
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
              <Icon name="refresh" />
            </button>
            <button
              className="daily-icon-action"
              aria-label={t('discover.daily.save')}
              title={t('discover.daily.save')}
              disabled={!!busy || !daily?.items.length}
              onClick={() =>
                void action('discover.daily.saveBusy', async () => {
                  const list = await saveList(
                    t('discover.daily.playlistName', { date: daily!.date }),
                    daily!.items.map((i) => i.track.id),
                  );
                  onSaved(list);
                  setMessage(t('discover.daily.saved'));
                })
              }
            >
              <Icon name="playlist" />
            </button>
            <button
              className="daily-icon-action"
              aria-label={t('discover.daily.select')}
              title={t('discover.daily.select')}
              aria-pressed={selecting}
              disabled={!daily?.items.length && !selecting}
              onClick={() => {
                setSelecting(!selecting);
                setSelected(new Set());
              }}
            >
              <Icon name="select" />
            </button>
          </div>
          <RecommendationSources
            items={daily?.source_status}
            warnings={daily?.warnings}
            degraded={daily?.degraded}
          />
        </div>
        {daily && (
          <Choices
            items={daily.items}
            player={player}
            favorites={favorites}
            feedback={feedback}
            {...choiceActions}
            selected={selected}
            onSelect={selecting ? selectTrack : undefined}
          />
        )}
        {selecting && (
          <div className="daily-selection" role="group" aria-label={t('discover.daily.selectAria')}>
            <strong>{t('discover.daily.selected', { count: chosen.length })}</strong>
            <div className="toolbar-actions">
              <button
                onClick={() =>
                  setSelected(
                    new Set(
                      chosen.length === daily?.items.length
                        ? []
                        : daily?.items.map(({ track }) => track.id),
                    ),
                  )
                }
              >
                {chosen.length === daily?.items.length
                  ? t('discover.daily.clearAll')
                  : t('discover.daily.selectAll')}
              </button>
              <button disabled={!chosen.length} onClick={() => queueSelection(true)}>
                {t('discover.daily.playNextSelected')}
              </button>
              <button disabled={!chosen.length} onClick={() => queueSelection()}>
                {t('discover.daily.addQueue')}
              </button>
              <button disabled={!chosen.length} onClick={() => setPlaylistTracks(chosen)}>
                {t('discover.daily.addPlaylist')}
              </button>
              <button
                className="text-button"
                onClick={() => {
                  setSelecting(false);
                  setSelected(new Set());
                }}
              >
                {t('discover.daily.done')}
              </button>
            </div>
          </div>
        )}
      </div>
      {playlistTracks && (
        <RecommendationPlaylistDialog
          tracks={playlistTracks}
          playlists={playlists}
          onClose={() => setPlaylistTracks(null)}
          onSaved={(list) => {
            onSaved(list);
            setMessage(t('discover.daily.playlistSaved', { name: list.name }));
            setSelected(new Set());
            setSelecting(false);
          }}
        />
      )}
      {lyricTrack && (
        <RecommendationLyricsDialog
          key={lyricTrack.id}
          track={lyricTrack}
          onClose={() => setLyricTrack(null)}
        />
      )}
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
            void action('discover.messages.savingPreferences', async () => {
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
              setMessage(t('discover.messages.preferenceSaved'));
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
  const { t } = useTranslation();
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
      setMessage(e instanceof Error ? e.message : t('discoverPage.devices.incomplete'));
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
        if (!controller.signal.aborted) setMessage(t('discoverPage.devices.readFailed'));
      });
    return () => controller.abort();
  }, [t]);
  return (
    <section className="completion-page" aria-label={t('discoverPage.devices.ariaLabel')}>
      <h1>{t('discoverPage.devices.title')}</h1>
      <p className="muted">{t('discoverPage.devices.description')}</p>
      <SyncModeControl userId={user.id} />
      <div className="management-card">
        <h2>{t('discoverPage.devices.sharedTitle')}</h2>
        <p>
          {snapshot?.track_ids.length
            ? t('discoverPage.devices.progressSummary', {
                count: snapshot.track_ids.length,
                index: snapshot.index + 1,
                time: time(snapshot.position_ms / 1000),
                mode: t(`discoverPage.devices.modes.${snapshot.mode}`, {
                  defaultValue: modeNames[snapshot.mode],
                }),
              })
            : t('discoverPage.devices.noSharedProgress')}
        </p>
        <p className="muted">
          {snapshot?.updated_at
            ? t('discoverPage.devices.updatedAt', {
                time: new Date(snapshot.updated_at).toLocaleString(),
              })
            : ''}
        </p>
        <div className="toolbar-actions">
          <button
            disabled={!!busy}
            onClick={() =>
              void run(t('discoverPage.devices.reading'), async () =>
                setSnapshot(await api<SharedPlayback>('/playback/state')),
              )
            }
          >
            {t('discoverPage.devices.readLatest')}
          </button>
          <button
            disabled={!!busy || !snapshot || !player.current}
            onClick={() =>
              void run(t('discoverPage.devices.sharing'), async () => {
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
                setMessage(t('discoverPage.devices.shareSuccess'));
              })
            }
          >
            {t('discoverPage.devices.shareCurrent')}
          </button>
          <button
            className="primary"
            disabled={!!busy || !snapshot?.track_ids.length}
            onClick={() =>
              void run(t('discoverPage.devices.preparing'), async () => {
                const state = snapshot!;
                if (state.track_ids.length > QUEUE_LIMIT)
                  throw new Error(t('discoverPage.devices.queueExceeded', { limit: QUEUE_LIMIT }));
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
                setMessage(t('discoverPage.devices.loaded'));
              })
            }
          >
            {t('discoverPage.devices.continueHere')}
          </button>
        </div>
      </div>
      <p role="status">{busy || message}</p>
    </section>
  );
}
