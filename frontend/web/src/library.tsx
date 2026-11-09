import { trackUnavailableReason } from './api';
import { useTranslation } from 'react-i18next';
import { readPreference, writePreference } from './user-preferences';
import { CatalogSortControl, useCatalogSorting } from './catalog-sort';
import { bindLibraryUser, selectedLibrary } from './library-context';
import { LibrarySwitcher } from './music-libraries';
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
import { NowPlaying } from './now-playing';
import { PlayerBar, usePlayer } from './player';
import { PlaylistEditor } from './playlist-editor';
import { PlaylistMenu } from './playlist-menu';
import { AlbumEditor } from './album-editor';
import { AlbumMenu } from './album-menu';
import { PlaybackSync } from './playback-sync';
import { PodcastProgressDialog } from './podcast-progress-dialog';
import { QueuePanel } from './queue-panel';
import { Management, type ManagementTab } from './management';
import { PersonalSettings, type PersonalSection } from './personal-settings';
import type { AssistantSettingsTab } from './assistant-settings';
import { MetadataEditor } from './metadata-editor';
import { MetadataRefreshDialog, type RefreshTarget } from './metadata-refresh';
import { LyricScanDialog } from './lyric-scans';
import { TrackFileInfoDialog } from './track-file-info-dialog';
import { PodcastsPage } from './podcasts';
import { ThemeToggleCompact } from './theme';
import { TrackList } from './track-list';
import {
  AlphabetRail,
  useContinuousBrowse,
  type BrowseIndex,
  type BrowsePage,
} from './continuous-browse';
import { Icon } from './icons';
import type { TrackOperations } from './track-actions';
import { Discover } from './discover';
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

type View =
  | 'tracks'
  | 'albums'
  | 'artists'
  | 'playlists'
  | 'favorites'
  | 'listening'
  | 'discover'
  | 'podcasts'
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

function AlbumSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="album-view-skeleton" role="status" aria-label={t('library.loadingAlbums')}>
      <span className="skeleton-block skeleton-cover" />
      <div className="skeleton-track-list">
        {Array.from({ length: 6 }, (_, index) => (
          <span className="skeleton-block skeleton-track" key={index} />
        ))}
      </div>
    </div>
  );
}
// Display names come from locales (`views.*`); this map only lists valid views.
const labels: Record<View, string> = {
  tracks: 'views.tracks',
  albums: 'views.albums',
  artists: 'views.artists',
  playlists: 'views.playlists',
  favorites: 'views.favorites',
  listening: 'views.listening',
  discover: 'views.discover',
  podcasts: 'views.podcasts',
  offline: 'views.offline',
  devices: 'views.devices',
  assistant: 'views.assistant',
  drafts: 'views.drafts',
  tasks: 'views.tasks',
  notifications: 'views.notifications',
  'assistant-settings': 'views.assistant-settings',
};
const viewIcons: Record<
  View,
  | 'music'
  | 'album'
  | 'artist'
  | 'playlist'
  | 'heart'
  | 'history'
  | 'assistant'
  | 'compass'
  | 'podcast'
  | 'download'
  | 'refresh'
  | 'draft'
  | 'task'
  | 'bell'
  | 'settings'
> = {
  tracks: 'music',
  albums: 'album',
  artists: 'artist',
  playlists: 'playlist',
  favorites: 'heart',
  listening: 'history',
  discover: 'compass',
  podcasts: 'podcast',
  offline: 'download',
  devices: 'refresh',
  assistant: 'assistant',
  drafts: 'draft',
  tasks: 'task',
  notifications: 'bell',
  'assistant-settings': 'settings',
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
  const { t } = useTranslation();
  bindLibraryUser(user.id);
  const [currentUser, setCurrentUser] = useState(user);
  const profile = currentUser.profile;
  const canManage = profile !== 'listener';
  const canImport = profile === 'owner' || profile === 'librarian';
  const [accountOpen, setAccountOpen] = useState(() =>
    ['devices', 'assistant-settings'].includes(readPreference('wildstring:active_view') || ''),
  );
  const [settingsLocation, setSettingsLocation] = useState<{
    section: PersonalSection | null;
    assistantTab?: AssistantSettingsTab;
  }>(() => ({
    section:
      readPreference('wildstring:active_view') === 'devices'
        ? 'downloads'
        : readPreference('wildstring:active_view') === 'assistant-settings'
          ? 'assistant'
          : null,
  }));
  const [connectionSettingsRevision, setConnectionSettingsRevision] = useState(0);
  function openPersonalSettings(
    section: PersonalSection | null = null,
    assistantTab: AssistantSettingsTab = 'connections',
  ) {
    setSettingsLocation({ section, assistantTab });
    setConnectionSettingsRevision((value) => value + 1);
    setAccountOpen(true);
    setManageOpen(false);
    setQueueOpen(false);
    window.scrollTo(0, 0);
  }
  function openModelConnections() {
    openPersonalSettings('assistant', 'connections');
  }
  function openManagement(tab: ManagementTab = 'home') {
    setAccountOpen(false);
    setManageOpen(true);
    setManagementTab(tab);
    setQueueOpen(false);
    window.scrollTo(0, 0);
  }
  const [view, setView] = useState<View>(() => {
    try {
      const saved = readPreference('wildstring:active_view');
      if (saved && Object.hasOwn(labels, saved)) {
        return saved === 'devices' || saved === 'assistant-settings' ? 'tracks' : (saved as View);
      }
    } catch {
      // 忽略
    }
    return navigator.onLine && !usingOfflineAccess() ? 'tracks' : 'offline';
  });
  const specialView = [
    'discover',
    'podcasts',
    'offline',
    'devices',
    'assistant',
    'drafts',
    'tasks',
    'notifications',
    'assistant-settings',
  ].includes(view);
  const inbox = useNotifications(currentUser.id);
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
      openManagement('jobs');
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
  const [managementTab, setManagementTab] = useState<ManagementTab>('home');
  const [focusPodcastId, setFocusPodcastId] = useState<string | null>(null);
  const [editingTrack, setEditingTrack] = useState<Track | null>(null);
  const [metadataRefresh, setMetadataRefresh] = useState<RefreshTarget | null>(null);
  useEffect(() => {
    if (manageOpen) window.scrollTo({ top: 0 });
  }, [manageOpen]);
  const refreshLibrary = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const changed = () => {
      if (!manageOpen) switchView(view);
      refreshLibrary();
    };
    const accessChanged = () => {
      albumRequest.current?.abort();
      collectionRequest.current?.abort();
      setEditingTrack(null);
      setEditingAlbum(null);
      setViewingFileTrack(null);
      setMetadataRefresh(null);
      setEditor(null);
      setAlbumMenu(null);
      setPlaylistMenu(null);
      setLyricScanAlbum(null);
      setLyricScanBatch(null);
      setSelectedAgentItem(null);
      if (profile !== 'owner') switchView('tracks');
      refreshLibrary();
    };
    window.addEventListener('wildstring:library-access-changed', accessChanged);
    window.addEventListener('wildstring:library-changed', changed);
    return () => {
      window.removeEventListener('wildstring:library-access-changed', accessChanged);
      window.removeEventListener('wildstring:library-changed', changed);
    };
  }, [refreshLibrary, view, manageOpen, profile]);
  const [album, setAlbum] = useState<Album | null>(null);
  const [albumLoading, setAlbumLoading] = useState(false);
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
  const [editor, setEditor] = useState<{ initial: Playlist | null; track: Track | null } | null>(
    null,
  );
  const [playlistMenu, setPlaylistMenu] = useState<{ item: Playlist; x: number; y: number } | null>(
    null,
  );
  const closePlaylistMenu = useCallback(() => setPlaylistMenu(null), []);
  const [albumMenu, setAlbumMenu] = useState<{ item: Album; x: number; y: number } | null>(null);
  const [editingAlbum, setEditingAlbum] = useState<Album | null>(null);
  const [viewingFileTrack, setViewingFileTrack] = useState<Track | null>(null);
  const closeAlbumMenu = useCallback(() => setAlbumMenu(null), []);
  useOfflinePlaylistSync(currentUser.id);
  const [bulkTarget, setBulkTarget] = useState(''),
    [bulkBusy, setBulkBusy] = useState(false);
  const closePlayer = useCallback(() => setLyricsOpen(false), []);
  const player = usePlayer(currentUser.id),
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
    currentUser.id,
    sortContext,
  );
  const statsSort = catalogSort.sort;
  const sortable = !specialView && !activePlaylist && !artistGrid && !playlistGrid;
  const unit =
    kind === 'artists'
      ? t('library.unitArtists')
      : kind === 'albums'
        ? t('library.unitAlbums')
        : kind === 'playlists'
          ? t('library.unitPlaylists')
          : t('library.unitTracks');
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
        const response = await api<PlaylistPage>(
          `/playlists?include_unavailable=true&limit=100&offset=${cursor}`,
          {
            signal: controller.signal,
          },
        );
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
        if (!controller.signal.aborted) setNotice(t('library.playlistsLoadFailed'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setCollectionsLoading(false);
      });
    return () => controller.abort();
  }, [revision, collectionRevision, favorites.change]);

  useEffect(() => {
    const changed = () => setListeningRevision((value) => value + 1);
    window.addEventListener('wildstring:listening-updated', changed);
    return () => window.removeEventListener('wildstring:listening-updated', changed);
  }, []);
  useEffect(() => {
    if (view !== 'listening') return;
    const controller = new AbortController();
    api<ListeningSummary>('/listening/summary', { signal: controller.signal })
      .then(setStats)
      .catch(() => {
        if (!controller.signal.aborted) setNotice(t('library.listeningLoadFailed'));
      });
    return () => controller.abort();
  }, [view, revision, listeningRevision, favorites.change]);

  const parameters = new URLSearchParams({ q: album ? '' : query, include_unavailable: 'true' });
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
  const browseIdentity = `${revision}|${view}|${browsePath}?${parameters}|${activePlaylist?.version || 0}|${playlistGrid ? collectionRevision : 0}|${liveRules ? favorites.change : 0}`;
  const browse = useContinuousBrowse<Track | Album | Artist | Playlist>({
    identity: browseIdentity,
    path: `${browsePath}?${parameters}`,
    enabled: !specialView && !(view === 'favorites' && !activePlaylist),
  });
  const visible = browse.page;
  const result = visible ? ({ kind, page: visible } as Result) : null;
  const page = kind === 'tracks' ? (visible as TrackPage | null) : null;
  const loading =
    browse.loading ||
    albumLoading ||
    (view === 'favorites' && !activePlaylist && collectionsLoading);
  const error =
    localError ||
    browse.error ||
    (view === 'favorites' && !activePlaylist && !collectionsLoading
      ? t('library.favoritesLoadFailed')
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
    const indexParameters = new URLSearchParams({ kind, q: query, include_unavailable: 'true' });
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
    return location;
  }
  function restoreLocation(previous: CatalogLocation) {
    setView(previous.view);
    setAlbumLoading(false);
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
  function backToLocation() {
    const previous = navigation.at(-1);
    if (!previous) {
      if (album) {
        setAlbumLoading(false);
        setAlbum(null);
        clearSearch();
      } else if (selectedArtist) switchView('artists');
      else switchView('playlists');
      return;
    }
    albumRequest.current?.abort();
    setNavigation((items) => items.slice(0, -1));
    restoreLocation(previous);
  }
  function clearSearch() {
    albumRequest.current?.abort();
    setDraft('');
    setQuery('');
    setError('');
  }
  function switchView(target: View, resetHistory = true) {
    if (target === 'assistant-settings') return openPersonalSettings('assistant');
    if (target === 'devices') return openPersonalSettings('downloads');
    if (!Object.hasOwn(labels, target)) return;
    setAccountOpen(false);
    try {
      writePreference('wildstring:active_view', target);
    } catch {
      // 忽略
    }
    collectionRequest.current?.abort();
    collectionRequest.current = null;
    setCollectionBusy(false);
    setManageOpen(false);
    if (resetHistory) setNavigation([]);
    window.scrollTo(0, 0);
    document.querySelector('.sidebar-navigation')?.scrollTo(0, 0);
    setView(target);
    setAlbumLoading(false);
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
    setAlbumLoading(false);
    setAlbum(null);
    clearSearch();
  }
  async function openArtistName(name: string) {
    const query = name.trim();
    if (!query) return;
    setNotice(t('library.openingArtist', { name: query }));
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
        setNotice(t('library.artistNotFound', { name: query }));
        return;
      }
      setLyricsOpen(false);
      setQueueOpen(false);
      openArtist(item);
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : t('library.artistOpenFailed'));
    }
  }
  function openPlaylist(item: Playlist) {
    rememberLocation();
    window.scrollTo(0, 0);
    setView(item.kind === 'favorites' ? 'favorites' : 'playlists');
    setPlaylist(item.kind === 'favorites' ? null : item);
    setSelectedArtist(null);
    setAlbumLoading(false);
    setAlbum(null);
    clearSearch();
  }
  async function openTrackAlbum(track: Track) {
    if (!track.album_id) return;
    albumRequest.current?.abort();
    const previousLocation = rememberLocation();
    switchView('albums', false);
    const controller = new AbortController();
    albumRequest.current = controller;
    setAlbum({
      id: track.album_id,
      title: track.album || t('library.unknownAlbum'),
      artists: track.artists,
      track_count: 0,
      duration_ms: 0,
      cover_track_id: track.id,
    });
    setAlbumLoading(true);
    setLyricsOpen(false);
    setQueueOpen(false);
    try {
      const target = await api<Album>(
        `/albums/${encodeURIComponent(track.album_id)}?include_unavailable=true`,
        {
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      setAlbum(target);
      setAlbumLoading(false);
    } catch {
      if (!controller.signal.aborted) {
        setAlbumLoading(false);
        // A missing album should leave the caller where they were and offer a
        // stable, user-facing retry message. In particular, callers opened
        // from the player need the player dialog restored so the message is
        // visible there instead of being hidden behind the album view.
        albumRequest.current?.abort();
        setNavigation((items) => items.slice(0, -1));
        restoreLocation(previousLocation);
        setNotice(t('library.albumGone'));
      }
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
    setAlbumLoading(false);
    setAlbum(null);
    setQuery(draft.trim());
    setRevision((value) => value + 1);
  }
  function logout() {
    void onLogout().catch(() => setError(t('library.logoutFailed')));
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
    setNotice(t('library.addingTo', { name: list.name }));
    try {
      const updated = await api<Playlist>(`/playlists/${list.id}/tracks`, {
        method: 'POST',
        body: JSON.stringify({ version: list.version, track_ids: [track.id] }),
      });
      updateList(updated);
      setNotice(t('library.addedTo', { name: list.name }));
    } catch (reason) {
      setNotice(reason instanceof ApiError ? reason.message : t('library.addFailed'));
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
    setNotice(direction ? t('library.savingOrder') : t('library.removing'));
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
      setNotice(direction ? t('library.orderUpdated') : t('library.removedFromPlaylist'));
    } catch (reason) {
      setResult((current) => (current?.page === optimistic?.page ? before : current));
      setNotice(reason instanceof ApiError ? reason.message : t('library.playlistChangeReverted'));
      setCollectionRevision((value) => value + 1);
    } finally {
      playlistPending.current.delete(list.id);
    }
  }
  function collectionPath() {
    const parameters = new URLSearchParams({ q: album ? '' : query, include_unavailable: 'true' });
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
    setNotice(download ? t('library.preparingOffline') : t('library.loadingFullQueue'));
    try {
      const collection = await collectTracks(collectionPath(), controller.signal);
      if (target && trackUnavailableReason(target)) {
        throw new Error(
          t('library.trackUnavailable', {
            title: target.title,
            reason: trackUnavailableReason(target),
          }),
        );
      }
      const tracks = collection.filter((track) => !trackUnavailableReason(track));
      if (!tracks.length) throw new Error(t('library.noPlayableTracks'));
      if (controller.signal.aborted) return;
      if (download) {
        await saveDownloads(tracks);
        setNotice(t('library.offlineAdded', { count: tracks.length }));
      } else {
        const index = target ? tracks.findIndex((t) => t.id === target.id) : 0;
        if (index < 0) throw new Error(t('library.trackRemovedFromCollection'));
        player.start(tracks, index);
        setNotice(t('library.fullQueueReady', { count: tracks.length }));
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setNotice(e instanceof Error ? e.message : t('library.fullCollectionFailed'));
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
        .then(() => setNotice(t('library.offlineDownloadAdded')))
        .catch((e) => setNotice(e instanceof Error ? e.message : t('library.offlineSaveFailed')));
    },
    playlists: catalog.filter((item) => item.kind === 'manual'),
    onAdd: addToPlaylist,
    onCreate: (track) => setEditor({ initial: null, track }),
    onEdit: canManage ? setEditingTrack : undefined,
    onFileInfo: setViewingFileTrack,
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
        setNotice(t('library.playlistCreatedAddFailed'));
      }
    }
    setEditor(null);
    setCollectionRevision((value) => value + 1);
    openPlaylist(selected);
  }
  async function deletePlaylist(target = activePlaylist) {
    if (!target || !confirm(t('library.deletePlaylistConfirm', { name: target.name }))) return;
    try {
      await api(`/playlists/${target.id}?version=${target.version}`, {
        method: 'DELETE',
      });
      switchView('playlists');
      followPlaylist(currentUser.id, target.id, false);
      setCollectionRevision((value) => value + 1);
    } catch (reason) {
      setNotice(reason instanceof ApiError ? reason.message : t('library.playlistDeleteFailed'));
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
      setNotice(t('library.bulkAdded', { name: list.name }));
      setBulkTarget('');
    } catch (reason) {
      setNotice(reason instanceof ApiError ? reason.message : t('library.bulkAddFailed'));
    } finally {
      setBulkBusy(false);
    }
  }
  const title =
    album?.title ||
    activePlaylist?.name ||
    selectedArtist?.name ||
    (query
      ? t('collection.searchResults')
      : view === 'tracks'
        ? t('collection.tracks')
        : t(`views.${view}`));
  const subtitle = album
    ? `${selectedArtist?.name || album.artists.join(' / ') || t('library.unknownArtist')} · ${time(album.duration_ms / 1000)}`
    : selectedArtist
      ? t('library.artistSubtitle', {
          albums: selectedArtist.album_count,
          tracks: selectedArtist.track_count,
          duration: time(selectedArtist.duration_ms / 1000),
        })
      : activePlaylist
        ? t('library.playlistSubtitle', {
            count: activePlaylist.track_count,
            duration: time(activePlaylist.duration_ms / 1000),
          })
        : query
          ? `“${query}”`
          : '';
  const nav = (target: View) => (
    <button
      key={target}
      className={`nav-button ${view === target && !manageOpen && !accountOpen ? 'nav-current' : ''}`}
      onClick={() => switchView(target)}
    >
      <span className="nav-icon" aria-hidden="true">
        <Icon name={viewIcons[target]} />
      </span>
      <span className="nav-label">{t(`views.${target}`)}</span>
      {target === 'notifications' && inbox.unread > 0 ? (
        <small className="notification-count" aria-label={t('nav.unread', { count: inbox.unread })}>
          {inbox.unread > 99 ? '99+' : inbox.unread}
        </small>
      ) : null}
    </button>
  );
  const headingCover =
    album?.cover_track_id || selectedArtist?.cover_track_id || activePlaylist?.cover_track_id;
  return (
    <>
      <div className="app-shell" inert={lyricsOpen} aria-hidden={lyricsOpen || undefined}>
        <aside className="sidebar">
          <Brand onClick={() => switchView('discover')} />
          <nav aria-label={t('nav.main')} className="sidebar-navigation">
            <p className="sidebar-group-label">{t('nav.discoverGroup')}</p>
            {(['discover', 'podcasts', 'assistant'] as View[]).map(nav)}
            <p className="sidebar-group-label">{t('nav.library')}</p>
            {(
              [
                'tracks',
                'albums',
                'artists',
                'playlists',
                'favorites',
                'listening',
                'offline',
              ] as View[]
            ).map(nav)}
            <details
              className="sidebar-group"
              open={['drafts', 'tasks'].includes(view) || undefined}
            >
              <summary>{t('nav.assistantTools')}</summary>
              {(['drafts', 'tasks'] as View[]).map(nav)}
            </details>
          </nav>
          <div className="sidebar-bottom">
            {canManage && (
              <button
                className={`nav-button manage-entry ${manageOpen ? 'nav-current' : ''}`}
                onClick={() => openManagement()}
              >
                <span className="nav-icon" aria-hidden="true">
                  <Icon name="settings" />
                </span>
                <span className="nav-label">{t('nav.manage')}</span>
              </button>
            )}
            <button
              className={`nav-button account-entry ${accountOpen ? 'nav-current' : ''}`}
              onClick={() => openPersonalSettings()}
            >
              <span className="nav-icon" aria-hidden="true">
                <AccountAvatar user={currentUser} />
              </span>
              <span className="nav-label">{t('nav.account')}</span>
            </button>
            <div className="sidebar-bottom-actions">
              <ThemeToggleCompact />
              <button className="text-button logout-link" onClick={logout} title={t('nav.logout')}>
                {t('nav.logoutArrow')}
              </button>
            </div>
          </div>
        </aside>
        {manageOpen && (
          <Management
            key={
              ['overview', 'tracks', 'intake', 'jobs', 'library-settings'].includes(managementTab)
                ? selectedLibrary()
                : 'instance-management'
            }
            initialTab={managementTab}
            onTabChanged={(tab) => {
              setManagementTab(tab);
              setManagementAction(null);
            }}
            revision={revision}
            onBack={() => {
              setManageOpen(false);
              setManagementAction(null);
            }}
            onEdit={setEditingTrack}
            onChanged={refreshLibrary}
            onRefresh={() =>
              setMetadataRefresh({ scope: 'library', label: t('library.entireLibrary') })
            }
            onOpenConnections={openModelConnections}
            onViewPodcast={(id) => {
              setFocusPodcastId(id);
              switchView('podcasts');
            }}
            profile={profile}
            initialAction={managementAction}
          />
        )}
        {accountOpen && (
          <PersonalSettings
            key={connectionSettingsRevision}
            user={currentUser}
            player={player}
            initialSection={settingsLocation.section}
            initialAssistantTab={settingsLocation.assistantTab}
            onUserChange={setCurrentUser}
            onBack={() => setAccountOpen(false)}
            onPodcasts={() => switchView('podcasts')}
          />
        )}
        <main className={`library ${album ? 'is-album' : ''}`} hidden={manageOpen || accountOpen}>
          <header className={`topbar ${specialView ? 'topbar-context' : ''}`}>
            <div>
              <span className="mobile-brand">{t('nav.mobileBrand')}</span>
              <button className="mobile-logout text-button" onClick={logout}>
                {t('nav.logout')}
              </button>
            </div>
            <select
              className="mobile-section"
              aria-label={t('nav.browseMode')}
              value={view}
              onChange={(event) =>
                event.target.value === 'manage'
                  ? openManagement()
                  : event.target.value === 'account'
                    ? openPersonalSettings()
                    : switchView(event.target.value as View)
              }
            >
              {(Object.keys(labels) as View[])
                .filter((target) => target !== 'devices' && target !== 'assistant-settings')
                .map((target) => (
                  <option key={target} value={target}>
                    {t(`views.${target}`)}
                  </option>
                ))}
              {canManage && <option value="manage">{t('nav.manage')}</option>}
              <option value="account">{t('nav.account')}</option>
            </select>
            <div className="topbar-actions">
              <LibrarySwitcher onChanged={refreshLibrary} visible={!specialView} />
              {!specialView && (
                <form className="search" onSubmit={search} role="search" autoComplete="off">
                  <label className="sr-only" htmlFor="search">
                    {t('nav.searchLabel')}
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
                        ? t('nav.searchArtists')
                        : playlistGrid
                          ? t('nav.searchPlaylists')
                          : selectedArtist
                            ? t('nav.searchInArtist', { name: selectedArtist.name })
                            : t('nav.searchAll')
                    }
                    maxLength={256}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <button type="submit" aria-label={t('nav.search')}>
                    ↵
                  </button>
                </form>
              )}
              <button
                className={`notification-entry icon-button ${view === 'notifications' ? 'selected' : ''}`}
                aria-label={t('views.notifications')}
                data-help={
                  inbox.unread ? t('nav.unread', { count: inbox.unread }) : t('views.notifications')
                }
                onClick={() => switchView('notifications')}
              >
                <Icon name="bell" />
                {inbox.unread > 0 && (
                  <span aria-hidden="true" className="notification-corner-count">
                    {inbox.unread > 99 ? '99+' : inbox.unread}
                  </span>
                )}
              </button>
            </div>
          </header>
          {view === 'discover' && (
            <Discover
              playlists={operations.playlists}
              onOpenAlbum={operations.onOpenAlbum!}
              player={player}
              favorites={favorites}
              onConnections={openModelConnections}
              onSaved={(list) => {
                setCollectionRevision((v) => v + 1);
                setNotice(t('library.savedName', { name: list.name }));
              }}
            />
          )}
          {view === 'offline' && (
            <OfflinePanel
              player={player}
              onSettings={() => openPersonalSettings('downloads')}
              onBrowse={() => switchView('tracks')}
            />
          )}
          <Suspense
            fallback={
              <p role="status" className="workspace-empty">
                {t('library.openingWorkspace')}
              </p>
            }
          >
            {view === 'podcasts' && (
              <PodcastsPage
                userId={currentUser.id}
                canEditPublishers={canManage}
                canManageSources={canImport}
                canManageResources={currentUser.profile === 'owner'}
                currentEpisodeId={
                  player.current?.podcast_id ? player.current.id.replace(/^podcast_ep_/, '') : null
                }
                isPlayingPodcast={Boolean(player.current?.podcast_id && player.playing)}
                queuedEpisodeIds={player.podcastQueueItems.map((item) => item.episode_id)}
                focusPodcastId={focusPodcastId}
                onFocusHandled={() => setFocusPodcastId(null)}
                onQueueTrack={(track, next) => {
                  if (next) return player.playNext(track);
                  if (!player.current) return player.playPodcastEpisode(track, false);
                  return player.enqueue(track);
                }}
                onPlayTrack={(track) => {
                  void player.playPodcastEpisode(track);
                  setNotice(t('library.playingPodcast', { title: track.title }));
                }}
                onPlayQueue={() => {
                  void player.playPodcastQueue();
                }}
                onRemoveQueuedEpisode={(id) => {
                  player.removePodcastQueueEpisode(id);
                }}
              />
            )}
            {view === 'assistant' && (
              <Assistant
                onDraft={(id) => openAgentItem('drafts', id)}
                onConnections={openModelConnections}
              />
            )}
            {view === 'drafts' && (
              <Drafts
                user={currentUser}
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
          </Suspense>
          <div hidden={specialView}>
            <section
              className={`collection-heading ${album || selectedArtist ? 'album-heading' : ''}`}
            >
              <div className="collection-heading-main">
                <div>
                  {(album || selectedArtist || playlist) && (
                    <button className="back-button text-button" onClick={backToLocation}>
                      ←{' '}
                      {navigation.at(-1)?.playerOpen
                        ? t('library.backToPlayer')
                        : album
                          ? selectedArtist
                            ? t('library.backToName', { name: selectedArtist.name })
                            : t('library.backToAlbum')
                          : selectedArtist
                            ? t('library.backToArtists')
                            : t('library.backToPlaylists')}
                    </button>
                  )}
                  <h1>{title}</h1>
                  {subtitle && <p className="muted">{subtitle}</p>}
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
              </div>
              <div className="collection-stat">
                {t(`collection.count.${kind}`, {
                  count: visible?.total ?? 0,
                  value: visible?.total ?? '—',
                })}
              </div>
            </section>
            {view === 'listening' && (
              <div className="listening-summary" aria-label={t('library.listeningStatsAria')}>
                <div>
                  <strong>{stats?.play_count ?? 0}</strong>
                  <span data-help={t('library.playCountHelp')}>{t('library.playCount')}</span>
                </div>
                <div>
                  <strong>{listeningTime(stats?.listened_ms || 0)}</strong>
                  <span>{t('library.totalListening')}</span>
                </div>
                <div>
                  <strong>{stats?.tracks_played ?? 0}</strong>
                  <span>{t('library.tracksPlayed')}</span>
                </div>
                <div>
                  <strong>{stats?.favorites ?? 0}</strong>
                  <span>{t('library.favoriteTracks')}</span>
                </div>
              </div>
            )}
            <div className="library-toolbar">
              <div className="toolbar-actions">
                {!album && (
                  <div
                    className="view-switch"
                    role="group"
                    aria-label={t('library.viewSwitchAria')}
                  >
                    <button
                      aria-pressed={
                        !artistGrid &&
                        !playlistGrid &&
                        !albumGrid &&
                        (view === 'tracks' || !!selectedArtist)
                      }
                      onClick={() => switchTab('tracks')}
                    >
                      {t('library.tabTracks')}
                    </button>
                    <button aria-pressed={albumGrid || !!album} onClick={() => switchTab('albums')}>
                      {t('library.tabAlbums')}
                    </button>
                    <button aria-pressed={artistGrid} onClick={() => switchView('artists')}>
                      {t('library.tabArtists')}
                    </button>
                    <button
                      aria-pressed={view === 'playlists' || view === 'favorites'}
                      onClick={() => switchView('playlists')}
                    >
                      {t('library.tabPlaylists')}
                    </button>
                  </div>
                )}
                {view === 'artists' && !album && (
                  <label className="artist-role">
                    {t('library.roleLabel')}{' '}
                    <select
                      aria-label={t('library.roleSelectAria')}
                      value={artistRole}
                      onChange={(e) => {
                        setArtistRole(e.target.value);
                        setSelectedArtist(null);
                        setAlbum(null);
                      }}
                    >
                      <option value="">{t('library.roleAll')}</option>
                      <option value="album_artist">{t('library.roleAlbumArtist')}</option>
                      <option value="artist">{t('library.roleArtist')}</option>
                      <option value="vocalist">{t('library.roleVocalist')}</option>
                      <option value="lyricist">{t('library.roleLyricist')}</option>
                      <option value="composer">{t('library.roleComposer')}</option>
                      <option value="arranger">{t('library.roleArranger')}</option>
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
                      ? t('library.preparing')
                      : album
                        ? t('library.playAlbum')
                        : selectedArtist
                          ? t('library.playArtist')
                          : activePlaylist
                            ? t('library.playPlaylist')
                            : t('library.playAll')}
                  </button>
                )}
                {kind === 'tracks' && (
                  <>
                    <details className="collection-menu">
                      <summary aria-label={t('library.collectionMoreAria')}>
                        <Icon name="more" />
                      </summary>
                      <div>
                        <button
                          disabled={loading || collectionBusy || !page?.items.length}
                          onClick={() => void completeCollection(undefined, true)}
                        >
                          <Icon name="download" />
                          {t('library.saveCollectionOffline')}
                        </button>
                        {album && canManage && (
                          <button
                            onClick={(event) => {
                              event.currentTarget.closest('details')?.removeAttribute('open');
                              setEditingAlbum(album);
                            }}
                          >
                            <Icon name="edit" />
                            {t('library.editAlbumAndCover')}
                          </button>
                        )}
                        {album && canImport && (
                          <button
                            onClick={(event) => {
                              event.currentTarget.closest('details')?.removeAttribute('open');
                              setLyricScanAlbum(album.id);
                            }}
                          >
                            {t('library.lyricTools')}
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
                            {t('library.refreshAlbumMetadata')}
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
                    {t('library.newPlaylist')}
                  </button>
                )}
                {activePlaylist && activePlaylist.kind !== 'favorites' && (
                  <>
                    <button onClick={() => setEditor({ initial: activePlaylist, track: null })}>
                      {t('library.editPlaylist')}
                    </button>
                    <button className="text-button" onClick={() => void deletePlaylist()}>
                      {t('library.deletePlaylist')}
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
                    {t('library.clearSearch')}
                  </button>
                )}
              </div>
              <button
                className="text-button"
                onClick={() => setRevision((value) => value + 1)}
                disabled={loading}
              >
                {loading ? t('library.loading') : t('library.refreshLibrary')}
              </button>
            </div>
            {localError && visible && (
              <div className="browse-error" role="alert">
                <span>{localError}</span>
                <button onClick={() => setError('')}>{t('library.close')}</button>
              </div>
            )}
            {page &&
              page.items.length > 0 &&
              operations.playlists.length > 0 &&
              !loading &&
              !error && (
                <details className="bulk-playlist-panel">
                  <summary>{t('library.bulkAddTitle')}</summary>
                  <div className="bulk-playlist">
                    <label>
                      <span>{t('library.bulkAddLabel')}</span>
                      <select
                        aria-label={t('library.bulkAddSelectAria')}
                        value={bulkTarget}
                        onChange={(event) => setBulkTarget(event.target.value)}
                      >
                        <option value="">{t('library.choosePlaylist')}</option>
                        {operations.playlists.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button disabled={!bulkTarget || bulkBusy} onClick={() => void bulkAdd()}>
                      {bulkBusy ? t('library.adding') : t('library.addLoaded')}
                    </button>
                  </div>
                </details>
              )}
            {error && !visible ? (
              <div className="empty" role="alert">
                <h2>{t('library.libraryUnavailable')}</h2>
                <p>{error}</p>
                <button
                  onClick={() => {
                    setError('');
                    browse.retry();
                  }}
                >
                  {t('library.reconnect')}
                </button>
              </div>
            ) : loading ? (
              albumLoading ? (
                <AlbumSkeleton />
              ) : (
                <div className="empty" role="status">
                  {t('library.loadingMusic')}
                </div>
              )
            ) : !visible?.items.length ? (
              <div className="empty">
                <span className="empty-symbol">≋</span>
                <h2>
                  {query
                    ? kind === 'artists'
                      ? t('library.noMatchArtists')
                      : kind === 'albums'
                        ? t('library.noMatchAlbums')
                        : kind === 'playlists'
                          ? t('library.noMatchPlaylists')
                          : t('library.noMatchTracks')
                    : activePlaylist?.kind === 'favorites'
                      ? t('library.emptyFavorites')
                      : activePlaylist?.kind === 'smart'
                        ? t('library.emptySmart')
                        : activePlaylist
                          ? t('library.emptyPlaylist')
                          : view === 'listening'
                            ? t('library.emptyListening')
                            : artistGrid
                              ? t('library.emptyArtists')
                              : t('library.emptyLibrary')}
                </h2>
                <p>
                  {query
                    ? t('library.noMatchHint')
                    : activePlaylist?.kind === 'favorites'
                      ? t('library.favoritesHint')
                      : activePlaylist?.kind === 'smart'
                        ? t('library.smartHint')
                        : activePlaylist
                          ? t('library.playlistHint')
                          : view === 'listening'
                            ? t('library.listeningHint')
                            : t('library.libraryHint')}
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
                      kind === 'tracks' ? t('library.loadPrevTracks') : kind === 'albums' ?
                      t('library.loadPrevAlbums') : t('library.loadPrevArtists')
                    </button>
                  )}
                </div>
                {kind === 'artists' ? (
                  <div className="artist-grid" aria-label={t('library.artistsGridAria')}>
                    {(visible as ArtistPage).items.map((item) => (
                      <button
                        className="artist-card"
                        key={item.id}
                        data-browse-id={item.id}
                        aria-label={t('library.viewArtistAria', { name: item.name })}
                        onClick={() => openArtist(item)}
                      >
                        <Cover trackId={item.cover_track_id} title={item.name} size={320} />
                        <strong>{item.name}</strong>
                        <small>
                          {t('library.artistCardStats', {
                            albums: item.album_count,
                            tracks: item.track_count,
                          })}
                        </small>
                      </button>
                    ))}
                  </div>
                ) : kind === 'playlists' ? (
                  <div className="playlist-grid" aria-label={t('library.playlistsGridAria')}>
                    {(visible as PlaylistPage).items.map((item) => (
                      <div className="playlist-tile" key={item.id}>
                        <button
                          className={`playlist-card ${item.kind}`}
                          key={item.id}
                          data-browse-id={item.id}
                          aria-label={t('library.openPlaylistAria', { name: item.name })}
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
                              ? t('library.kindFavorites')
                              : item.kind === 'smart'
                                ? t('library.kindSmart')
                                : t('library.kindManual')}{' '}
                            {t('library.playlistCardCount', { count: item.track_count })}
                          </span>
                        </button>
                        <button
                          className="playlist-menu-trigger icon-button"
                          aria-label={t('library.playlistActionsAria', { name: item.name })}
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
                  <div className="album-grid" aria-label={t('library.albumsGridAria')}>
                    {(visible as AlbumPage).items.map((item) => (
                      <div
                        className="album-card"
                        key={item.id}
                        data-browse-id={item.id}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setAlbumMenu({ item, x: event.clientX, y: event.clientY });
                        }}
                      >
                        <button
                          type="button"
                          className="album-card-action"
                          aria-label={t('library.albumActionsAria', { name: item.title })}
                          onClick={(event) => {
                            event.stopPropagation();
                            const rect = event.currentTarget.getBoundingClientRect();
                            setAlbumMenu({ item, x: rect.right - 220, y: rect.bottom + 4 });
                          }}
                        >
                          <Icon name="more" />
                        </button>
                        <button
                          className="album-card-main"
                          aria-label={t('library.openAlbumAria', { name: item.title })}
                          onClick={() => {
                            albumRequest.current?.abort();
                            rememberLocation();
                            window.scrollTo(0, 0);
                            setAlbumLoading(false);
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
                            {t('library.albumCardStats', {
                              count: item.track_count,
                              duration: time(item.duration_ms / 1000),
                            })}
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
                            : t('library.unknownArtist')}
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
                    <span>{t('library.loadingMore')}</span>
                  ) : browse.error ? (
                    <>
                      <span role="alert">{browse.error}</span>
                      <button onClick={browse.retry}>{t('library.retryLoad')}</button>
                    </>
                  ) : browse.hasNext ? (
                    <button onClick={() => void browse.loadNext()}>{t('library.loadMore')}</button>
                  ) : (
                    <span>{t('library.endOfList', { count: visible.total, unit })}</span>
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
                    {t('library.indexRetry')}
                  </button>
                )}
              </div>
            )}
          </div>
        </main>
        {queueOpen && (
          <button
            className="queue-dismiss-scrim"
            aria-label={t('library.closeQueueAria')}
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
          onOpenArtist={(name) => void openArtistName(name)}
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
      <PlaybackSync player={player} userId={currentUser.id} />
      <PodcastProgressDialog player={player} />
      {playlistMenu && (
        <PlaylistMenu
          playlist={playlistMenu.item}
          x={playlistMenu.x}
          y={playlistMenu.y}
          following={followedPlaylists(currentUser.id).includes(playlistMenu.item.id)}
          onClose={closePlaylistMenu}
          onOpen={() => {
            openPlaylist(playlistMenu.item);
            closePlaylistMenu();
          }}
          onEdit={() => {
            void api<Playlist>(`/playlists/${playlistMenu.item.id}?include_unavailable=true`)
              .then((initial) => setEditor({ initial, track: null }))
              .catch(() => setNotice(t('library.playlistLoadFailed')));
            closePlaylistMenu();
          }}
          onDelete={() => {
            void deletePlaylist(playlistMenu.item);
            closePlaylistMenu();
          }}
          onFollow={() => {
            const enabled = !followedPlaylists(currentUser.id).includes(playlistMenu.item.id);
            followPlaylist(currentUser.id, playlistMenu.item.id, enabled);
            setNotice(enabled ? t('library.autoDownloadOn') : t('library.autoDownloadOff'));
            closePlaylistMenu();
          }}
        />
      )}
      {albumMenu && (
        <AlbumMenu
          album={albumMenu.item}
          x={albumMenu.x}
          y={albumMenu.y}
          canManage={canManage}
          onClose={closeAlbumMenu}
          onOpen={() => {
            albumRequest.current?.abort();
            rememberLocation();
            window.scrollTo(0, 0);
            setAlbumLoading(false);
            setAlbum(albumMenu.item);
          }}
          onPlay={async () => {
            try {
              setNotice(t('library.loadingAlbumTracks', { title: albumMenu.item.title }));
              const tracks = await collectTracks(
                `/albums/${encodeURIComponent(albumMenu.item.id)}/tracks`,
              );
              if (tracks.length) {
                player.start(tracks, 0);
                setNotice(
                  t('library.playingAlbum', { title: albumMenu.item.title, count: tracks.length }),
                );
              }
            } catch (err) {
              setNotice(err instanceof Error ? err.message : t('library.albumPlayFailed'));
            }
          }}
          onEdit={() => {
            setEditingAlbum(albumMenu.item);
          }}
        />
      )}
      {editingAlbum && (
        <AlbumEditor
          albumId={editingAlbum.id}
          initialTitle={editingAlbum.title}
          onClose={() => setEditingAlbum(null)}
          onSaved={async (savedAlbumId?: string) => {
            refreshLibrary();
            setRevision((v) => v + 1);
            const targetId = savedAlbumId || editingAlbum.id;
            if (album && (album.id === editingAlbum.id || album.id === targetId)) {
              try {
                const updated = await api<Album>(`/albums/${encodeURIComponent(targetId)}`);
                setAlbum(updated);
              } catch {
                // ignore
              }
            }
            setNotice(t('library.albumSaved'));
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
      {viewingFileTrack && (
        <TrackFileInfoDialog
          track={viewingFileTrack}
          canManage={canManage}
          onClose={() => setViewingFileTrack(null)}
          onReorganized={() => {
            setRevision((v) => v + 1);
            setNotice(t('library.filesReorganized'));
          }}
        />
      )}
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
            setNotice(t('library.trackInfoSaved'));
          }}
        />
      )}
    </>
  );
}
