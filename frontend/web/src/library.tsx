import { CatalogSortControl, useCatalogSorting } from './catalog-sort';
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type SetStateAction,
} from 'react';
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
import { AccountAvatar } from './avatar';
import { Cover } from './cover';
import { useFavorites } from './favorites';
import { useLibraryMotto } from './library-mottos';
import { NowPlaying } from './now-playing';
import { PlayerBar, usePlayer } from './player';
import { PlaylistEditor } from './playlist-editor';
import { PlaylistMenu } from './playlist-menu';
import { PlaybackSync } from './playback-sync';
import { QueuePanel } from './queue-panel';
import { Management } from './management';
import { MetadataEditor } from './metadata-editor';
import { MetadataRefreshDialog, type RefreshTarget } from './metadata-refresh';
import { LyricScanDialog } from './lyric-scans';
import { AccountDialog } from './accounts';
import { ThemeControl } from './theme';
import { TrackList } from './track-list';
import {
  AlphabetRail,
  useContinuousBrowse,
  type BrowseIndex,
  type BrowsePage,
} from './continuous-browse';
import { Icon } from './icons';
import type { TrackOperations } from './track-actions';
import { Discover, Devices } from './discover';
import { OfflinePanel } from './offline-panel';
import { Notifications, useNotifications } from './notifications';
import type { NotificationAction } from './agent-api';
import './workspace.css';
import { followPlaylist, followedPlaylists, useOfflinePlaylistSync } from './offline-playlists';
import { collectTracks } from './playback-state';
import { saveDownloads, usingOfflineAccess } from './offline';

const Assistant = lazy(() =>
  import('./assistant').then((module) => ({ default: module.Assistant })),
);
const AgentTasks = lazy(() =>
  import('./agent-workbench').then((module) => ({ default: module.AgentTasks })),
);
const Drafts = lazy(() =>
  import('./agent-workbench').then((module) => ({ default: module.Drafts })),
);
const AssistantSettings = lazy(() =>
  import('./assistant-settings').then((module) => ({ default: module.AssistantSettings })),
);

type View =
  | 'tracks'
  | 'albums'
  | 'artists'
  | 'playlists'
  | 'favorites'
  | 'listening'
  | 'discover'
  | 'offline'
  | 'devices'
  | 'assistant'
  | 'drafts'
  | 'tasks'
  | 'notifications'
  | 'assistant-settings';
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
  discover: '每日推荐 · AI',
  offline: '离线音乐',
  devices: '跨设备继续',
  assistant: '音乐助手',
  drafts: '待确认草案',
  tasks: '巡检与任务',
  notifications: '通知中心',
  'assistant-settings': '助手设置',
};
const icons: Record<View, string> = {
  tracks: '▤',
  albums: '▣',
  artists: '◉',
  playlists: '♫',
  favorites: '♡',
  listening: '◷',
  discover: '✦',
  offline: '↓',
  devices: '⇄',
  assistant: '✧',
  drafts: '▧',
  tasks: '◎',
  notifications: '♧',
  'assistant-settings': '⚙',
};

type CatalogLocation = {
  view: View;
  album: Album | null;
  selectedArtist: Artist | null;
  artistRole: string;
  artistView: 'tracks' | 'albums';
  playlist: Playlist | null;
  query: string;
  draft: string;
  scroll: number;
  playerOpen: boolean;
  queueOpen: boolean;
};

export function Library({ onLogout, user }: { onLogout: () => Promise<void>; user: User }) {
  const profile = user.profile || (user.role === 'admin' ? 'owner' : 'listener');
  const canManage = profile !== 'listener';
  const canImport = profile === 'owner' || profile === 'librarian';
  const [accountOpen, setAccountOpen] = useState(false);
  const [connectionSettingsRevision, setConnectionSettingsRevision] = useState(0);
  function openModelConnections() {
    setConnectionSettingsRevision((value) => value + 1);
    switchView('assistant-settings');
  }
  const [view, setView] = useState<View>(
    navigator.onLine && !usingOfflineAccess() ? 'tracks' : 'offline',
  );
  const specialView = [
    'discover',
    'offline',
    'devices',
    'assistant',
    'drafts',
    'tasks',
    'notifications',
    'assistant-settings',
  ].includes(view);
  const inbox = useNotifications(user.id);
  const [selectedAgentItem, setSelectedAgentItem] = useState<{
    kind: 'drafts' | 'tasks';
    id: string;
  } | null>(null);
  const [managementAction, setManagementAction] = useState<{
    type: 'metadata-center';
    batchId?: string;
  } | null>(null);
  function openAgentItem(kind: 'drafts' | 'tasks', id: string) {
    setSelectedAgentItem({ kind, id });
    switchView(kind);
  }
  function openNotificationAction(action: NotificationAction) {
    const id = action.params?.id;
    if (action.target === 'draft' && id) return openAgentItem('drafts', id);
    if (action.target === 'task' && id) return openAgentItem('tasks', id);
    if (action.target === 'metadata-center' || action.target === 'metadata-review') {
      setManagementAction({ type: 'metadata-center', batchId: action.params?.batch_id });
      setManageOpen(true);
      return;
    }
    if (action.target === 'lyric-scan') {
      setLyricScanBatch(action.params?.batch_id || null);
    }
  }
  const [collectionBusy, setCollectionBusy] = useState(false);
  const collectionRequest = useRef<AbortController | null>(null);
  const albumRequest = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      collectionRequest.current?.abort();
      albumRequest.current?.abort();
    },
    [],
  );
  const [manageOpen, setManageOpen] = useState(false);
  const [editingTrack, setEditingTrack] = useState<Track | null>(null);
  const [metadataRefresh, setMetadataRefresh] = useState<RefreshTarget | null>(null);
  useEffect(() => {
    if (manageOpen) window.scrollTo({ top: 0 });
  }, [manageOpen]);
  const refreshLibrary = useCallback(() => setRevision((value) => value + 1), []);
  const [album, setAlbum] = useState<Album | null>(null);
  const [lyricScanAlbum, setLyricScanAlbum] = useState<string | null>(null);
  const [lyricScanBatch, setLyricScanBatch] = useState<string | null>(null);
  const [selectedArtist, setSelectedArtist] = useState<Artist | null>(null);
  const [artistRole, setArtistRole] = useState('');
  const [artistView, setArtistView] = useState<'tracks' | 'albums'>('tracks');
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const playlistPending = useRef(new Set<string>());
  const mutationEpoch = useRef(0);
  const [catalog, setCatalog] = useState<Playlist[]>([]);
  const [collectionsLoading, setCollectionsLoading] = useState(true);
  const [collectionRevision, setCollectionRevision] = useState(0);
  const [stats, setStats] = useState<ListeningSummary | null>(null);
  const [listeningRevision, setListeningRevision] = useState(0);
  const [draft, setDraft] = useState(''),
    [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const [localError, setError] = useState('');
  const [queueOpen, setQueueOpen] = useState(false),
    [lyricsOpen, setLyricsOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [navigation, setNavigation] = useState<CatalogLocation[]>([]);
  const [counts, setCounts] = useState<ReadonlyMap<View, number>>(() => new Map());
  const [editor, setEditor] = useState<{ initial: Playlist | null; track: Track | null } | null>(
    null,
  );
  const [playlistMenu, setPlaylistMenu] = useState<{ item: Playlist; x: number; y: number } | null>(
    null,
  );
  const closePlaylistMenu = useCallback(() => setPlaylistMenu(null), []);
  useOfflinePlaylistSync(user.id);
  const [bulkTarget, setBulkTarget] = useState(''),
    [bulkBusy, setBulkBusy] = useState(false);
  const closePlayer = useCallback(() => setLyricsOpen(false), []);
  const player = usePlayer(user.id),
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

  const sortContext = albumGrid
    ? selectedArtist
      ? 'artist-albums'
      : 'albums'
    : album
      ? 'album-tracks'
      : selectedArtist
        ? 'artist-tracks'
        : view === 'listening'
          ? 'recent'
          : 'tracks';
  const { selection: catalogSort, change: changeCatalogSort } = useCatalogSorting(
    user.id,
    sortContext,
  );
  const statsSort = catalogSort.sort;
  const sortable = !specialView && !activePlaylist && !artistGrid && !playlistGrid;
  const unit =
    kind === 'artists' ? '位' : kind === 'albums' ? '张' : kind === 'playlists' ? '个' : '首';
  const collectionsMetrics = view === 'playlists' || view === 'favorites' ? listeningRevision : 0;
  const liveRules = activePlaylist?.kind === 'smart' || activePlaylist?.kind === 'favorites';
  useEffect(
    () => () => {
      collectionRequest.current?.abort();
      collectionRequest.current = null;
      setCollectionBusy(false);
    },
    [
      query,
      album?.id,
      selectedArtist?.id,
      artistRole,
      activePlaylist?.id,
      statsSort,
      catalogSort.order,
    ],
  );

  useEffect(() => {
    const controller = new AbortController();
    if (!navigator.onLine) {
      setCollectionsLoading(false);
      return;
    }
    setCollectionsLoading(true);
    const epoch = mutationEpoch.current;
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
      if (!controller.signal.aborted && epoch === mutationEpoch.current) {
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

  const parameters = new URLSearchParams({ q: album ? '' : query });
  let browsePath = '/tracks';
  if (activePlaylist) browsePath = `/playlists/${activePlaylist.id}/tracks`;
  else if (playlistGrid) browsePath = '/playlists';
  else if (artistGrid) browsePath = '/artists';
  else if (selectedArtist) {
    browsePath = `/artists/${selectedArtist.id}/${albumGrid ? 'albums' : 'tracks'}`;
    if (album) parameters.set('album_id', album.id);
  } else if (album) browsePath = `/albums/${album.id}/tracks`;
  else if (albumGrid) browsePath = '/albums';
  if (view === 'artists' && artistRole) parameters.set('role', artistRole);
  if (view === 'listening') parameters.set('played_only', 'true');
  if (sortable) {
    parameters.set('sort', catalogSort.sort);
    parameters.set('order', catalogSort.order);
  }
  const browseIdentity = `${revision}|${view}|${browsePath}?${parameters}|${activePlaylist?.version || 0}|${playlistGrid ? collectionRevision : 0}|${metricsRevision}|${liveRules ? favorites.change : 0}`;
  const browse = useContinuousBrowse<Track | Album | Artist | Playlist>({
    identity: browseIdentity,
    path: `${browsePath}?${parameters}`,
    enabled: !specialView && !(view === 'favorites' && !activePlaylist),
  });
  const visible = browse.page;
  const result = visible ? ({ kind, page: visible } as Result) : null;
  const page = kind === 'tracks' ? (visible as TrackPage | null) : null;
  const loading = browse.loading || (view === 'favorites' && !activePlaylist && collectionsLoading);
  const error =
    localError ||
    browse.error ||
    (view === 'favorites' && !activePlaylist && !collectionsLoading
      ? '暂时无法读取我喜欢歌单，请刷新重试。'
      : '');
  function setResult(update: SetStateAction<Result | null>) {
    browse.setPage((before) => {
      const wrapped = before ? ({ kind, page: before } as Result) : null;
      const updated = typeof update === 'function' ? update(wrapped) : update;
      return updated?.page as BrowsePage<Track | Album | Artist | Playlist> | null;
    });
  }
  const indexEnabled =
    !specialView &&
    !activePlaylist &&
    !album &&
    view !== 'listening' &&
    kind !== 'playlists' &&
    (artistGrid || (catalogSort.order === 'asc' && ['title', 'name'].includes(catalogSort.sort)));
  const [browseIndex, setBrowseIndex] = useState<{ identity: string; index: BrowseIndex } | null>(
    null,
  );
  const [indexError, setIndexError] = useState(false);
  const [indexRevision, setIndexRevision] = useState(0);
  useEffect(() => {
    setIndexError(false);
    if (!indexEnabled) return;
    const controller = new AbortController();
    const indexParameters = new URLSearchParams({ kind, q: query });
    if (selectedArtist) indexParameters.set('artist_id', selectedArtist.id);
    if (view === 'artists' && artistRole) indexParameters.set('role', artistRole);
    api<BrowseIndex>(`/browse-index?${indexParameters}`, { signal: controller.signal })
      .then((index) => {
        if (!controller.signal.aborted) setBrowseIndex({ identity: browseIdentity, index });
      })
      .catch(() => {
        if (!controller.signal.aborted) setIndexError(true);
      });
    return () => controller.abort();
  }, [browseIdentity, indexEnabled, indexRevision]);
  useEffect(() => {
    if (visible && !query && !album && !selectedArtist && !activePlaylist)
      setCounts((current) =>
        current.get(view) === visible.total ? current : new Map(current).set(view, visible.total),
      );
  }, [visible?.total, view, query, album?.id, selectedArtist?.id, activePlaylist?.id]);
  const listRoot = useRef<HTMLDivElement>(null);
  const listEnd = useRef<HTMLDivElement>(null);
  const listStart = useRef<HTMLDivElement>(null);
  const scrollToRestore = useRef<number | null>(null);
  const pendingJump = useRef(false);
  const prependAnchor = useRef<{ id: string; top: number } | null>(null);
  const lastScroll = useRef(0);
  const upwardScroll = useRef(false);
  function repositionList(scroll: () => void) {
    scroll();
    // Jump/retry, prepend anchors and history restoration move the document too.
    // Record their final position before the queued scroll event is delivered so
    // only a later user scroll can trigger loading the previous window.
    lastScroll.current = window.scrollY;
    upwardScroll.current = false;
  }
  useEffect(() => {
    const scroll = () => {
      upwardScroll.current = window.scrollY < lastScroll.current;
      lastScroll.current = window.scrollY;
      if (
        upwardScroll.current &&
        browse.hasPrevious &&
        !browse.busy &&
        !browse.error &&
        listStart.current &&
        listStart.current.getBoundingClientRect().bottom > -200
      )
        loadPrevious();
    };
    window.addEventListener('scroll', scroll, { passive: true });
    return () => window.removeEventListener('scroll', scroll);
  });
  useEffect(() => {
    if (!visible) return;
    if (prependAnchor.current) {
      const anchor = prependAnchor.current;
      const element = Array.from(
        listRoot.current?.querySelectorAll<HTMLElement>('[data-browse-id]') || [],
      ).find((item) => item.dataset.browseId === anchor.id);
      if (element)
        repositionList(() =>
          window.scrollBy({
            top: element.getBoundingClientRect().top - anchor.top,
            behavior: 'instant',
          }),
        );
      prependAnchor.current = null;
    } else if (pendingJump.current) {
      repositionList(() =>
        listRoot.current?.scrollIntoView({ block: 'start', behavior: 'instant' }),
      );
      pendingJump.current = false;
    } else if (scrollToRestore.current !== null) {
      const top = scrollToRestore.current;
      repositionList(() => window.scrollTo({ top, behavior: 'instant' }));
      scrollToRestore.current = null;
    }
  }, [visible, lyricsOpen, navigation.length]);
  useEffect(() => {
    pendingJump.current = false;
    prependAnchor.current = null;
  }, [browseIdentity]);
  function loadPrevious() {
    if (browse.busy || !browse.hasPrevious) return;
    const first = listRoot.current?.querySelector<HTMLElement>('[data-browse-id]');
    if (first)
      prependAnchor.current = {
        id: first.dataset.browseId!,
        top: first.getBoundingClientRect().top,
      };
    void browse.loadPrevious();
  }
  useEffect(() => {
    if (!browse.hasNext || browse.busy || browse.error || !listEnd.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void browse.loadNext();
      },
      { rootMargin: '350px' },
    );
    observer.observe(listEnd.current);
    return () => observer.disconnect();
  }, [browseIdentity, visible, browse.busy, browse.error]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);
  function rememberLocation() {
    const location: CatalogLocation = {
      view,
      album,
      selectedArtist,
      artistRole,
      artistView,
      playlist,
      query,
      draft,
      scroll: window.scrollY,
      playerOpen: lyricsOpen,
      queueOpen,
    };
    setNavigation((items) => [...items, location]);
  }
  function backToLocation() {
    const previous = navigation.at(-1);
    if (!previous) {
      if (album) {
        setAlbum(null);
        clearSearch();
      } else if (selectedArtist) switchView('artists');
      else switchView('playlists');
      return;
    }
    albumRequest.current?.abort();
    setNavigation((items) => items.slice(0, -1));
    setView(previous.view);
    setAlbum(previous.album);
    setSelectedArtist(previous.selectedArtist);
    setArtistRole(previous.artistRole);
    setArtistView(previous.artistView);
    setPlaylist(previous.playlist);
    setQuery(previous.query);
    setDraft(previous.draft);
    setLyricsOpen(previous.playerOpen);
    setQueueOpen(previous.queueOpen);
    setError('');
    scrollToRestore.current = previous.scroll;
  }
  function clearSearch() {
    albumRequest.current?.abort();
    setDraft('');
    setQuery('');
    setError('');
  }
  function switchView(target: View, resetHistory = true) {
    if (!Object.hasOwn(labels, target)) return;
    collectionRequest.current?.abort();
    collectionRequest.current = null;
    setCollectionBusy(false);
    setManageOpen(false);
    if (resetHistory) setNavigation([]);
    window.scrollTo(0, 0);
    setView(target);
    setAlbum(null);
    setSelectedArtist(null);
    setPlaylist(null);
    clearSearch();
  }
  useEffect(() => {
    const openLink = () => {
      const match = /^#agent\/(drafts|tasks)\/([A-Za-z0-9_-]{1,128})$/.exec(location.hash);
      if (!match) return;
      const kind = match[1] as 'drafts' | 'tasks';
      setSelectedAgentItem({ kind, id: match[2] });
      switchView(kind);
    };
    openLink();
    window.addEventListener('hashchange', openLink);
    return () => window.removeEventListener('hashchange', openLink);
  }, []);
  function switchTab(target: 'tracks' | 'albums') {
    if (selectedArtist) {
      setArtistView(target);
      setAlbum(null);
      clearSearch();
    } else switchView(target);
  }
  function openArtist(item: Artist) {
    rememberLocation();
    window.scrollTo(0, 0);
    setSelectedArtist(item);
    setArtistView('tracks');
    setAlbum(null);
    clearSearch();
  }
  async function openArtistName(name: string) {
    const query = name.trim();
    if (!query) return;
    setNotice(`正在打开艺人“${query}”…`);
    try {
      const result = await api<ArtistPage>(
        `/artists?q=${encodeURIComponent(query)}&limit=20&offset=0`,
      );
      const item =
        result.items.find((candidate) => candidate.name === query) ||
        result.items.find(
          (candidate) =>
            candidate.name.localeCompare(query, undefined, { sensitivity: 'base' }) === 0,
        ) ||
        (result.items.length === 1 ? result.items[0] : undefined);
      if (!item) {
        setNotice(`没有找到艺人“${query}”，可以用顶部搜索查看。`);
        return;
      }
      openArtist(item);
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : '艺人暂时无法打开，请稍后重试。');
    }
  }
  function openPlaylist(item: Playlist) {
    rememberLocation();
    window.scrollTo(0, 0);
    setView(item.kind === 'favorites' ? 'favorites' : 'playlists');
    setPlaylist(item.kind === 'favorites' ? null : item);
    setSelectedArtist(null);
    setAlbum(null);
    clearSearch();
  }
  async function openTrackAlbum(track: Track) {
    if (!track.album_id) return;
    albumRequest.current?.abort();
    const controller = new AbortController();
    albumRequest.current = controller;
    setNotice('正在打开专辑…');
    try {
      const target = await api<Album>(`/albums/${encodeURIComponent(track.album_id)}`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      rememberLocation();
      switchView('albums', false);
      setAlbum(target);
      setLyricsOpen(false);
      setQueueOpen(false);
      setNotice('');
    } catch (reason) {
      if (!controller.signal.aborted)
        setNotice(reason instanceof ApiError ? reason.message : '专辑暂时无法打开，请重试。');
    } finally {
      if (albumRequest.current === controller) albumRequest.current = null;
    }
  }
  function search(event: FormEvent) {
    event.preventDefault();
    albumRequest.current?.abort();
    setNavigation([]);
    setError('');
    window.scrollTo(0, 0);
    setAlbum(null);
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
    if (playlistPending.current.has(list.id)) return;
    playlistPending.current.add(list.id);
    mutationEpoch.current++;
    setNotice(`正在加入：${list.name}`);
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
    } finally {
      playlistPending.current.delete(list.id);
    }
  }
  async function editPlaylistTrack(track: Track, direction?: -1 | 1) {
    if (!activePlaylist || playlistPending.current.has(activePlaylist.id)) return;
    const list = activePlaylist;
    playlistPending.current.add(list.id);
    mutationEpoch.current++;
    const before = result;
    let optimistic = before;
    if (before?.kind === 'tracks') {
      const items = [...before.page.items];
      const from = items.findIndex((item) => item.id === track.id);
      if (from >= 0) {
        if (direction) {
          const to = from + direction;
          if (to >= 0 && to < items.length) [items[from], items[to]] = [items[to], items[from]];
        } else items.splice(from, 1);
        optimistic = {
          kind: 'tracks',
          page: { ...before.page, items, total: before.page.total - (direction ? 0 : 1) },
        };
        setResult(optimistic);
      }
    }
    setNotice(direction ? '正在保存顺序…' : '正在移除…');
    try {
      const updated = await api<Playlist>(
        direction
          ? `/playlists/${list.id}/move`
          : `/playlists/${list.id}/tracks/${track.id}?version=${list.version}`,
        {
          method: direction ? 'POST' : 'DELETE',
          ...(direction
            ? { body: JSON.stringify({ version: list.version, track_id: track.id, direction }) }
            : {}),
        },
      );
      updateList(updated);
      setNotice(direction ? '已调整歌单顺序' : '已从歌单移除');
    } catch (reason) {
      setResult((current) => (current?.page === optimistic?.page ? before : current));
      setNotice(reason instanceof ApiError ? reason.message : '歌单未修改，已恢复，请重试。');
      setCollectionRevision((value) => value + 1);
    } finally {
      playlistPending.current.delete(list.id);
    }
  }
  function collectionPath() {
    const parameters = new URLSearchParams({ q: album ? '' : query });
    let path = '/tracks';
    if (activePlaylist) path = `/playlists/${activePlaylist.id}/tracks`;
    else if (selectedArtist) {
      path = `/artists/${selectedArtist.id}/tracks`;
      if (album) parameters.set('album_id', album.id);
    } else if (album) path = `/albums/${album.id}/tracks`;
    if (view === 'artists' && artistRole) parameters.set('role', artistRole);
    if (view === 'listening') parameters.set('played_only', 'true');
    if (sortable) {
      parameters.set('sort', catalogSort.sort);
      parameters.set('order', catalogSort.order);
    }
    return `${path}?${parameters}`;
  }
  async function completeCollection(target?: Track, download = false) {
    if (collectionRequest.current) return;
    const controller = new AbortController();
    collectionRequest.current = controller;
    setCollectionBusy(true);
    setNotice(download ? '正在准备离线歌曲…' : '正在读取完整播放列表…');
    try {
      const tracks = await collectTracks(collectionPath(), controller.signal);
      if (controller.signal.aborted) return;
      if (download) {
        await saveDownloads(tracks);
        setNotice(`已添加 ${tracks.length} 首到离线下载，可在“离线音乐”查看。`);
      } else {
        const index = target ? tracks.findIndex((t) => t.id === target.id) : 0;
        if (index < 0) throw new Error('歌曲已从集合移除，请刷新。');
        player.start(tracks, index);
        setNotice(`完整队列已就位，共 ${tracks.length} 首。`);
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setNotice(e instanceof Error ? e.message : '完整集合未读取成功，请重试。');
    } finally {
      if (collectionRequest.current === controller) {
        collectionRequest.current = null;
        setCollectionBusy(false);
      }
    }
  }
  const operations: TrackOperations = {
    favorites,
    onOpenAlbum: (track) => void openTrackAlbum(track),
    onDownload: (track) => {
      void saveDownloads([track])
        .then(() => setNotice('已添加到离线下载。'))
        .catch((e) => setNotice(e instanceof Error ? e.message : '离线保存未完成。'));
    },
    playlists: catalog.filter((item) => item.kind === 'manual'),
    onAdd: addToPlaylist,
    onCreate: (track) => setEditor({ initial: null, track }),
    onEdit: canManage ? setEditingTrack : undefined,
    onRefresh: canImport
      ? (track) => setMetadataRefresh({ scope: 'track', id: track.id, label: track.title })
      : undefined,
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
  async function deletePlaylist(target = activePlaylist) {
    if (!target || !confirm(`删除歌单“${target.name}”？歌曲文件会保留。`)) return;
    try {
      await api(`/playlists/${target.id}?version=${target.version}`, {
        method: 'DELETE',
      });
      switchView('playlists');
      followPlaylist(user.id, target.id, false);
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
      setNotice(`已加载歌曲已加入：${list.name}`);
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
  const nav = (target: View) => (
    <button
      key={target}
      className={`nav-button ${view === target && !manageOpen ? 'nav-current' : ''}`}
      onClick={() => switchView(target)}
    >
      <span aria-hidden="true">
        {target === 'notifications' ? (
          <Icon name="bell" />
        ) : target === 'assistant' ? (
          <Icon name="assistant" />
        ) : target === 'drafts' ? (
          <Icon name="draft" />
        ) : target === 'tasks' ? (
          <Icon name="task" />
        ) : target === 'assistant-settings' ? (
          <Icon name="settings" />
        ) : (
          icons[target]
        )}
      </span>
      {labels[target]}
      {target === 'notifications' && inbox.unread > 0 ? (
        <small className="notification-count" aria-label={`${inbox.unread} 条未读通知`}>
          {inbox.unread > 99 ? '99+' : inbox.unread}
        </small>
      ) : target === 'favorites' ? (
        <small>{favorites.ids.size}</small>
      ) : counts.has(target) ? (
        <small>{counts.get(target)}</small>
      ) : null}
    </button>
  );
  const headingCover =
    album?.cover_track_id || selectedArtist?.cover_track_id || activePlaylist?.cover_track_id;
  return (
    <>
      <div className="app-shell" inert={lyricsOpen} aria-hidden={lyricsOpen || undefined}>
        <aside className="sidebar">
          <Brand />
          <nav aria-label="主导航" className="sidebar-navigation">
            <p className="sidebar-group-label">曲库</p>
            {(['tracks', 'albums', 'artists', 'playlists', 'favorites'] as View[]).map(nav)}
            <p className="sidebar-group-label">发现</p>
            {(['discover', 'assistant'] as View[]).map(nav)}
            <details
              className="sidebar-group"
              open={['listening', 'offline', 'devices'].includes(view) || undefined}
            >
              <summary>更多音乐</summary>
              {(['listening', 'offline', 'devices'] as View[]).map(nav)}
            </details>
            <details
              className="sidebar-group"
              open={['drafts', 'tasks', 'assistant-settings'].includes(view) || undefined}
            >
              <summary>助手工具</summary>
              {(['drafts', 'tasks', 'assistant-settings'] as View[]).map(nav)}
            </details>
          </nav>
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
            {canManage && (
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
              <AccountAvatar user={user} />
              账号设置
            </button>
            <ThemeControl />
            <span className="local-dot" /> 私人曲库 · 原音直放
            <button className="text-button" onClick={logout}>
              退出登录 ↗
            </button>
          </div>
        </aside>
        {manageOpen && (
          <Management
            revision={revision}
            onBack={() => {
              setManageOpen(false);
              setManagementAction(null);
            }}
            onEdit={setEditingTrack}
            onChanged={refreshLibrary}
            onRefresh={() => setMetadataRefresh({ scope: 'library', label: '整个曲库' })}
            onOpenConnections={openModelConnections}
            profile={profile}
            initialAction={managementAction}
          />
        )}
        <main className={`library ${album ? 'is-album' : ''}`} hidden={manageOpen}>
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
              {canManage && <option value="manage">管理</option>}
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
            <button
              className={`notification-entry icon-button ${view === 'notifications' ? 'selected' : ''}`}
              aria-label="通知中心"
              data-help={inbox.unread ? `${inbox.unread} 条未读通知` : '通知中心'}
              onClick={() => switchView('notifications')}
            >
              <Icon name="bell" />
              {inbox.unread > 0 && (
                <span aria-hidden="true" className="notification-corner-count">
                  {inbox.unread > 99 ? '99+' : inbox.unread}
                </span>
              )}
            </button>
          </header>
          {view === 'discover' && (
            <Discover
              player={player}
              favorites={favorites}
              onConnections={openModelConnections}
              onSaved={(list) => {
                setCollectionRevision((v) => v + 1);
                setNotice(`已保存：${list.name}`);
              }}
            />
          )}
          {view === 'offline' && <OfflinePanel player={player} userId={user.id} />}
          {view === 'devices' && <Devices player={player} user={user} />}
          <Suspense
            fallback={
              <p role="status" className="workspace-empty">
                正在打开工作台…
              </p>
            }
          >
            {view === 'assistant' && (
              <Assistant
                onDraft={(id) => openAgentItem('drafts', id)}
                onConnections={openModelConnections}
              />
            )}
            {view === 'drafts' && (
              <Drafts
                user={user}
                selectedId={selectedAgentItem?.kind === 'drafts' ? selectedAgentItem.id : undefined}
                onChanged={() => {
                  refreshLibrary();
                  setCollectionRevision((value) => value + 1);
                  void inbox.refresh();
                }}
              />
            )}
            {view === 'tasks' && (
              <AgentTasks
                onDraft={(id) => openAgentItem('drafts', id)}
                selectedId={selectedAgentItem?.kind === 'tasks' ? selectedAgentItem.id : undefined}
              />
            )}
            {view === 'notifications' && (
              <Notifications inbox={inbox} onOpen={openNotificationAction} />
            )}
            {view === 'assistant-settings' && (
              <AssistantSettings key={connectionSettingsRevision} user={user} />
            )}
          </Suspense>
          <div hidden={specialView}>
            <section
              className={`collection-heading ${album || selectedArtist ? 'album-heading' : ''}`}
            >
              <div>
                {(album || selectedArtist || playlist) && (
                  <button className="back-button text-button" onClick={backToLocation}>
                    ←{' '}
                    {navigation.at(-1)?.playerOpen
                      ? '返回播放'
                      : album
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
                  <span data-help="累计听过半首或 4 分钟计一次；同一次播放只计一次">播放次数</span>
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
                {!album && (
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
                )}
                {view === 'artists' && !album && (
                  <label className="artist-role">
                    参与角色{' '}
                    <select
                      aria-label="艺人参与角色"
                      value={artistRole}
                      onChange={(e) => {
                        setArtistRole(e.target.value);
                        setSelectedArtist(null);
                        setAlbum(null);
                      }}
                    >
                      <option value="">全部角色</option>
                      <option value="artist">歌曲艺人</option>
                      <option value="album_artist">专辑艺人</option>
                      <option value="vocalist">演唱</option>
                      <option value="lyricist">作词</option>
                      <option value="composer">作曲</option>
                      <option value="arranger">编曲</option>
                    </select>
                  </label>
                )}
                {kind === 'tracks' && (
                  <button
                    className="primary"
                    disabled={loading || !!error || !page?.items.length || collectionBusy}
                    onClick={() => void completeCollection()}
                  >
                    <span aria-hidden="true">▶ </span>
                    {collectionBusy
                      ? '准备中…'
                      : album
                        ? '播放专辑'
                        : selectedArtist
                          ? '播放艺人'
                          : activePlaylist
                            ? '播放歌单'
                            : '播放全部'}
                  </button>
                )}
                {kind === 'tracks' && (
                  <>
                    <span className="collection-count">{visible?.total ?? '—'} 首</span>
                    <details className="collection-menu">
                      <summary aria-label="集合更多操作">
                        <Icon name="more" />
                      </summary>
                      <div>
                        <button
                          disabled={loading || collectionBusy || !page?.items.length}
                          onClick={() => void completeCollection(undefined, true)}
                        >
                          <Icon name="download" />
                          保存整个集合离线
                        </button>
                        {album && canImport && (
                          <button
                            onClick={(event) => {
                              event.currentTarget.closest('details')?.removeAttribute('open');
                              setLyricScanAlbum(album.id);
                            }}
                          >
                            歌词补全与洗版
                          </button>
                        )}
                        {album && canImport && (
                          <button
                            onClick={(event) => {
                              event.currentTarget.closest('details')?.removeAttribute('open');
                              setMetadataRefresh({
                                scope: 'album',
                                id: album.id,
                                label: album.title,
                              });
                            }}
                          >
                            <Icon name="refresh" />
                            更新专辑元数据
                          </button>
                        )}
                      </div>
                    </details>
                  </>
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
                {sortable && (
                  <CatalogSortControl
                    context={sortContext}
                    selection={catalogSort}
                    change={changeCatalogSort}
                  />
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
            {localError && visible && (
              <div className="browse-error" role="alert">
                <span>{localError}</span>
                <button onClick={() => setError('')}>关闭</button>
              </div>
            )}
            {page &&
              page.items.length > 0 &&
              operations.playlists.length > 0 &&
              !loading &&
              !error && (
                <details className="bulk-playlist-panel">
                  <summary>批量加入歌单</summary>
                  <div className="bulk-playlist">
                    <label>
                      <span>把已加载歌曲留进歌单</span>
                      <select
                        aria-label="已加载歌曲加入歌单"
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
                      {bulkBusy ? '加入中…' : '加入已加载'}
                    </button>
                  </div>
                </details>
              )}
            {error && !visible ? (
              <div className="empty" role="alert">
                <h2>暂时无法读取曲库</h2>
                <p>{error}</p>
                <button
                  onClick={() => {
                    setError('');
                    browse.retry();
                  }}
                >
                  重新连接
                </button>
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
                          ? '从歌曲的更多操作加入，或批量加入已加载的歌曲。'
                          : view === 'listening'
                            ? '听过的歌曲、次数和时长会留在这里。'
                            : '导入音乐后，刷新曲库。'}
                </p>
              </div>
            ) : (
              <div
                ref={listRoot}
                className={`continuous-content ${indexEnabled ? 'has-alphabet' : ''}`}
                data-testid="continuous-list"
              >
                <div ref={listStart} className="browse-boundary">
                  {browse.hasPrevious && (
                    <button disabled={browse.busy} onClick={loadPrevious}>
                      加载前面的{kind === 'tracks' ? '歌曲' : kind === 'albums' ? '专辑' : '艺人'}
                    </button>
                  )}
                </div>
                {kind === 'artists' ? (
                  <div className="artist-grid" aria-label="艺人列表">
                    {(visible as ArtistPage).items.map((item) => (
                      <button
                        className="artist-card"
                        key={item.id}
                        data-browse-id={item.id}
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
                      <div className="playlist-tile" key={item.id}>
                        <button
                          className={`playlist-card ${item.kind}`}
                          key={item.id}
                          data-browse-id={item.id}
                          aria-label={`打开歌单 ${item.name}`}
                          onClick={() => openPlaylist(item)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            const rect = event.currentTarget.getBoundingClientRect();
                            setPlaylistMenu({
                              item,
                              x: event.clientX || rect.left + 24,
                              y: event.clientY || rect.top + 24,
                            });
                          }}
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
                        <button
                          className="playlist-menu-trigger icon-button"
                          aria-label={`${item.name}的歌单操作`}
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect();
                            setPlaylistMenu({ item, x: rect.right - 220, y: rect.bottom + 4 });
                          }}
                        >
                          <Icon name="more" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : kind === 'albums' ? (
                  <div className="album-grid" aria-label="专辑列表">
                    {(visible as AlbumPage).items.map((item) => (
                      <div className="album-card" key={item.id} data-browse-id={item.id}>
                        <button
                          className="album-card-main"
                          aria-label={`打开专辑 ${item.title}`}
                          onClick={() => {
                            albumRequest.current?.abort();
                            rememberLocation();
                            window.scrollTo(0, 0);
                            setAlbum(item);
                          }}
                        >
                          <Cover
                            key={`${item.id}-${revision}`}
                            trackId={item.cover_track_id}
                            title={item.title}
                            size={320}
                          />
                          <strong>{item.title}</strong>
                          <small>
                            {item.track_count} 首 · {time(item.duration_ms / 1000)}
                          </small>
                        </button>
                        <span className="album-card-artists">
                          {item.artists.length
                            ? item.artists.map((name, artistIndex) => (
                                <span key={`${name}-${artistIndex}`}>
                                  {artistIndex > 0 && <span aria-hidden="true"> / </span>}
                                  <button
                                    type="button"
                                    className="album-artist-link"
                                    onClick={() => void openArtistName(name)}
                                  >
                                    {name}
                                  </button>
                                </span>
                              ))
                            : '未知艺人'}
                        </span>
                      </div>
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
                      onPlay={(track) => void completeCollection(track)}
                      onOpenArtist={(name) => void openArtistName(name)}
                      showStats={view === 'listening'}
                      statsSort={statsSort}
                      albumTracks={!!album}
                      groupDiscs={!!album && ['track_number', 'title'].includes(catalogSort.sort)}
                    />
                  )
                )}
                <div ref={listEnd} className="browse-boundary" aria-live="polite">
                  {browse.busy ? (
                    <span>正在加载更多…</span>
                  ) : browse.error ? (
                    <>
                      <span role="alert">{browse.error}</span>
                      <button onClick={browse.retry}>重试加载</button>
                    </>
                  ) : browse.hasNext ? (
                    <button onClick={() => void browse.loadNext()}>加载更多</button>
                  ) : (
                    <span>
                      共 {visible.total} {unit} · 已到底
                    </span>
                  )}
                </div>
                {indexEnabled && browseIndex?.identity === browseIdentity && (
                  <AlphabetRail
                    index={browseIndex.index}
                    onJump={(offset) => {
                      pendingJump.current = true;
                      void browse.jump(offset);
                    }}
                  />
                )}
                {indexEnabled && indexError && (
                  <button
                    className="text-button"
                    onClick={() => setIndexRevision((value) => value + 1)}
                  >
                    首字母索引未加载，重试
                  </button>
                )}
              </div>
            )}
          </div>
        </main>
        {queueOpen && (
          <button
            className="queue-dismiss-scrim"
            aria-label="关闭播放队列"
            onClick={() => setQueueOpen(false)}
          />
        )}
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
        {notice && !lyricsOpen && (
          <p className="toast" role="status">
            {notice}
          </p>
        )}
      </div>
      {(lyricsOpen || navigation.some((location) => location.playerOpen)) && (
        <NowPlaying
          active={lyricsOpen}
          player={player}
          onClose={closePlayer}
          favorites={favorites}
          onOpenAlbum={(track) => void openTrackAlbum(track)}
          statusMessage={notice}
        />
      )}
      {lyricScanAlbum && (
        <LyricScanDialog albumId={lyricScanAlbum} onClose={() => setLyricScanAlbum(null)} />
      )}
      {lyricScanBatch && (
        <LyricScanDialog batchId={lyricScanBatch} onClose={() => setLyricScanBatch(null)} />
      )}
      {metadataRefresh && (
        <MetadataRefreshDialog target={metadataRefresh} onClose={() => setMetadataRefresh(null)} />
      )}
      <PlaybackSync player={player} userId={user.id} />
      {playlistMenu && (
        <PlaylistMenu
          playlist={playlistMenu.item}
          x={playlistMenu.x}
          y={playlistMenu.y}
          following={followedPlaylists(user.id).includes(playlistMenu.item.id)}
          onClose={closePlaylistMenu}
          onOpen={() => {
            openPlaylist(playlistMenu.item);
            closePlaylistMenu();
          }}
          onEdit={() => {
            void api<Playlist>(`/playlists/${playlistMenu.item.id}`)
              .then((initial) => setEditor({ initial, track: null }))
              .catch(() => setNotice('无法读取歌单，请重试。'));
            closePlaylistMenu();
          }}
          onDelete={() => {
            void deletePlaylist(playlistMenu.item);
            closePlaylistMenu();
          }}
          onFollow={() => {
            const enabled = !followedPlaylists(user.id).includes(playlistMenu.item.id);
            followPlaylist(user.id, playlistMenu.item.id, enabled);
            setNotice(
              enabled
                ? '已开启歌单自动下载，可在离线音乐中设置网络和音质。'
                : '已关闭自动下载，离线音乐保留。',
            );
            closePlaylistMenu();
          }}
        />
      )}
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
