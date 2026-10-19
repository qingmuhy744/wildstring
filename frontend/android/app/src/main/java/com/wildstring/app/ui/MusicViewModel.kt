package com.wildstring.app.ui

import android.content.ComponentName
import android.content.Context
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import coil.ImageLoader
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import com.wildstring.app.data.*
import com.wildstring.app.playback.PlaybackService
import com.wildstring.app.playback.mediaItem
import javax.inject.Inject
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import retrofit2.HttpException
import java.io.IOException
import com.wildstring.app.playback.AudioCache

data class QueueRow(val entryId: String, val trackId: String, val title: String, val artist: String, val index: Int)
data class MusicState(
    val account: Account? = null, val playbackQuality: String = "", val connected: Boolean = false, val connecting: Boolean = false, val loading: Boolean = false,
    val server: String = "", val serverSelection: String = "", val localHttp: Boolean = false, val error: String? = null,
    val tab: String = "search", val kind: String = "discover", val title: String = "发现",
    val query: String = "", val offset: Int = 0, val total: Int = 0,
    val collection: String? = null, val collectionId: String? = null, val activePlaylist: Playlist? = null,
    val tracks: List<Track> = emptyList(), val albums: List<Album> = emptyList(),
    val artists: List<Artist> = emptyList(), val playlists: List<Playlist> = emptyList(),
    val current: Track? = null, val playing: Boolean = false, val buffering: Boolean = false,
    val position: Long = 0, val duration: Long = 0, val queue: List<QueueRow> = emptyList(),
    val entryId: String? = null, val repeatMode: Int = Player.REPEAT_MODE_OFF, val shuffle: Boolean = false,
    val playbackError: String? = null, val lyrics: Lyrics = Lyrics(), val lyricsLoading: Boolean = false,
    val lyricsError: String? = null, val offline: Boolean = false, val hasContent: Boolean = false,
    val role: String = "artist", val sort: String = "title", val albumFilter: String? = null, val collecting: Boolean = false,
    val contentKey: String = "", val canGoBack: Boolean = false, val navigationDepth: Int = 0,
    val window: CatalogWindow = CatalogWindow(), val rangeLoading: Set<Int> = emptySet(),
    val rangeErrors: Map<Int, String> = emptyMap(), val browseIndex: BrowseIndex? = null,

    val pendingFavorites: Set<String> = emptySet(), val mutationMessage: String? = null,
    val handoff: SharedPlayback? = null,
)

@HiltViewModel
class MusicViewModel @Inject constructor(
    val repository: Repository, val imageLoader: ImageLoader, val settings: AppSettings,
    val sharing: PlaybackSharing, val sleep: com.wildstring.app.playback.SleepTimer, val audioCache: AudioCache, val playbackHealth: com.wildstring.app.playback.PlaybackHealth, @ApplicationContext private val context: Context,
) : ViewModel() {
    val agent = AgentPlatform(repository)
    private var agentJob: Job? = null
    private var agentNetworkCallback: android.net.ConnectivityManager.NetworkCallback? = null
    private fun connectionState(error: String? = null) = MusicState(account = repository.session.account, server = repository.session.endpoint?.toString().orEmpty(), serverSelection = repository.session.requestState()?.selection.orEmpty(), localHttp = repository.session.localHttp, error = error)
    private val mutable = MutableStateFlow(connectionState())
    val state = mutable.asStateFlow()
    private val mutablePosition = MutableStateFlow(0L)
    val position = mutablePosition.asStateFlow()
    var controller: MediaController? = null
        private set
    private val controllerFuture = MediaController.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java))).buildAsync()
    private var selectionJob: Job? = null
    private var loadJob: Job? = null
    private var lyricJob: Job? = null
    private val rangeJobs = mutableMapOf<Int, Job>()
    private val windows = object : LinkedHashMap<String, CatalogWindow>(12, .75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, CatalogWindow>?) = size > 12
    }
    private val browseIndices = mutableMapOf<String, BrowseIndex>()
    private var progressJob: Job? = null
    private var handoffJob: Job? = null
    private var localPlaybackEpoch = 0L
    private var offlineSyncJob: Job? = null
    private val offlineSyncLock = kotlinx.coroutines.sync.Mutex()
    private val mutableOfflineSync = MutableStateFlow("")
    val offlineSyncStatus = mutableOfflineSync.asStateFlow()
    private var albumNavigationJob: Job? = null
    private var lyricTrack: String? = null
    private var invalidationMessage: String? = null
    private var supersededInvalidationSelection: String? = null
    @Volatile private var authGeneration = 0
    private var loadGeneration = 0L
    private val tabs = mutableMapOf<String, CatalogQuery>()
    private val history = mutableMapOf<String, ArrayDeque<CatalogQuery>>()
    private val favoriteJobs = mutableSetOf<String>()
    private val playlistJobs = mutableSetOf<String>()
    private val optimisticFavorites = mutableMapOf<String, Boolean>()
    private var queueSnapshot: List<QueueRow> = emptyList()
    private val pages = object : LinkedHashMap<String, CatalogPage>(24, .75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, CatalogPage>?) = size > 24
    }
    private fun query() = mutable.value.let { CatalogQuery(it.tab, it.kind, it.title, it.query, it.offset, it.collection, it.collectionId, it.activePlaylist, it.role, it.sort, it.albumFilter) }
    private fun MusicState.withPage(page: CatalogPage) = copy(tracks = page.tracks.map { track -> track.copy(loved = optimisticFavorites[track.id] ?: repository.knownTracks[track.id]?.loved ?: track.loved) }, albums = page.albums, artists = page.artists,
        playlists = page.playlists, total = page.total, hasContent = true)
    private fun MusicState.withWindow(value: CatalogWindow): MusicState {
        val ordered = value.pages.toSortedMap().values
        return withPage(CatalogPage(tracks = ordered.flatMap { it.tracks }, albums = ordered.flatMap { it.albums },
            artists = ordered.flatMap { it.artists }, playlists = ordered.flatMap { it.playlists }, total = value.total)).copy(window = value)
    }
    private fun cancelRanges() { rangeJobs.values.forEach { it.cancel() }; rangeJobs.clear() }
    suspend fun cacheUsage(): Triple<Long, Long, Long> = withContext(Dispatchers.IO) { val (metadata, art) = repository.cache.usage(); Triple(metadata, art, audioCache.bytes()) }
    fun clearCache() = viewModelScope.launch {
        val owner = repository.session.cacheScope()
        withContext(Dispatchers.IO) { repository.cache.clear(owner); audioCache.clear(owner) }
        if (owner == repository.session.cacheScope()) { pages.clear(); windows.clear(); browseIndices.clear(); cancelRanges(); imageLoader.memoryCache?.clear() }
    }
    private fun requireOwner(owner: String?) { if (owner == null || owner != repository.session.cacheScope()) throw CancellationException("服务器或账号已变化。") }
    private suspend fun invalidateCatalog(owner: String? = repository.session.cacheScope()) {
        requireOwner(owner); pages.clear(); windows.clear(); browseIndices.clear(); cancelRanges()
        withContext(Dispatchers.IO) { repository.cache.invalidateCatalog(owner) }
        requireOwner(owner)
    }

    private val playerListener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
            if (events.contains(Player.EVENT_TIMELINE_CHANGED) || events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION) || events.contains(Player.EVENT_MEDIA_METADATA_CHANGED)) {
                rebuildQueue()
            }
            refreshPlayer()
        }
    }

    init {
        viewModelScope.launch { repository.session.profiles.collect { agent.reset() } }
        controllerFuture.addListener({
            runCatching { controllerFuture.get() }.onSuccess { c -> controller = c; c.addListener(playerListener); rebuildQueue(); refreshPlayer() }
                .onFailure { mutable.update { it.copy(error = "播放器连接失败，请重新打开应用。") } }
        }, ContextCompat.getMainExecutor(context))
        viewModelScope.launch { repository.session.invalidations.collect { selection ->
            yield()
            if (selection == supersededInvalidationSelection || selection != repository.session.requestState()?.selection.orEmpty()) return@collect
            authGeneration++; optimisticFavorites.clear()
            loadGeneration++; loadJob?.cancel(); lyricJob?.cancel(); lyricTrack = null; pages.clear(); windows.clear(); browseIndices.clear(); cancelRanges(); tabs.clear(); history.clear(); repository.knownTracks.clear(); controller?.stop(); controller?.clearMediaItems()
            val message = invalidationMessage ?: "登录已失效，请重新登录。"
            invalidationMessage = null
            mutable.value = connectionState(message.takeIf { it.isNotBlank() })
            imageLoader.memoryCache?.clear()
        } }
        if (repository.session.endpoint != null) resumeServer()
    }

    private fun resumeServer() {
        selectionJob = viewModelScope.launch {
            val generation = authGeneration
            val selection = repository.session.requestState()?.selection
            fun requireSelection() { if (generation != authGeneration || selection != repository.session.requestState()?.selection) throw CancellationException("服务器已变化。") }
            val saved = repository.cachedCatalog(CatalogQuery())
                ?: repository.cachedCatalog(CatalogQuery(tab = "library", kind = "albums", title = "曲库"))
                ?: repository.downloads.entries.value.filter { it.state == "complete" }.map { it.track }.takeIf { it.isNotEmpty() }?.let { CatalogPage(tracks = it, total = it.size) }
            requireSelection()
            if (saved != null && repository.session.cacheScope() != null) {
                mutable.update { it.withWindow(CatalogWindow(mapOf(0 to saved))).copy(connected = true, offline = true, contentKey = query().key) }
                pages[query().key] = saved
            } else mutable.update { it.copy(connecting = true) }
            try {
                val status = repository.status()
                requireSelection()
                if (status.authenticated) {
                    val changed = repository.acceptAccount(status.user)
                    if (generation != authGeneration) throw CancellationException("服务器已变化。")
                    if (changed) {
                        pages.clear(); windows.clear(); browseIndices.clear(); cancelRanges(); controller?.stop(); controller?.clearMediaItems()
                        mutable.update { connectionState().copy(account = status.user, connected = true) }
                    }
                    mutable.update { it.copy(connected = true, offline = false, account = status.user) }; load()
                } else repository.session.invalidate()
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (generation == authGeneration) mutable.update { it.copy(error = if (it.connected && e is IOException) null else friendlyError(e), offline = it.connected) } }
            finally { if (generation == authGeneration) mutable.update { it.copy(connecting = false) } }
        }
    }

    fun observeProgress(visible: Boolean) {
        observeAgent(visible)
        progressJob?.cancel()
        if (visible) progressJob = viewModelScope.launch { while (isActive) { refreshPlayer(); delay(500) } }
        handoffJob?.cancel()
        if (visible) handoffJob = viewModelScope.launch {
            while (isActive) {
                if (mutable.value.connected) { runCatching { checkSharedPlayback() }; delay(15_000) }
                else delay(500)
            }
        }
        offlineSyncJob?.cancel()
        if (visible) offlineSyncJob = viewModelScope.launch {
            while (isActive) {
                if (mutable.value.connected) runCatching { syncOfflinePlaylists() }
                delay(60_000)
            }
        }
    }
    private fun observeAgent(visible: Boolean) {
        agentJob?.cancel()
        val manager = context.getSystemService(android.net.ConnectivityManager::class.java)
        agentNetworkCallback?.let { runCatching { manager.unregisterNetworkCallback(it) } }
        agentNetworkCallback = null
        if (!visible) return
        agentJob = viewModelScope.launch {
            combine(state.map { it.connected }.distinctUntilChanged(), repository.session.profiles) { connected, owner -> connected to owner }
                .distinctUntilChanged().collectLatest { (connected, owner) ->
                if (!connected || owner == null) return@collectLatest
                var first = true
                while (isActive) {
                    agent.refreshInbox(force = first); first = false; delay(300_000)
                }
            }
        }
        val callback = object : android.net.ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: android.net.Network) { viewModelScope.launch { if (mutable.value.connected) agent.refreshInbox(force = true) } }
        }
        runCatching { manager.registerDefaultNetworkCallback(callback); agentNetworkCallback = callback }
    }
    private suspend fun stopForServerChange() {
        // A pending expiry must not cancel an explicit reconnect while its first IO is suspended.
        // A later expiry rotates the selection token and remains actionable.
        supersededInvalidationSelection = repository.session.requestState()?.selection.orEmpty()
        val generation = ++authGeneration
        invalidationMessage = null
        loadGeneration++; optimisticFavorites.clear(); favoriteJobs.clear(); playlistJobs.clear()
        loadJob?.cancel(); lyricJob?.cancel(); lyricTrack = null; pages.clear(); windows.clear(); browseIndices.clear(); cancelRanges(); tabs.clear(); history.clear()
        repository.client.dispatcher.cancelAll(); repository.downloads.pauseAll(); sleep.cancel()
        controller?.stop(); controller?.clearMediaItems(); repository.knownTracks.clear(); queueSnapshot = emptyList()
        withContext(Dispatchers.IO) { repository.database.queue().clear() }
        if (generation != authGeneration) throw CancellationException("服务器已变化。")
        imageLoader.memoryCache?.clear()
    }
    fun switchServer(id: String) {
        if (id == repository.session.activeServerId && mutable.value.connected) return
        selectionJob?.cancel()
        selectionJob = viewModelScope.launch {
            stopForServerChange()
            repository.session.selectServer(id)
            repository.downloads.switchScope()
            mutable.value = connectionState()
            resumeServer()
        }
    }
    suspend fun saveServer(id: String?, url: String, name: String, localHttp: Boolean): ServerConfiguration {
        val old = repository.session.servers.value.firstOrNull { it.id == id }
        val canonical = ServerAddress.normalize(url, com.wildstring.app.BuildConfig.DEBUG && localHttp).toString()
        require(repository.session.servers.value.none { it.url == canonical && it.id != id }) { "这个服务器已经保存，请直接选择。" }
        val changedActive = id != null && id == repository.session.activeServerId && old?.url != canonical
        if (changedActive) { selectionJob?.cancel(); stopForServerChange() }
        val saved = repository.session.saveServer(id, url, name, localHttp)
        if (changedActive) { repository.downloads.switchScope(); mutable.value = connectionState() }
        return saved
    }
    fun deleteServer(id: String) {
        if (id != repository.session.activeServerId) {
            repository.session.removeServer(id)
            return
        }
        selectionJob?.cancel()
        selectionJob = viewModelScope.launch {
            stopForServerChange()
            repository.session.removeServer(id)
            repository.downloads.switchScope()
            mutable.value = connectionState()
        }
    }
    fun connect(server: String, username: String, password: String, localHttp: Boolean): Job {
        selectionJob?.cancel()
        return viewModelScope.launch {
            var generation = authGeneration
            try {
                ServerAddress.normalize(server, com.wildstring.app.BuildConfig.DEBUG && localHttp)
                stopForServerChange(); repository.session.configure(server, localHttp)
                repository.session.write(null)
                repository.downloads.switchScope()
                generation = authGeneration
                mutable.value = connectionState().copy(connecting = true)
                val status = repository.status()
                if (generation != authGeneration) throw CancellationException("服务器已变化。")
                check(status.configured) { "请先在服务端初始化管理员。" }
                repository.api().login(LoginRequest(username.trim(), password)).close()
                val authenticated = repository.status()
                if (generation != authGeneration) throw CancellationException("服务器已变化。")
                check(authenticated.authenticated) { "登录未成功，请重试。" }
                repository.acceptAccount(authenticated.user)
                if (generation != authGeneration) return@launch
                mutable.value = connectionState().copy(account = authenticated.user, connected = true)
                load()
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (generation == authGeneration) mutable.update { it.copy(error = if (e is HttpException && e.code() == 401) "账号或密码不正确。" else if (e is IllegalStateException) e.message else friendlyError(e)) } }
            finally { if (generation == authGeneration) mutable.update { it.copy(connecting = false) } }
        }.also { selectionJob = it }
    }
    fun logout(): Job {
        selectionJob?.cancel()
        return viewModelScope.launch {
            stopForServerChange()
            val generation = authGeneration
            invalidationMessage = ""
            runCatching { repository.logout() }
            if (generation == authGeneration) mutable.value = connectionState()
        }.also { selectionJob = it }
    }

    suspend fun changePassword(current: String, next: String) {
        repository.changePassword(current, next)
        invalidationMessage = "密码已修改，请重新登录。"
        repository.session.invalidate()
    }
    fun refreshLyrics() {
        val id = mutable.value.current?.id ?: return
        lyricJob?.cancel()
        lyricJob = viewModelScope.launch {
            mutable.update { it.copy(lyricsLoading = true, lyricsError = null) }
            try { val lyrics = repository.lyrics(id); if (lyricTrack == id) mutable.update { it.copy(lyrics = lyrics) } }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (lyricTrack == id) mutable.update { it.copy(lyricsError = friendlyError(e)) } }
            finally { if (lyricTrack == id) mutable.update { it.copy(lyricsLoading = false) } }
        }
    }

    fun navigate(tab: String) {
        if (tab == mutable.value.tab) return
        tabs[mutable.value.tab] = query()
        val target = tabs[tab] ?: CatalogQuery(tab = tab, kind = if (tab == "mine") "playlists" else if (tab == "search") "discover" else "albums",
            title = when (tab) { "mine" -> "我的"; "search" -> "发现"; else -> "曲库" })
        show(target)
    }
    fun browseAlbums() {
        if (mutable.value.tab != "library") tabs[mutable.value.tab] = query()
        history.remove("library")
        show(CatalogQuery(tab = "library", kind = "albums", title = "曲库"))
    }
    private fun show(target: CatalogQuery, delayMs: Long = 0) {
        val target = target.copy(offset = 0)
        val savedWindow = windows[target.key] ?: pages[target.key]?.let { CatalogWindow(mapOf(0 to it)) }
        mutable.update { current ->
            val next = current.copy(tab = target.tab, kind = target.kind, title = target.title, query = target.query, offset = target.offset,
                collection = target.collection, collectionId = target.collectionId, activePlaylist = target.playlist, role = target.role, sort = target.sort, albumFilter = target.albumFilter,
                contentKey = target.key, canGoBack = history[target.tab]?.isNotEmpty() == true,
                navigationDepth = history[target.tab]?.size ?: 0, error = null,
                window = CatalogWindow(), rangeLoading = emptySet(), rangeErrors = emptyMap(), browseIndex = browseIndices[target.key],
                tracks = emptyList(), albums = emptyList(), artists = emptyList(), playlists = emptyList(), total = 0, hasContent = false, loading = true)
            if (savedWindow == null) next else next.withWindow(savedWindow)
        }
        load(delayMs, preserveWindow = true)
    }
    fun back() { history[mutable.value.tab]?.removeLastOrNull()?.let { show(it) } }
    private fun open(target: CatalogQuery) {
        history.getOrPut(mutable.value.tab) { ArrayDeque() }.apply { if (size >= 20) removeFirst(); addLast(query()) }
        show(target)
    }
    fun kind(kind: String) { if (kind != mutable.value.kind) show(query().copy(kind = kind, offset = 0, sort = "title")) }
    fun role(value: String) { show(query().copy(role = value, offset = 0)) }
    fun sort(value: String) { show(query().copy(sort = value, offset = 0)) }
    fun search(query: String) {
        show(this.query().copy(kind = if (query.isBlank()) "discover" else "tracks", query = query.take(256), offset = 0,
            title = "发现", collection = null, collectionId = null, playlist = null), 300)
    }
    fun openAlbum(album: Album) = open(if (mutable.value.collection == "artists") query().copy(kind = "tracks", albumFilter = album.id, title = album.title, query = "", offset = 0, sort = "title")
        else query().copy(kind = "tracks", collection = "albums", collectionId = album.id, title = album.title, query = "", offset = 0, playlist = null, albumFilter = null, sort = "title"))
    fun cancelAlbumNavigation() { albumNavigationJob?.cancel() }
    fun openTrackAlbum(track: Track, fromPlayer: Boolean = false, onOpened: () -> Unit = {}) {
        albumNavigationJob?.cancel()
        albumNavigationJob = viewModelScope.launch {
            val owner = repository.session.cacheScope()
            val generation = authGeneration
            val catalogGeneration = loadGeneration
            try {
                // Older queue/cache entries have no album ID; refresh the track before navigating.
                val current = if (track.albumId.isNullOrBlank()) repository.track(track.id) else track
                requireOwner(owner)
                if (generation != authGeneration || catalogGeneration != loadGeneration) return@launch
                val id = current.albumId?.takeIf { it.isNotBlank() }
                if (id == null) {
                    mutable.update { it.copy(error = "暂时无法读取所属专辑，请联网刷新歌曲后重试。") }
                    return@launch
                }
                // Open the whole album, clearing any artist/playlist/search constraints.
                val destination = query().copy(kind = "tracks", collection = "albums", collectionId = id,
                    title = current.album ?: "未知专辑", query = "", offset = 0, playlist = null,
                    albumFilter = null, sort = "title")
                // Resolve the first page before dismissing the player. A failed lookup leaves it visible.
                val first = repository.catalog(destination)
                requireOwner(owner)
                if (generation != authGeneration || catalogGeneration != loadGeneration) return@launch
                pages[destination.key] = first
                windows[destination.key] = CatalogWindow(mapOf(0 to first))
                if (fromPlayer || destination.key != query().key) open(destination)
                onOpened()
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (generation == authGeneration && catalogGeneration == loadGeneration && owner == repository.session.cacheScope())
                    mutable.update { it.copy(error = friendlyError(e)) }
            }
        }
    }
    fun openArtist(artist: Artist) = open(query().copy(kind = "tracks", albumFilter = null, collection = "artists", collectionId = artist.id, title = artist.name, query = "", offset = 0, playlist = null))
    fun openPlaylist(playlist: Playlist) = open(query().copy(kind = "tracks", collection = "playlists", collectionId = playlist.id, playlist = playlist, title = playlist.name, query = "", offset = 0))
    fun recent() = open(query().copy(kind = "recent", title = "最近听过", collection = null, collectionId = null, offset = 0, query = "",
        sort = "last_played_at", playlist = null, albumFilter = null))

    fun load(delayMs: Long = 0, preserveWindow: Boolean = false) {
        loadJob?.cancel(); cancelRanges()
        val generation = ++loadGeneration
        val request = query().copy(offset = 0)
        val owner = repository.session.cacheScope()
        if (!preserveWindow) { windows.remove(request.key); browseIndices.remove(request.key) }
        loadJob = viewModelScope.launch {
            if (!mutable.value.connected) return@launch
            mutable.update { it.copy(loading = true, error = null, rangeErrors = emptyMap(), rangeLoading = emptySet(), browseIndex = if (preserveWindow) it.browseIndex else null, contentKey = request.key) }
            try {
                if (!mutable.value.hasContent) repository.cachedCatalog(request)?.let { cached ->
                    if (generation == loadGeneration) {
                        val window = CatalogWindow(mapOf(0 to cached)); windows[request.key] = window
                        pages[request.key] = cached; mutable.update { it.withWindow(window) }
                    }
                }
                delay(delayMs)
                val result = repository.catalog(request)
                requireOwner(owner)
                if (generation == loadGeneration) {
                    val previous = windows[request.key]
                    val window = if (previous != null && previous.total == result.total) previous.withPage(0, result) else CatalogWindow(mapOf(0 to result))
                    pages[request.key] = result; windows[request.key] = window
                    mutable.update { it.withWindow(window).copy(offline = false) }
                }
                if (request.indexed) {
                    try {
                        val index = repository.browseIndex(request)
                        if (generation == loadGeneration && owner == repository.session.cacheScope() && index?.total == mutable.value.total) {
                            browseIndices[request.key] = index; mutable.update { it.copy(browseIndex = index) }
                        }
                    } catch (e: CancellationException) { throw e }
                    catch (_: Exception) { /* Basic browsing remains available when the index is unavailable. */ }
                }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (generation == loadGeneration) mutable.update { it.copy(offline = e is IOException,
                    error = if (e is IOException && e !is javax.net.ssl.SSLException && it.hasContent) null else friendlyError(e)) }
            } finally { if (generation == loadGeneration) mutable.update { it.copy(loading = false) } }
        }
    }

    /** Fetch only missing visible slices; failures require explicit retry and never spin in a loop. */
    fun ensureRange(index: Int, retry: Boolean = false) {
        val current = mutable.value
        if (current.loading || current.kind == "discover" || index !in 0 until current.total) return
        val offset = index / CATALOG_PAGE_SIZE * CATALOG_PAGE_SIZE
        if (current.window.pages.containsKey(offset) || offset in rangeJobs || (!retry && offset in current.rangeErrors)) return
        val request = query().copy(offset = offset)
        val generation = loadGeneration
        val owner = repository.session.cacheScope()
        val job = viewModelScope.launch(start = CoroutineStart.LAZY) {
            mutable.update { it.copy(rangeLoading = it.rangeLoading + offset, rangeErrors = it.rangeErrors - offset) }
            try {
                val cached = if (current.offline) repository.cachedCatalog(request) else null
                val page = cached ?: repository.catalog(request)
                requireOwner(owner)
                if (generation != loadGeneration) return@launch
                require(page.total == mutable.value.total) { "曲库已变化，请刷新列表。" }
                require(page.itemCount == minOf(CATALOG_PAGE_SIZE, page.total - offset)) { "列表读取不完整，请重试。" }
                val window = mutable.value.window.withPage(offset, page)
                windows[query().key] = window
                mutable.update { it.withWindow(window).copy(offline = cached != null && current.offline) }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (generation == loadGeneration && owner == repository.session.cacheScope())
                    mutable.update { it.copy(rangeErrors = it.rangeErrors + (offset to friendlyError(e))) }
            } finally {
                if (generation == loadGeneration) {
                    rangeJobs.remove(offset)
                    mutable.update { it.copy(rangeLoading = it.rangeLoading - offset) }
                }
            }
        }
        rangeJobs[offset] = job
        job.start()
    }

    fun deviceId() = sharing.deviceId
    fun syncMode(value: String) { sharing.mode(value); if (value == "off") mutable.update { it.copy(handoff = null) } }
    suspend fun checkSharedPlayback(): Unit = withContext(Dispatchers.Main.immediate) {
        if (sharing.mode.value == "off") return@withContext
        val c = controller ?: return@withContext
        if (c.isPlaying || c.playWhenReady) return@withContext
        val owner = repository.session.cacheScope(); requireOwner(owner)
        val epoch = localPlaybackEpoch
        val saved = repository.api().sharedPlayback(RequestOwner(owner)); requireOwner(owner)
        if (epoch != localPlaybackEpoch || c.isPlaying || c.playWhenReady) return@withContext
        val currentOffer = mutable.value.handoff
        val samePause = currentOffer != null && currentOffer.pauseEvent() == saved.pauseEvent()
        if (!saved.isRecentPausedHandoff() || saved.deviceId == sharing.deviceId || saved.version <= sharing.lastSeen()) {
            mutable.update { it.copy(handoff = null) }; return@withContext
        }
        if (samePause) { mutable.update { it.copy(handoff = saved) }; return@withContext }
        if (!saved.canOfferHandoff(sharing.deviceId, sharing.lastSeen(), sharing.lastOfferedPause())) {
            mutable.update { it.copy(handoff = null) }; return@withContext
        }
        if (sharing.mode.value == "auto") resumeShared(saved, requirePausedHandoff = true)
        else if (sharing.mode.value == "ask") {
            sharing.pauseOffered(saved)
            mutable.update { it.copy(handoff = saved) }
        }
    }
    fun dismissHandoff() { mutable.value.handoff?.let { sharing.pauseOffered(it); sharing.seen(it.version) }; mutable.update { it.copy(handoff = null) } }
    suspend fun acceptHandoff() {
        val offer = mutable.value.handoff ?: return
        val owner = repository.session.cacheScope(); requireOwner(owner)
        val saved = repository.api().sharedPlayback(RequestOwner(owner)); requireOwner(owner)
        if (!saved.isRecentPausedHandoff() || offer.pauseEvent() != saved.pauseEvent()) {
            mutable.update { it.copy(handoff = null) }; return
        }
        mutable.update { it.copy(handoff = saved) }
        resumeShared(saved, requirePausedHandoff = true)
        mutable.update { it.copy(handoff = null) }
    }
    suspend fun sharePlayback(): SharedPlayback = withContext(Dispatchers.Main.immediate) {
        val c = controller ?: throw IOException("播放器尚未连接。")
        val snapshot = SharedPlayback(trackIds = queueSnapshot.map { it.trackId }, index = c.currentMediaItemIndex.coerceAtLeast(0),
            positionMs = c.currentPosition.coerceAtLeast(0), playbackState = if (c.playbackState == Player.STATE_ENDED) "ended" else if (c.playWhenReady) "playing" else "paused", mode = if (c.shuffleModeEnabled) "shuffle" else when(c.repeatMode) {
                Player.REPEAT_MODE_ONE -> "repeat_one"; Player.REPEAT_MODE_ALL -> "repeat_all"; else -> "sequential"
            })
        sharing.publish(snapshot, claim = true) ?: throw IOException("尚无可同步的播放。")
    }
    suspend fun resumeShared(saved: SharedPlayback, requirePausedHandoff: Boolean = false): Unit = withContext(Dispatchers.Main.immediate) {
        require(saved.trackIds.size <= 5000) { "共享队列超过本机 5000 首上限。" }
        val owner = repository.session.cacheScope()
        val epoch = localPlaybackEpoch
        val tracks = saved.trackIds.chunked(8).flatMap { batch -> coroutineScope { batch.map { async { repository.track(it) } }.awaitAll() } }
        check(owner != null && owner == repository.session.cacheScope()) { "会话已变化。" }
        requireOwner(owner)
        val latest = repository.api().sharedPlayback(RequestOwner(owner)); requireOwner(owner)
        if (requirePausedHandoff && (!latest.isRecentPausedHandoff() || latest.pauseEvent() != saved.pauseEvent())) {
            mutable.update { it.copy(handoff = null) }
            throw IOException("其他设备已恢复播放，或暂停记录已过期。")
        }
        if (latest.version != saved.version) throw IOException("其他设备的进度已更新，请重新读取后继续。")
        check(epoch == localPlaybackEpoch && controller?.playWhenReady != true) { "本机播放已变化，请重新读取后继续。" }
        sharing.pauseOffered(saved)
        sharing.acceptRemote(saved.version)
        play(tracks, saved.index, autoplay = false, positionMs = saved.positionMs)
        controller?.shuffleModeEnabled = saved.mode == "shuffle"
        controller?.repeatMode = when(saved.mode) { "repeat_one" -> Player.REPEAT_MODE_ONE; "repeat_all", "shuffle" -> Player.REPEAT_MODE_ALL; else -> Player.REPEAT_MODE_OFF }
    }
    fun play(tracks: List<Track>, index: Int = 0, autoplay: Boolean = true, positionMs: Long = 0) {
        val c = controller ?: return
        if (tracks.isEmpty()) return
        require(tracks.size <= 5000) { "播放队列最多 5000 首。" }
        // Media3 transports bundle lists with a retriever; smaller additions also bound each transaction.
        tracks.forEach { repository.rememberPlaybackTrack(it) }
        val items = tracks.map { it.mediaItem(repository) }
        val previous = (0 until c.mediaItemCount).map { c.getMediaItemAt(it) }
        localPlaybackEpoch++
        val previousIndex = c.currentMediaItemIndex; val position = c.currentPosition; val previousAutoplay = c.playWhenReady
        try {
            val batches = items.chunked(100)
            c.setMediaItems(batches.first(), 0, 0)
            batches.drop(1).forEach { c.addMediaItems(it) }
            c.seekTo(index.coerceIn(tracks.indices), positionMs.coerceAtLeast(0)); c.prepare(); c.playWhenReady = autoplay; refreshPlayer()
        } catch (e: Exception) {
            if (previous.isNotEmpty()) { c.setMediaItems(previous.take(100), 0, 0); previous.drop(100).chunked(100).forEach { c.addMediaItems(it) }; c.seekTo(previousIndex, position); c.prepare(); c.playWhenReady = previousAutoplay }
            else c.clearMediaItems()
            mutable.update { it.copy(error = "队列未能更新，已保留原播放。") }
        }
    }
    fun playCollection(startId: String? = null, onStarted: () -> Unit = {}) = viewModelScope.launch {
        if (mutable.value.collecting) return@launch
        val request = query()
        val profile = repository.session.cacheScope()
        mutable.update { it.copy(collecting = true, mutationMessage = "正在准备完整播放列表…") }
        try {
            val tracks = repository.collectionTracks(request)
            if (profile != repository.session.cacheScope()) return@launch
            if (tracks.isEmpty()) { mutable.update { it.copy(mutationMessage = "集合中没有可播放的音乐") }; return@launch }
            play(tracks, startId?.let { id -> tracks.indexOfFirst { it.id == id }.coerceAtLeast(0) } ?: 0)
            mutable.update { it.copy(mutationMessage = "已载入 ${tracks.size} 首歌曲") }; onStarted()
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { mutable.update { it.copy(error = friendlyError(error), mutationMessage = null) } }
        finally { mutable.update { it.copy(collecting = false) } }
    }
    fun download(tracks: List<Track>): Boolean = runCatching {
        repository.downloads.enqueue(tracks); startDownloads(); notify("已加入离线保存任务"); true
    }.getOrElse { error -> mutable.update { it.copy(error = friendlyError(error), mutationMessage = null) }; false }
    fun startDownloads() { ContextCompat.startForegroundService(context, android.content.Intent(context, com.wildstring.app.playback.DownloadService::class.java)) }
    suspend fun allPlaylists(): List<Playlist> {
        val owner = repository.session.cacheScope(); requireOwner(owner)
        val result = mutableListOf<Playlist>(); var offset = 0
        while (true) {
            val page = repository.api().playlists(limit = 100, offset = offset); requireOwner(owner)
            result += page.items; offset += page.items.size
            if (offset >= page.total || page.items.isEmpty()) break
        }
        return result
    }
    fun followPlaylist(playlist: Playlist, enabled: Boolean) {
        repository.downloads.followPlaylist(playlist.id, enabled)
        notify(if (enabled) "已开启歌单自动下载" else "已关闭歌单自动下载，离线音乐保留")
        viewModelScope.launch { runCatching { syncOfflinePlaylists() } }
    }
    suspend fun syncOfflinePlaylists() {
        if (!offlineSyncLock.tryLock()) return
        try {
            val owner = repository.session.cacheScope(); requireOwner(owner)
            if (!repository.downloads.networkAllowed()) {
                mutableOfflineSync.value = "等待 Wi-Fi，返回应用后自动检查。"; return
            }
            repository.downloads.resumeNetworkWaiting()
            val selected = repository.downloads.followedPlaylists()
            if (selected.isNotEmpty()) mutableOfflineSync.value = "正在同步已选歌单…"
            for (id in selected) {
                val tracks = try { repository.collectionTracks(CatalogQuery(collection = "playlists", collectionId = id)) }
                    catch (e: HttpException) { if (e.code() == 404) { requireOwner(owner); repository.downloads.followPlaylist(id, false); continue } else throw e }
                requireOwner(owner)
                if (id in repository.downloads.followedPlaylists()) repository.downloads.enqueue(tracks, automatic = true)
            }
            requireOwner(owner)
            if (repository.downloads.entries.value.any { it.state == "queued" }) startDownloads()
            mutableOfflineSync.value = if (selected.isEmpty()) "" else "歌单已检查，新歌曲会自动保存；已下载文件保留。"
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { mutableOfflineSync.value = friendlyError(e); throw e }
        finally { offlineSyncLock.unlock() }
    }
    fun downloadCollection() = viewModelScope.launch {
        if (mutable.value.collecting) return@launch
        mutable.update { it.copy(collecting = true, mutationMessage = "正在准备离线保存…") }
        try { download(repository.collectionTracks(query())) }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { mutable.update { it.copy(error = friendlyError(e)) } }
        finally { mutable.update { it.copy(collecting = false) } }
    }
    fun notify(message: String) { mutable.update { it.copy(mutationMessage = message) } }
    fun acknowledgeMessage(message: String) { mutable.update { if (it.mutationMessage == message) it.copy(mutationMessage = null) else it } }
    fun toggle() { localPlaybackEpoch++; controller?.let { if (it.playWhenReady) it.pause() else { if (it.playbackState == Player.STATE_IDLE) it.prepare(); it.play() } } }
    fun seek(ms: Long) { localPlaybackEpoch++; controller?.seekTo(ms.coerceAtLeast(0)) }
    fun next() {
        localPlaybackEpoch++
        val c = controller ?: return
        if (!c.hasNextMediaItem()) return
        mutable.value.current?.id?.let { id -> val profile = repository.session.cacheScope(); viewModelScope.launch {
            runCatching { repository.api().recommendationFeedback(RecommendationFeedback(trackId = id, action = "skip"), RequestOwner(profile)).close() }
        } }
        c.seekToNextMediaItem()
    }
    fun previous() { localPlaybackEpoch++; controller?.seekToPreviousMediaItem() }
    fun cycleMode() { localPlaybackEpoch++; controller?.let { c ->
        when { c.shuffleModeEnabled -> { c.shuffleModeEnabled = false; c.repeatMode = Player.REPEAT_MODE_OFF }
            c.repeatMode == Player.REPEAT_MODE_OFF -> c.repeatMode = Player.REPEAT_MODE_ALL
            c.repeatMode == Player.REPEAT_MODE_ALL -> c.repeatMode = Player.REPEAT_MODE_ONE
            else -> { c.repeatMode = Player.REPEAT_MODE_ALL; c.shuffleModeEnabled = true } }
    } }
    fun addToQueue(track: Track, next: Boolean = false) {
        localPlaybackEpoch++
        controller?.let { c ->
            if (c.mediaItemCount >= 5000) { mutable.update { it.copy(error = "播放队列最多 5000 项。") }; return }
            if (c.mediaItemCount == 0) play(listOf(track))
            else if (next) c.addMediaItem(c.currentMediaItemIndex + 1, track.mediaItem(repository))
            else c.addMediaItem(track.mediaItem(repository))
        }
    }
    fun playQueue(index: Int) { localPlaybackEpoch++; controller?.let { it.seekToDefaultPosition(index); it.prepare(); it.play() } }
    fun removeQueue(index: Int) { localPlaybackEpoch++; controller?.removeMediaItem(index) }
    fun moveQueue(entryId: String, toIndex: Int) {
        localPlaybackEpoch++
        controller?.let { c ->
            val from = (0 until c.mediaItemCount).firstOrNull { c.getMediaItemAt(it).mediaId == entryId } ?: return
            if (toIndex in 0 until c.mediaItemCount && from != toIndex) c.moveMediaItem(from, toIndex)
        }
    }
    private fun showFavorite(track: Track) {
        val published = repository.publishFavorite(track)
        mutable.update { s -> s.copy(current = if (s.current?.id == track.id) published else s.current,
            tracks = s.tracks.map { if (it.id == track.id) it.copy(loved = track.loved) else it }) }
    }
    fun favorite(track: Track) = viewModelScope.launch {
        val profile = repository.session.cacheScope()
        val key = "$profile:${track.id}"
        if (!favoriteJobs.add(key)) return@launch
        val generation = authGeneration
        val previous = repository.knownTracks[track.id] ?: track
        optimisticFavorites[track.id] = !previous.loved
        showFavorite(previous.copy(loved = !previous.loved))
        mutable.update { it.copy(pendingFavorites = it.pendingFavorites + track.id) }
        try {
            val updated = repository.favorite(previous)
            if (generation != authGeneration || profile != repository.session.cacheScope()) return@launch
            showFavorite(updated)
            invalidateCatalog()
        }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) {
            if (generation == authGeneration && profile == repository.session.cacheScope()) {
                showFavorite(previous)
                mutable.update { it.copy(error = "收藏未保存，已恢复。${friendlyError(e)}") }
            }
        }
        finally {
            favoriteJobs.remove(key)
            if (generation == authGeneration && profile == repository.session.cacheScope()) {
                optimisticFavorites.remove(track.id)
                mutable.update { it.copy(pendingFavorites = it.pendingFavorites - track.id) }
            }
        }
    }
    fun createPlaylist(name: String) = viewModelScope.launch {
        val generation = authGeneration
        val profile = repository.session.cacheScope()
        if (!playlistJobs.add("create")) return@launch
        mutable.update { it.copy(mutationMessage = "正在建立歌单…") }
        try {
            repository.api().createPlaylist(PlaylistRequest(name.trim()))
            if (generation == authGeneration && profile == repository.session.cacheScope()) {
                invalidateCatalog(); tabs.remove("mine")
                mutable.update { it.copy(mutationMessage = "歌单已建立") }
                if (mutable.value.tab == "mine") load() else navigate("mine")
            }
        }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { if (generation == authGeneration && profile == repository.session.cacheScope()) mutable.update { it.copy(mutationMessage = null, error = friendlyError(e)) } }
        finally { playlistJobs.remove("create") }
    }
    fun renamePlaylist(playlist: Playlist, name: String) = viewModelScope.launch {
        if (!playlistJobs.add(playlist.id)) return@launch
        val generation = authGeneration
        val profile = repository.session.cacheScope()
        fun apply(value: Playlist) { mutable.update { s -> s.copy(
            activePlaylist = if (s.activePlaylist?.id == value.id) value else s.activePlaylist,
            title = if (s.activePlaylist?.id == value.id) value.name else s.title,
            playlists = s.playlists.map { if (it.id == value.id) value else it }) } }
        apply(playlist.copy(name = name.trim()))
        try {
            val updated = repository.api().renamePlaylist(repository.url("api", "v1", "playlists", playlist.id), RenamePlaylist(name.trim(), playlist.version))
            if (generation == authGeneration && profile == repository.session.cacheScope()) { apply(updated); invalidateCatalog() }
        }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { if (generation == authGeneration && profile == repository.session.cacheScope()) { apply(playlist); mutable.update { it.copy(error = "歌单未保存，已恢复。${friendlyError(e)}") } } }
        finally { playlistJobs.remove(playlist.id) }
    }
    suspend fun playlistsForAdd(): List<Playlist> {
        val owner = repository.session.cacheScope(); requireOwner(owner)
        val result = mutableListOf<Playlist>(); var offset = 0
        while (true) { val page = repository.api().playlists(limit = 100, offset = offset); requireOwner(owner); result += page.items.filter { it.kind == "manual" }; offset += page.items.size; if (offset >= page.total || page.items.isEmpty()) break }
        return result
    }
    suspend fun addTracksToPlaylist(tracks: List<Track>, playlist: Playlist) {
        val owner = repository.session.cacheScope(); requireOwner(owner)
        repository.api().addTracks(repository.url("api", "v1", "playlists", playlist.id, "tracks"), AddTracks(playlist.version, tracks.map { it.id }.distinct()))
        requireOwner(owner); invalidateCatalog(owner); load(); notify("已加入：${playlist.name}")
    }
    suspend fun savePlaylist(name: String, definition: com.google.gson.JsonObject?, existing: Playlist?) {
        val owner = repository.session.cacheScope(); requireOwner(owner)
        if (existing == null) repository.api().createPlaylist(PlaylistRequest(name, if (definition == null) "manual" else "smart", definition))
        else repository.api().updatePlaylist(repository.url("api", "v1", "playlists", existing.id), PlaylistUpdate(name, existing.version, definition, existing.kind))
        requireOwner(owner); invalidateCatalog(owner); load(); notify("歌单已保存")
    }
    suspend fun deletePlaylist(playlist: Playlist) {
        val owner = repository.session.cacheScope(); requireOwner(owner)
        repository.api().deletePlaylist(repository.url("api", "v1", "playlists", playlist.id), playlist.version).let { if (!it.isSuccessful) throw HttpException(it) }
        requireOwner(owner); repository.downloads.followPlaylist(playlist.id, false); invalidateCatalog(owner)
        if (mutable.value.collectionId == playlist.id) back() else load()
        notify("歌单已删除")
    }
    suspend fun removePlaylistTrack(track: Track, playlist: Playlist) {
        val owner = repository.session.cacheScope(); requireOwner(owner)
        repository.api().removeTrack(repository.url("api", "v1", "playlists", playlist.id, "tracks", track.id), playlist.version).close()
        requireOwner(owner)
        val fresh = repository.api().playlist(repository.url("api", "v1", "playlists", playlist.id))
        requireOwner(owner); mutable.update { if (it.collectionId == playlist.id) it.copy(activePlaylist = fresh) else it }; invalidateCatalog(owner); load(); notify("已从歌单移除")
    }
    suspend fun playlistTracks(playlist: Playlist) = repository.collectionTracks(CatalogQuery(collection = "playlists", collectionId = playlist.id))
    suspend fun reorderPlaylist(playlist: Playlist, ids: List<String>) {
        val owner = repository.session.cacheScope(); requireOwner(owner)
        val fresh = repository.api().reorderPlaylist(repository.url("api", "v1", "playlists", playlist.id, "order"), AddTracks(playlist.version, ids))
        requireOwner(owner); mutable.update { it.copy(activePlaylist = fresh) }; invalidateCatalog(owner); load(); notify("歌单顺序已保存")
    }
    fun addToPlaylist(track: Track, playlist: Playlist) = viewModelScope.launch {
        if (!playlistJobs.add(playlist.id)) return@launch
        val generation = authGeneration
        val profile = repository.session.cacheScope()
        mutable.update { it.copy(mutationMessage = "正在加入：${playlist.name}") }
        try {
            repository.api().addTracks(repository.url("api", "v1", "playlists", playlist.id, "tracks"), AddTracks(playlist.version, listOf(track.id)))
            if (generation == authGeneration && profile == repository.session.cacheScope()) {
                invalidateCatalog(); mutable.update { it.copy(mutationMessage = "已加入：${playlist.name}") }
                if (mutable.value.tab == "mine") load()
            }
        }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { if (generation == authGeneration && profile == repository.session.cacheScope()) mutable.update { it.copy(mutationMessage = null, error = friendlyError(e)) } }
        finally { playlistJobs.remove(playlist.id) }
    }
    private fun rebuildQueue() {
        val c = controller
        queueSnapshot = if (c == null) emptyList() else (0 until c.mediaItemCount).map { i -> val m = c.getMediaItemAt(i); QueueRow(m.mediaId, m.mediaMetadata.extras?.getString("track_id").orEmpty(), m.mediaMetadata.title?.toString().orEmpty(), m.mediaMetadata.artist?.toString().orEmpty(), i) }
    }
    private fun refreshPlayer() {
        val c = controller ?: return
        val item = c.currentMediaItem
        val id = item?.mediaMetadata?.extras?.getString("track_id")
        val track = id?.let { repository.knownTracks[it] }?.let { t -> optimisticFavorites[t.id]?.let { t.copy(loved = it) } ?: t }
        val queue = queueSnapshot
        mutablePosition.value = c.currentPosition.coerceAtLeast(0)
        mutable.update { it.copy(current = track, playing = c.isPlaying, buffering = c.playbackState == Player.STATE_BUFFERING,
            duration = c.duration.takeIf { d -> d > 0 } ?: track?.durationMs ?: 0,
            queue = queue, playbackQuality = c.mediaMetadata.description?.toString().orEmpty(), entryId = item?.mediaId, repeatMode = c.repeatMode, shuffle = c.shuffleModeEnabled,
            playbackError = c.playerError?.let { error -> generateSequence<Throwable>(error) { it.cause }.filterIsInstance<com.wildstring.app.playback.PlaybackResolutionException>().firstOrNull()?.message
                ?: "无法播放这首歌，请检查连接或音频编码后重试。" }) }
        if (id != lyricTrack) {
            lyricTrack = id; lyricJob?.cancel()
            mutable.update { it.copy(lyrics = Lyrics(), lyricsLoading = id != null, lyricsError = null) }
            if (id != null) lyricJob = viewModelScope.launch {
                try {
                    repository.cachedLyrics(id)?.let { cached -> if (lyricTrack == id) mutable.update { it.copy(lyrics = cached, lyricsLoading = false) } }
                    val lyrics = repository.lyrics(id)
                    if (lyricTrack == id) mutable.update { it.copy(lyrics = lyrics) }
                }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) { if (lyricTrack == id) mutable.update { it.copy(lyricsError = if (it.lyrics.lines.isNotEmpty() && e is IOException) null else friendlyError(e)) } }
                finally { if (lyricTrack == id) mutable.update { it.copy(lyricsLoading = false) } }
            }
        }
    }
    override fun onCleared() {
        agentNetworkCallback?.let { callback -> runCatching { context.getSystemService(android.net.ConnectivityManager::class.java).unregisterNetworkCallback(callback) } }
        controller?.removeListener(playerListener); MediaController.releaseFuture(controllerFuture); super.onCleared()
    }
}
