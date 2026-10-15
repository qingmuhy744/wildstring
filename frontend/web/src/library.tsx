import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  listeningTime,
  time,
  type Album,
  type AlbumPage,
  type Artist,
  type ArtistPage,
  type ListeningSummary,
  type Playlist,
  type PlaylistPage,
  type Track,
  type TrackPage,
  type User,
} from './api';
import { Brand } from './brand';
import { Cover } from './cover';
import { useFavorites } from './favorites';
import { useLibraryMotto } from './library-mottos';
import { NowPlaying } from './now-playing';
import { PlayerBar, usePlayer } from './player';
import { PlaylistEditor } from './playlist-editor';
import { QueuePanel } from './queue-panel';
import { Management } from './management';
import { MetadataEditor } from './metadata-editor';
import { AccountDialog } from './accounts';
import { ThemeControl } from './theme';
import { Pagination, TrackList } from './track-list';
import type { TrackOperations } from './track-actions';

type View = 'tracks' | 'albums' | 'artists' | 'playlists' | 'favorites' | 'listening';
type Result =
  | { kind: 'tracks'; page: TrackPage }
  | { kind: 'albums'; page: AlbumPage }
  | { kind: 'artists'; page: ArtistPage }
  | { kind: 'playlists'; page: PlaylistPage };
const labels: Record<View, string> = {
  tracks: '全部歌曲',
  albums: '专辑',
  artists: '艺人',
  playlists: '歌单',
  favorites: '♥ 我喜欢',
  listening: '收听记录',
};
const icons: Record<View, string> = {
  tracks: '▤',
  albums: '▣',
  artists: '◉',
  playlists: '♫',
  favorites: '♡',
  listening: '◷',
};

export function Library({ onLogout, user }: { onLogout: () => Promise<void>; user: User }) {
  const isAdmin = user.role === 'admin';
  const [accountOpen, setAccountOpen] = useState(false);
  const [view, setView] = useState<View>('tracks');
  const [manageOpen, setManageOpen] = useState(false);
  const [editingTrack, setEditingTrack] = useState<Track | null>(null);
  useEffect(() => {
    if (manageOpen) window.scrollTo({ top: 0 });
  }, [manageOpen]);
  const refreshLibrary = useCallback(() => setRevision((value) => value + 1), []);
  const [album, setAlbum] = useState<Album | null>(null);
  const [selectedArtist, setSelectedArtist] = useState<Artist | null>(null);
  const [artistView, setArtistView] = useState<'tracks' | 'albums'>('tracks');
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [catalog, setCatalog] = useState<Playlist[]>([]);
  const [collectionsLoading, setCollectionsLoading] = useState(true);
  const [collectionRevision, setCollectionRevision] = useState(0);
  const [stats, setStats] = useState<ListeningSummary | null>(null);
  const [statsSort, setStatsSort] = useState('last_played_at');
  const [listeningRevision, setListeningRevision] = useState(0);
  const [draft, setDraft] = useState(''),
    [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [queueOpen, setQueueOpen] = useState(false),
    [lyricsOpen, setLyricsOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [counts, setCounts] = useState<Partial<Record<View, number>>>({});
  const [editor, setEditor] = useState<{ initial: Playlist | null; track: Track | null } | null>(
    null,
  );
  const [bulkTarget, setBulkTarget] = useState(''),
    [bulkBusy, setBulkBusy] = useState(false);
  const closePlayer = useCallback(() => setLyricsOpen(false), []);
  const player = usePlayer(),
    motto = useLibraryMotto(),
    favorites = useFavorites(revision, setNotice);
  const favoritesPlaylist = catalog.find((item) => item.kind === 'favorites');
  const activePlaylist = view === 'favorites' ? favoritesPlaylist : playlist;
  const artistGrid = view === 'artists' && !selectedArtist;
  const albumGrid =
    !artistGrid && !activePlaylist && (selectedArtist ? artistView : view) === 'albums' && !album;
  const playlistGrid = view === 'playlists' && !playlist;
  const kind = artistGrid
    ? 'artists'
    : albumGrid
      ? 'albums'
      : playlistGrid
        ? 'playlists'
        : 'tracks';
  const visible = result?.kind === kind ? result.page : null;
  const page = kind === 'tracks' ? (visible as TrackPage | null) : null;
  const unit =
    kind === 'artists' ? '位' : kind === 'albums' ? '张' : kind === 'playlists' ? '个' : '首';
  const lastQuery = useRef('');
  const collectionsMetrics = view === 'playlists' || view === 'favorites' ? listeningRevision : 0;
  const liveRules = activePlaylist?.kind === 'smart' || activePlaylist?.kind === 'favorites';

  useEffect(() => {
    const controller = new AbortController();
    setCollectionsLoading(true);
    async function load() {
      const lists: Playlist[] = [];
      let cursor = 0;
      while (!controller.signal.aborted) {
        const response = await api<PlaylistPage>(`/playlists?limit=100&offset=${cursor}`, {
          signal: controller.signal,
        });
        lists.push(...response.items);
        cursor += response.items.length;
        if (cursor >= response.total || !response.items.length) break;
      }
      if (!controller.signal.aborted) {
        setCatalog(lists);
        setPlaylist((current) =>
          current ? lists.find((item) => item.id === current.id) || current : null,
        );
      }
    }
    void load()
      .catch(() => {
        if (!controller.signal.aborted) setNotice('歌单暂时无法读取，请刷新重试。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setCollectionsLoading(false);
      });
    return () => controller.abort();
  }, [revision, collectionRevision, favorites.change, collectionsMetrics]);

  useEffect(() => {
    const changed = () => setListeningRevision((value) => value + 1);
    window.addEventListener('wildstring:listening-updated', changed);
    return () => window.removeEventListener('wildstring:listening-updated', changed);
  }, []);
  const metricsRevision = view === 'listening' || liveRules || playlistGrid ? listeningRevision : 0;
  useEffect(() => {
    if (view !== 'listening') return;
    const controller = new AbortController();
    api<ListeningSummary>('/listening/summary', { signal: controller.signal })
      .then(setStats)
      .catch(() => {
        if (!controller.signal.aborted) setNotice('暂时无法读取收听记录。');
      });
    return () => controller.abort();
  }, [view, revision, listeningRevision, favorites.change]);

  useEffect(() => {
    if (view === 'favorites' && !activePlaylist) {
      setLoading(collectionsLoading);
      if (!collectionsLoading) setError('暂时无法读取我喜欢歌单，请刷新重试。');
      return;
    }
    const controller = new AbortController();
    setError('');
    const parameters = new URLSearchParams({
      q: album ? '' : query,
      limit: album ? '200' : '50',
      offset: String(offset),
    });
    let path = '/tracks';
    if (activePlaylist) path = `/playlists/${activePlaylist.id}/tracks`;
    else if (playlistGrid) path = '/playlists';
    else if (artistGrid) path = '/artists';
    else if (selectedArtist) {
      path = `/artists/${selectedArtist.id}/${albumGrid ? 'albums' : 'tracks'}`;
      if (album) parameters.set('album_id', album.id);
    } else if (album) path = `/albums/${album.id}/tracks`;
    else if (albumGrid) path = '/albums';
    if (view === 'listening') {
      parameters.set('played_only', 'true');
      parameters.set('sort', statsSort);
    }
    const queryKey = `${revision}|${path}?${parameters}`;
    if (lastQuery.current !== queryKey) {
      setLoading(true);
      lastQuery.current = queryKey;
    }
    api<TrackPage | AlbumPage | ArtistPage | PlaylistPage>(`${path}?${parameters}`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (controller.signal.aborted) return;
        if (response.total > 0 && offset >= response.total) {
          setOffset(Math.floor((response.total - 1) / response.limit) * response.limit);
          return;
        }
        setResult({ kind, page: response } as Result);
        if (!query && !album && !selectedArtist && !activePlaylist)
          setCounts((current) => ({ ...current, [view]: response.total }));
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof ApiError ? reason.message : '无法连接音乐服务，请检查连接。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    query,
    offset,
    revision,
    view,
    album?.id,
    selectedArtist?.id,
    artistView,
    activePlaylist?.id,
    activePlaylist?.version,
    view === 'favorites' && !activePlaylist ? collectionsLoading : false,
    playlistGrid ? collectionRevision : 0,
    statsSort,
    metricsRevision,
    liveRules ? favorites.change : 0,
  ]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);
  function clearSearch() {
    setDraft('');
    setQuery('');
    setOffset(0);
  }
  function switchView(target: View) {
    setManageOpen(false);
    setView(target);
    setAlbum(null);
    setSelectedArtist(null);
    setPlaylist(null);
    clearSearch();
  }
  function switchTab(target: 'tracks' | 'albums') {
    if (selectedArtist) {
      setArtistView(target);
      setAlbum(null);
      clearSearch();
    } else switchView(target);
  }
  function openArtist(item: Artist) {
    setSelectedArtist(item);
    setArtistView('tracks');
    setAlbum(null);
    clearSearch();
  }
  function openPlaylist(item: Playlist) {
    setView(item.kind === 'favorites' ? 'favorites' : 'playlists');
    setPlaylist(item.kind === 'favorites' ? null : item);
    setSelectedArtist(null);
    setAlbum(null);
    clearSearch();
  }
  function search(event: FormEvent) {
    event.preventDefault();
    setAlbum(null);
    setOffset(0);
    setQuery(draft.trim());
    setRevision((value) => value + 1);
  }
  function logout() {
    void onLogout().catch(() => setError('退出失败，请重试。'));
  }
  function updateList(list: Playlist) {
    setPlaylist((current) => (current?.id === list.id ? list : current));
    setCatalog((current) => current.map((item) => (item.id === list.id ? list : item)));
    setCollectionRevision((value) => value + 1);
  }
  async function addToPlaylist(track: Track, list: Playlist) {
    try {
      const updated = await api<Playlist>(`/playlists/${list.id}/tracks`, {
        method: 'POST',
        body: JSON.stringify({ version: list.version, track_ids: [track.id] }),
      });
      updateList(updated);
      setNotice(`已加入：${list.name}`);
    } catch (reason) {
      setNotice(reason instanceof ApiError ? reason.message : '歌曲未加入歌单，请重试。');
      setCollectionRevision((value) => value + 1);
    }
  }
  async function editPlaylistTrack(track: Track, direction?: -1 | 1) {
    if (!activePlaylist) return;
    try {
      const updated = await api<Playlist>(
        direction
          ? `/playlists/${activePlaylist.id}/move`
          : `/playlists/${activePlaylist.id}/tracks/${track.id}?version=${activePlaylist.version}`,
        {
          method: direction ? 'POST' : 'DELETE',
          ...(direction
            ? {
                body: JSON.stringify({
                  version: activePlaylist.version,
                  track_id: track.id,
                  direction,
                }),
              }
            : {}),
        },
      );
      updateList(updated);
      setNotice(direction ? '已调整歌单顺序' : '已从歌单移除');
    } catch (reason) {
      setNotice(reason instanceof ApiError ? reason.message : '歌单未修改，请重试。');
      setCollectionRevision((value) => value + 1);
    }
  }
  const operations: TrackOperations = {
    favorites,
    playlists: catalog.filter((item) => item.kind === 'manual'),
    onAdd: addToPlaylist,
    onCreate: (track) => setEditor({ initial: null, track }),
    onEdit: isAdmin ? setEditingTrack : undefined,
    ...(activePlaylist?.kind === 'manual'
      ? {
          onRemove: (track: Track) => void editPlaylistTrack(track),
          onMove: (track: Track, direction: -1 | 1) => void editPlaylistTrack(track, direction),
        }
      : {}),
  };
  async function saveEditor(list: Playlist) {
    let selected = list;
    if (editor?.track && list.kind === 'manual') {
      try {
        selected = await api<Playlist>(`/playlists/${list.id}/tracks`, {
          method: 'POST',
          body: JSON.stringify({ version: list.version, track_ids: [editor.track.id] }),
        });
      } catch {
        setNotice('歌单已建立，歌曲未加入；可从歌曲操作重试。');
      }
    }
    setEditor(null);
    setCollectionRevision((value) => value + 1);
    openPlaylist(selected);
  }
  async function deletePlaylist() {
    if (!activePlaylist || !confirm(`删除歌单“${activePlaylist.name}”？歌曲文件会保留。`)) return;
    try {
      await api(`/playlists/${activePlaylist.id}?version=${activePlaylist.version}`, {
        method: 'DELETE',
      });
      switchView('playlists');
      setCollectionRevision((value) => value + 1);
    } catch (reason) {
      setNotice(reason instanceof ApiError ? reason.message : '歌单未删除，请重试。');
    }
  }
  async function bulkAdd() {
    const list = catalog.find((item) => item.id === bulkTarget);
    if (!list || !page) return;
    setBulkBusy(true);
    try {
      const updated = await api<Playlist>(`/playlists/${list.id}/tracks`, {
        method: 'POST',
        body: JSON.stringify({
          version: list.version,
          track_ids: page.items.map((item) => item.id),
        }),
      });
      updateList(updated);
      setNotice(`本页歌曲已加入：${list.name}`);
      setBulkTarget('');
    } catch (reason) {
      setNotice(reason instanceof ApiError ? reason.message : '歌曲未加入歌单。');
    } finally {
      setBulkBusy(false);
    }
  }
  const title =
    album?.title ||
    activePlaylist?.name ||
    selectedArtist?.name ||
    (query
      ? '找到喜欢的声音。'
      : artistGrid
        ? '一群熟悉的名字。'
        : albumGrid
          ? '一张专辑，一段时光。'
          : playlistGrid
            ? '自己的歌，自己的顺序。'
            : view === 'listening'
              ? '那些反复响起的。'
              : '收藏的声音。');
  const subtitle = album
    ? `${selectedArtist?.name || album.artists.join(' / ') || '未知艺人'} · ${time(album.duration_ms / 1000)}`
    : selectedArtist
      ? `${selectedArtist.album_count} 张专辑 · ${selectedArtist.track_count} 首歌曲 · ${time(selectedArtist.duration_ms / 1000)}`
      : activePlaylist
        ? `${activePlaylist.track_count} 首歌曲 · ${time(activePlaylist.duration_ms / 1000)}`
        : query
          ? `“${query}” 的搜索结果`
          : artistGrid
            ? '从一个名字，听到一段时光。'
            : albumGrid
              ? '按专辑，重新听一遍收藏。'
              : playlistGrid
                ? '亲手挑选，或让规则找到下一段旋律。'
                : view === 'listening'
                  ? '每一次认真听过，都有回响。'
                  : motto;
  const headingCover =
    album?.cover_track_id || selectedArtist?.cover_track_id || activePlaylist?.cover_track_id;
  return (
    <>
      <div className="app-shell" inert={lyricsOpen} aria-hidden={lyricsOpen || undefined}>
        <aside className="sidebar">
          <Brand />
          <p className="sidebar-label">你的音乐空间</p>
          {(Object.keys(labels) as View[]).map((target) => (
            <button
              key={target}
              className={`nav-button ${view === target && !manageOpen ? 'nav-current' : ''}`}
              onClick={() => switchView(target)}
            >
              <span aria-hidden="true">{icons[target]}</span>
              {labels[target]}
              {target === 'favorites' ? (
                <small>{favorites.ids.size}</small>
              ) : counts[target] !== undefined ? (
                <small>{counts[target]}</small>
              ) : null}
            </button>
          ))}
          <button
            className={`nav-button ${queueOpen ? 'selected' : ''}`}
            onClick={() => {
              setQueueOpen(!queueOpen);
              setLyricsOpen(false);
            }}
            aria-expanded={queueOpen}
          >
            <span>☷</span>播放队列 <small>{player.queue.length}</small>
          </button>
          <div className="sidebar-bottom">
            {isAdmin && (
              <button
                className={`nav-button manage-entry ${manageOpen ? 'nav-current' : ''}`}
                onClick={() => {
                  setManageOpen(true);
                  setQueueOpen(false);
                }}
              >
                <span aria-hidden="true">⚙</span>管理
              </button>
            )}
            <button className="nav-button account-entry" onClick={() => setAccountOpen(true)}>
              <span aria-hidden="true">◉</span>账号设置
            </button>
            <ThemeControl />
            <span className="local-dot" /> 私人曲库 · 原音直放
            <p>
              音乐不设限，
              <br />
              自由有回响。
            </p>
            <button className="text-button" onClick={logout}>
              退出登录 ↗
            </button>
          </div>
        </aside>
        {manageOpen && (
          <Management
            revision={revision}
            onBack={() => setManageOpen(false)}
            onEdit={setEditingTrack}
            onChanged={refreshLibrary}
          />
        )}
        <main className="library" hidden={manageOpen}>
          <header className="topbar">
            <div>
              <span className="eyebrow">YOUR OWN COLLECTION</span>
              <span className="mobile-brand">野弦 / WILDSTRING</span>
              <button className="mobile-logout text-button" onClick={logout}>
                退出登录
              </button>
            </div>
            <select
              className="mobile-section"
              aria-label="浏览方式"
              value={view}
              onChange={(event) =>
                event.target.value === 'manage'
                  ? setManageOpen(true)
                  : event.target.value === 'account'
                    ? setAccountOpen(true)
                    : switchView(event.target.value as View)
              }
            >
              {(Object.keys(labels) as View[]).map((target) => (
                <option key={target} value={target}>
                  {labels[target]}
                </option>
              ))}
              {isAdmin && <option value="manage">管理</option>}
              <option value="account">账号设置</option>
            </select>
            <form className="search" onSubmit={search} role="search" autoComplete="off">
              <label className="sr-only" htmlFor="search">
                搜索曲库
              </label>
              <span aria-hidden="true">⌕</span>
              <input
                id="search"
                type="search"
                name="wildstring-library-query"
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  artistGrid
                    ? '搜索艺人、乐队'
                    : playlistGrid
                      ? '搜索歌单'
                      : selectedArtist
                        ? `搜索 ${selectedArtist.name} 的歌曲、专辑`
                        : '搜索歌曲、艺人、专辑'
                }
                maxLength={256}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <button type="submit" aria-label="搜索">
                ↵
              </button>
            </form>
          </header>
          <section
            className={`collection-heading ${album || selectedArtist ? 'album-heading' : ''}`}
          >
            <div>
              {(album || selectedArtist || playlist) && (
                <button
                  className="back-button text-button"
                  onClick={() => {
                    if (album) {
                      setAlbum(null);
                      setOffset(0);
                    } else if (selectedArtist) switchView('artists');
                    else switchView('playlists');
                  }}
                >
                  ←{' '}
                  {album
                    ? selectedArtist
                      ? `返回 ${selectedArtist.name}`
                      : '返回专辑'
                    : selectedArtist
                      ? '返回艺人'
                      : '返回歌单'}
                </button>
              )}
              <p className="eyebrow">
                LIBRARY /{' '}
                {album
                  ? 'ALBUM'
                  : selectedArtist
                    ? 'ARTIST'
                    : activePlaylist
                      ? activePlaylist.kind === 'smart'
                        ? 'SMART PLAYLIST'
                        : 'PLAYLIST'
                      : query
                        ? 'SEARCH'
                        : view.toUpperCase()}
              </p>
              <h1>{title}</h1>
              <p className="muted">{subtitle}</p>
            </div>
            {headingCover && (
              <Cover
                key={`${headingCover}-${revision}`}
                trackId={headingCover}
                title={title}
                size={320}
                className={`album-heading-cover ${selectedArtist && !album ? 'artist-portrait' : ''}`}
              />
            )}
            <div className="collection-stat">
              <strong>{visible?.total ?? '—'}</strong>
              <span>
                {kind === 'artists'
                  ? '位曲库艺人'
                  : kind === 'playlists'
                    ? '个歌单'
                    : kind === 'albums'
                      ? '张专辑'
                      : '首歌曲'}
              </span>
            </div>
          </section>
          {view === 'listening' && (
            <div className="listening-summary" aria-label="收听统计">
              <div>
                <strong>{stats?.play_count ?? 0}</strong>
                <span title="累计听过半首或 4 分钟计一次；同一次播放只计一次">播放次数</span>
              </div>
              <div>
                <strong>{listeningTime(stats?.listened_ms || 0)}</strong>
                <span>累计收听</span>
              </div>
              <div>
                <strong>{stats?.tracks_played ?? 0}</strong>
                <span>听过的歌曲</span>
              </div>
              <div>
                <strong>{stats?.favorites ?? 0}</strong>
                <span>喜欢的歌曲</span>
              </div>
            </div>
          )}
          <div className="library-toolbar">
            <div className="toolbar-actions">
              <div className="view-switch" role="group" aria-label="曲库显示方式">
                <button
                  aria-pressed={
                    !artistGrid &&
                    !playlistGrid &&
                    !albumGrid &&
                    (view === 'tracks' || !!selectedArtist)
                  }
                  onClick={() => switchTab('tracks')}
                >
                  歌曲
                </button>
                <button aria-pressed={albumGrid || !!album} onClick={() => switchTab('albums')}>
                  专辑
                </button>
                <button aria-pressed={artistGrid} onClick={() => switchView('artists')}>
                  艺人
                </button>
                <button
                  aria-pressed={view === 'playlists' || view === 'favorites'}
                  onClick={() => switchView('playlists')}
                >
                  歌单
                </button>
              </div>
              {kind === 'tracks' && (
                <button
                  className="primary"
                  disabled={loading || !!error || !page?.items.length}
                  onClick={() => page && player.start(page.items, 0)}
                >
                  <span aria-hidden="true">▶ </span>
                  {page && page.total > page.items.length
                    ? '播放本页'
                    : album
                      ? '播放专辑'
                      : selectedArtist
                        ? '播放艺人'
                        : activePlaylist
                          ? '播放歌单'
                          : '播放全部'}
                </button>
              )}
              {(playlistGrid || view === 'favorites') && (
                <button
                  className="primary"
                  onClick={() => setEditor({ initial: null, track: null })}
                >
                  ＋ 新建歌单
                </button>
              )}
              {activePlaylist && activePlaylist.kind !== 'favorites' && (
                <>
                  <button onClick={() => setEditor({ initial: activePlaylist, track: null })}>
                    编辑歌单
                  </button>
                  <button className="text-button" onClick={() => void deletePlaylist()}>
                    删除歌单
                  </button>
                </>
              )}
              {view === 'listening' && (
                <select
                  aria-label="收听排序"
                  value={statsSort}
                  onChange={(event) => {
                    setStatsSort(event.target.value);
                    setOffset(0);
                  }}
                >
                  <option value="last_played_at">最近听过</option>
                  <option value="play_count">经常播放</option>
                  <option value="listened_ms">收听最久</option>
                </select>
              )}
              {query && !album && (
                <button className="text-button" onClick={clearSearch}>
                  清除搜索
                </button>
              )}
            </div>
            <button
              className="text-button"
              onClick={() => setRevision((value) => value + 1)}
              disabled={loading}
            >
              {loading ? '读取中…' : '刷新曲库 ↻'}
            </button>
          </div>
          {page &&
            page.items.length > 0 &&
            operations.playlists.length > 0 &&
            !loading &&
            !error && (
              <div className="bulk-playlist">
                <label>
                  <span>把这一页留进歌单</span>
                  <select
                    aria-label="本页加入歌单"
                    value={bulkTarget}
                    onChange={(event) => setBulkTarget(event.target.value)}
                  >
                    <option value="">选择普通歌单…</option>
                    {operations.playlists.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button disabled={!bulkTarget || bulkBusy} onClick={() => void bulkAdd()}>
                  {bulkBusy ? '加入中…' : '加入本页'}
                </button>
              </div>
            )}
          {error ? (
            <div className="empty" role="alert">
              <h2>暂时无法读取曲库</h2>
              <p>{error}</p>
              <button onClick={() => setRevision((value) => value + 1)}>重新连接</button>
            </div>
          ) : loading ? (
            <div className="empty" role="status">
              正在读取你的音乐…
            </div>
          ) : !visible?.items.length ? (
            <div className="empty">
              <span className="empty-symbol">≋</span>
              <h2>
                {query
                  ? `没有找到匹配的${kind === 'artists' ? '艺人' : kind === 'albums' ? '专辑' : kind === 'playlists' ? '歌单' : '歌曲'}`
                  : activePlaylist?.kind === 'favorites'
                    ? '喜欢的歌，留在这里。'
                    : activePlaylist?.kind === 'smart'
                      ? '还没有符合规则的歌'
                      : activePlaylist
                        ? '给这张歌单，选一首开场。'
                        : view === 'listening'
                          ? '从一首喜欢的歌开始。'
                          : artistGrid
                            ? '还没有艺人信息'
                            : '曲库还很安静'}
              </h2>
              <p>
                {query
                  ? '试试其他关键词。'
                  : activePlaylist?.kind === 'favorites'
                    ? '点击歌曲旁的心形，收藏就会出现在这里。'
                    : activePlaylist?.kind === 'smart'
                      ? '可以编辑规则，换一种方式找歌。'
                      : activePlaylist
                        ? '从歌曲的更多操作加入，或将一页歌曲一起加入。'
                        : view === 'listening'
                          ? '听过的歌曲、次数和时长会留在这里。'
                          : '导入音乐后，刷新曲库。'}
              </p>
            </div>
          ) : (
            <>
              {kind === 'artists' ? (
                <div className="artist-grid" aria-label="艺人列表">
                  {(visible as ArtistPage).items.map((item) => (
                    <button
                      className="artist-card"
                      key={item.id}
                      aria-label={`查看艺人 ${item.name}`}
                      onClick={() => openArtist(item)}
                    >
                      <Cover trackId={item.cover_track_id} title={item.name} size={320} />
                      <strong>{item.name}</strong>
                      <small>
                        {item.album_count} 张专辑 · {item.track_count} 首歌曲
                      </small>
                    </button>
                  ))}
                </div>
              ) : kind === 'playlists' ? (
                <div className="playlist-grid" aria-label="歌单列表">
                  {(visible as PlaylistPage).items.map((item) => (
                    <button
                      className={`playlist-card ${item.kind}`}
                      key={item.id}
                      aria-label={`打开歌单 ${item.name}`}
                      onClick={() => openPlaylist(item)}
                    >
                      {item.kind === 'favorites' ? (
                        <span className="playlist-art favorites-art" aria-hidden="true">
                          ♥
                        </span>
                      ) : item.cover_track_id ? (
                        <Cover trackId={item.cover_track_id} title={item.name} size={320} />
                      ) : (
                        <span className="playlist-art" aria-hidden="true">
                          {item.kind === 'smart' ? '✦' : '♫'}
                        </span>
                      )}
                      <strong>{item.name}</strong>
                      <span>
                        {item.kind === 'favorites'
                          ? '喜欢的声音'
                          : item.kind === 'smart'
                            ? '规则歌单'
                            : '普通歌单'}{' '}
                        · {item.track_count} 首
                      </span>
                    </button>
                  ))}
                </div>
              ) : kind === 'albums' ? (
                <div className="album-grid" aria-label="专辑列表">
                  {(visible as AlbumPage).items.map((item) => (
                    <button
                      className="album-card"
                      key={item.id}
                      aria-label={`打开专辑 ${item.title}`}
                      onClick={() => {
                        setAlbum(item);
                        setOffset(0);
                      }}
                    >
                      <Cover
                        key={`${item.id}-${revision}`}
                        trackId={item.cover_track_id}
                        title={item.title}
                        size={320}
                      />
                      <strong>{item.title}</strong>
                      <span>{item.artists.join(' / ') || '未知艺人'}</span>
                      <small>
                        {item.track_count} 首 · {time(item.duration_ms / 1000)}
                      </small>
                    </button>
                  ))}
                </div>
              ) : (
                page && (
                  <TrackList
                    page={page}
                    player={player}
                    onNotice={setNotice}
                    revision={revision}
                    operations={operations}
                    showStats={view === 'listening'}
                  />
                )
              )}
              <Pagination page={visible} onOffset={setOffset} unit={unit} />
            </>
          )}
        </main>
        {queueOpen && (
          <QueuePanel player={player} onClose={() => setQueueOpen(false)} onNotice={setNotice} />
        )}
        <PlayerBar
          player={player}
          queueOpen={queueOpen}
          onQueue={() => {
            setQueueOpen(!queueOpen);
            setLyricsOpen(false);
          }}
          onLyrics={() => {
            setLyricsOpen(!lyricsOpen);
            setQueueOpen(false);
          }}
          lyricsOpen={lyricsOpen}
          favorites={favorites}
        />
        {notice && (
          <p className="toast" role="status">
            {notice}
          </p>
        )}
      </div>
      {lyricsOpen && <NowPlaying player={player} onClose={closePlayer} favorites={favorites} />}
      {editor && (
        <PlaylistEditor
          key={editor.initial?.id || 'new'}
          initial={editor.initial}
          onClose={() => setEditor(null)}
          onSaved={saveEditor}
        />
      )}
      {accountOpen && <AccountDialog user={user} onClose={() => setAccountOpen(false)} />}
      {editingTrack && (
        <MetadataEditor
          track={editingTrack}
          player={player}
          onClose={() => setEditingTrack(null)}
          onSaved={async (id) => {
            const updated = await api<Track>(`/tracks/${id}`);
            player.refreshTrack(updated);
            setAlbum(null);
            setSelectedArtist(null);
            refreshLibrary();
            setNotice('歌曲信息已保存');
          }}
        />
      )}
    </>
  );
}
