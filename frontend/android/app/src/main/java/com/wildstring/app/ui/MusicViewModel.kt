package com.wildstring.app.ui

import com.wildstring.app.AppLanguage
import com.wildstring.app.R
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
    val tab: String = "search", val kind: String = "discover", val title: String = AppLanguage.string(R.string.vm_title_discover),
    val query: String = "", val offset: Int = 0, val total: Int = 0,
    val collection: String? = null, val collectionId: String? = null, val activePlaylist: Playlist? = null,
    val tracks: List<Track> = emptyList(), val albums: List<Album> = emptyList(),
    val addedTracks: List<Track> = emptyList(),
    val artists: List<Artist> = emptyList(), val playlists: List<Playlist> = emptyList(),
    val current: Track? = null, val playing: Boolean = false, val buffering: Boolean = false,
    val position: Long = 0, val duration: Long = 0, val queue: List<QueueRow> = emptyList(),
    val entryId: String? = null, val repeatMode: Int = Player.REPEAT_MODE_OFF, val shuffle: Boolean = false,
    val playbackError: String? = null, val lyrics: Lyrics = Lyrics(), val lyricsLoading: Boolean = false,
    val lyricsError: String? = null, val offline: Boolean = false, val hasContent: Boolean = false,
    val discs: List<DiscSummary> = emptyList(), val order: String = "asc", val role: String = "album_artist", val sort: String = "title", val albumFilter: String? = null, val collecting: Boolean = false,
    val contentKey: String = "", val canGoBack: Boolean = false, val navigationDepth: Int = 0,
    val window: CatalogWindow = CatalogWindow(), val rangeLoading: Set<Int> = emptySet(),
    val rangeErrors: Map<Int, String> = emptyMap(), val browseIndex: BrowseIndex? = null,

    val pendingFavorites: Set<String> = emptySet(), val mutationMessage: String? = null,
    val handoff: SharedPlayback? = null, val serverVersion: String? = null,
    val podcastId: String? = null,
    val libraries: List<MusicLibrary> = emptyList(), val selectedLibraryId: String = "all", val librariesSupported: Boolean = false,
)

@HiltViewModel
class MusicViewModel @Inject constructor(
    val repository: Repository, val imageLoader: ImageLoader, val settings: AppSettings,
    val sharing: PlaybackSharing, val podcastProgress: PodcastProgress, val sleep: com.wildstring.app.playback.SleepTimer, val audioCache: AudioCache, val playbackHealth: com.wildstring.app.playback.PlaybackHealth, @ApplicationContext private val context: Context,
) : ViewModel() {
    /** Player-only landscape the user asked for; most phones keep system auto-rotate off. Reset when the player collapses. */
    val playerLandscape = MutableStateFlow(false)
    val agent = AgentPlatform(repository)
    private var agentJob: Job? = null
    private var agentNetworkCallback: android.net.ConnectivityManager.NetworkCallback? = null
    private fun connectionState(error: String? = null) = MusicState(account = repository.session.account, server = repository.session.endpoint?.toString().orEmpty(), serverSelection = repository.session.requestState()?.selection.orEmpty(), localHttp = repository.session.localHttp, error = error)
    private val mutable = MutableStateFlow(connectionState())
    val state = mutable.asStateFlow()
    val podcastBrowser = PodcastBrowser(viewModelScope, repository.session::cacheScope,
        repository::podcasts, repository::cachedPodcastDetail, repository::podcastDetail,
        repository::refreshPodcast, repository::refreshAllPodcasts)
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
    private var pendingSeekTargetMs: Long? = null
    private var pendingSeekAtElapsedMs = 0L
    private var lastPositionEntryId: String? = null
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
    private fun query() = mutable.value.let { CatalogQuery(it.tab, it.kind, it.title, it.query, it.offset, it.collection, it.collectionId, it.activePlaylist, it.role, it.sort, it.albumFilter, it.order, repository.selectedLibraryId) }
    private fun MusicState.withPage(page: CatalogPage) = copy(tracks = page.tracks.map { track -> track.copy(loved = optimisticFavorites[track.id] ?: repository.knownTracks[track.id]?.loved ?: track.loved) }, albums = page.albums, artists = page.artists,
        addedTracks = page.addedTracks.orEmpty(), playlists = page.playlists, total = page.total, discs = page.discs.orEmpty(), hasContent = true)
    private fun MusicState.withWindow(value: CatalogWindow): MusicState {
        val ordered = value.pages.toSortedMap().values
        return withPage(CatalogPage(tracks = ordered.flatMap { it.tracks }, albums = ordered.flatMap { it.albums },
            artists = ordered.flatMap { it.artists }, playlists = ordered.flatMap { it.playlists }, addedTracks = ordered.flatMap { it.addedTracks.orEmpty() }, total = value.total, discs = ordered.firstOrNull()?.discs)).copy(window = value)
    }
    private fun cancelRanges() { rangeJobs.values.forEach { it.cancel() }; rangeJobs.clear() }
    suspend fun cacheUsage(): Triple<Long, Long, Long> = withContext(Dispatchers.IO) { val (metadata, art) = repository.cache.usage(); Triple(metadata, art, audioCache.bytes()) }
    fun clearCache() = viewModelScope.launch {
        val owner = repository.session.cacheScope()
        withContext(Dispatchers.IO) { repository.cache.clear(owner); audioCache.clear(owner) }
        if (owner == repository.session.cacheScope()) { pages.clear(); windows.clear(); browseIndices.clear(); cancelRanges(); podcastBrowser.reset(); imageLoader.memoryCache?.clear() }
    }
    private fun requireOwner(owner: String?) { if (owner == null || owner != repository.session.cacheScope()) throw CancellationException(AppLanguage.string(R.string.vm_server_or_account_changed)) }
    private suspend fun invalidateCatalog(owner: String? = repository.session.cacheScope()) {
        requireOwner(owner); pages.clear(); windows.clear(); browseIndices.clear(); cancelRanges()
        withContext(Dispatchers.IO) { repository.cache.invalidateCatalog(owner) }
        requireOwner(owner)
    }

    private val podcastQueues = PodcastQueueController(
        repository, settings, context, viewModelScope, { deviceId() }, { controller },
        { preparePodcastAdvance() },
        { tracks, index, position, autoplay -> play(tracks, index, autoplay = autoplay, positionMs = position, preserveQueue = false) },
        { owner -> requireOwner(owner) },
        { podcastProgress.positions.value },
    )
    val podcastCloud = podcastQueues.state

    private val playerListener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
            if (events.contains(Player.EVENT_TIMELINE_CHANGED) || events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION) || events.contains(Player.EVENT_MEDIA_METADATA_CHANGED)) {
                rebuildQueue()
                podcastQueues.refreshAutoPreview()
            }
            refreshPlayer()
        }
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            podcastQueues.refreshAutoPreview()
            if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_AUTO || mediaItem == null) return
            val c = controller ?: return
            val index = c.currentMediaItemIndex
            if (index <= 0) return
            val previousId = podcastEpisodeId(c.getMediaItemAt(index - 1).mediaMetadata.extras?.getString("track_id")) ?: return
            if (podcastEpisodeId(mediaItem.mediaMetadata.extras?.getString("track_id")) == null) return
            // Media3 already moved on. Drop the finished episode from the cloud queue only.
            podcastQueues.onEpisodeFinished(previousId, advanceLocally = false)
            podcastQueues.refreshAutoPreview()
        }
        override fun onPlaybackStateChanged(playbackState: Int) {
            // STATE_ENDED only arrives when nothing is queued after the current episode.
            if (playbackState == Player.STATE_ENDED) onPodcastPlaybackEnded()
        }
    }

    init {
        settings.bindAccount(repository.session.activeServerId, repository.session.account?.id)
        viewModelScope.launch { state.map { it.connected to it.account?.id }.distinctUntilChanged().collect { (connected, _) -> if (connected) refreshLibraries() } }
        viewModelScope.launch { repository.libraryAccessChanges.collect { refreshLibraries(recheck = true) } }
        viewModelScope.launch { repository.session.profiles.collect {
            settings.bindAccount(repository.session.activeServerId, repository.session.account?.id)
            agent.reset(); podcastBrowser.reset(); podcastQueues.reset()
        } }
        controllerFuture.addListener({
            runCatching { controllerFuture.get() }.onSuccess { c -> controller = c; c.addListener(playerListener); rebuildQueue(); refreshPlayer() }
                .onFailure { mutable.update { it.copy(error = AppLanguage.string(R.string.vm_player_connection_failed)) } }
        }, ContextCompat.getMainExecutor(context))
        viewModelScope.launch { repository.session.invalidations.collect { selection ->
            yield()
            if (selection == supersededInvalidationSelection || selection != repository.session.requestState()?.selection.orEmpty()) return@collect
            authGeneration++; optimisticFavorites.clear()
            loadGeneration++; loadJob?.cancel(); lyricJob?.cancel(); lyricTrack = null; pages.clear(); windows.clear(); browseIndices.clear(); cancelRanges(); tabs.clear(); history.clear(); repository.knownTracks.clear(); controller?.stop(); controller?.clearMediaItems()
            val message = invalidationMessage ?: AppLanguage.string(R.string.vm_login_expired)
            invalidationMessage = null
            mutable.value = connectionState(message.takeIf { it.isNotBlank() })
            imageLoader.memoryCache?.clear()
        } }
        viewModelScope.launch { repository.connectionRoutes.changes.collect {
            imageLoader.memoryCache?.clear()
            mutable.update { it.copy(connected = true, offline = false, error = null) }
            load()
        } }
        if (repository.session.endpoint != null) resumeServer()
    }

    private fun resumeServer() {
        selectionJob = viewModelScope.launch {
            val generation = authGeneration
            val selection = repository.session.requestState()?.selection
            fun requireSelection() { if (generation != authGeneration || selection != repository.session.requestState()?.selection) throw CancellationException(AppLanguage.string(R.string.vm_server_changed)) }
            val saved = repository.cachedCatalog(CatalogQuery())
                ?: repository.cachedCatalog(CatalogQuery(tab = "library", kind = "albums", title = AppLanguage.string(R.string.vm_title_library)))
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
                    if (generation != authGeneration) throw CancellationException(AppLanguage.string(R.string.vm_server_changed))
                    if (changed) {
                        pages.clear(); windows.clear(); browseIndices.clear(); cancelRanges(); controller?.stop(); controller?.clearMediaItems()
                        mutable.update { connectionState().copy(account = status.user, connected = true) }
                    }
                    mutable.update { it.copy(connected = true, offline = false, account = status.user, serverVersion = status.version) }; load()
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
        if (generation != authGeneration) throw CancellationException(AppLanguage.string(R.string.vm_server_changed))
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
        val canonical = ServerAddress.normalize(url, localHttp).toString()
        require(repository.session.servers.value.none { it.url == canonical && it.id != id }) { AppLanguage.string(R.string.vm_server_already_saved) }
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
                ServerAddress.normalize(server, localHttp)
                stopForServerChange(); repository.session.configure(server, localHttp)
                repository.session.write(null)
                repository.downloads.switchScope()
                generation = authGeneration
                mutable.value = connectionState().copy(connecting = true)
                val status = repository.status()
                if (generation != authGeneration) throw CancellationException(AppLanguage.string(R.string.vm_server_changed))
                check(status.configured) { AppLanguage.string(R.string.vm_init_admin_first) }
                repository.api().login(LoginRequest(username.trim(), password)).close()
                val authenticated = repository.status()
                if (generation != authGeneration) throw CancellationException(AppLanguage.string(R.string.vm_server_changed))
                check(authenticated.authenticated) { AppLanguage.string(R.string.vm_login_failed) }
                repository.acceptAccount(authenticated.user)
                if (generation != authGeneration) return@launch
                mutable.value = connectionState().copy(account = authenticated.user, connected = true, serverVersion = authenticated.version)
                load()
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (generation == authGeneration) mutable.update { it.copy(error = if (e is HttpException && e.code() == 401) AppLanguage.string(R.string.vm_invalid_credentials) else if (e is IllegalStateException) e.message else friendlyError(e)) } }
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

    suspend fun updateProfile(username: String, displayName: String, email: String) {
        val updated = repository.updateProfile(username, displayName, email)
        mutable.update { it.copy(account = updated) }
    }

    suspend fun updateLanguage(language: String) {
        val updated = repository.updateLanguage(language)
        mutable.update { it.copy(account = updated) }
    }

    suspend fun changePassword(current: String, next: String) {
        repository.changePassword(current, next)
        invalidationMessage = AppLanguage.string(R.string.vm_password_changed_relogin)
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
        val target = tabs[tab] ?: CatalogQuery(
            tab = tab,
            kind = when (tab) {
                "mine" -> "playlists"
                "search" -> "discover"
                "podcast" -> "podcast"
                "assistant" -> "assistant"
                else -> "albums"
            },
            title = when (tab) {
                "mine" -> AppLanguage.string(R.string.vm_title_mine)
                "search" -> AppLanguage.string(R.string.vm_title_discover)
                "podcast" -> AppLanguage.string(R.string.vm_title_podcast)
                "assistant" -> AppLanguage.string(R.string.vm_title_assistant)
                else -> AppLanguage.string(R.string.vm_title_music)
            }
        )
        show(target)
    }

    fun refreshLibraries(recheck: Boolean = false) = viewModelScope.launch {
        val owner = repository.session.cacheScope()
        try {
            val libraries = repository.libraries()
            requireOwner(owner)
            val allowed = libraries.map { it.id }.toSet()
            val old = mutable.value
            val revoked = old.libraries.any { it.id !in allowed }
            val changed = repository.selectedLibraryId != "all" && repository.selectedLibraryId !in allowed
            if (changed) repository.selectLibrary("all")
            fun permitted(track: Track?) = track?.let { it.isPodcast || (it.libraryId?.let(allowed::contains) ?: libraries.any(MusicLibrary::isDefault)) } ?: libraries.any(MusicLibrary::isDefault)
            val forbidden = repository.knownTracks.values.filterNot(::permitted).map { it.id }.toSet()
            controller?.let { player ->
                if (!permitted(old.current)) player.pause()
                for (index in player.mediaItemCount - 1 downTo 0) {
                    val identity = player.getMediaItemAt(index).mediaId
                    if (podcastEpisodeId(identity) == null && (identity in forbidden || !permitted(repository.knownTracks[identity]))) player.removeMediaItem(index)
                }
            }
            repository.knownTracks.keys.removeAll(forbidden)
            for (entry in repository.downloads.entries.value) if (!permitted(entry.track)) repository.downloads.remove(entry.track.id)
            mutable.update { it.copy(libraries = libraries, librariesSupported = true, selectedLibraryId = repository.selectedLibraryId) }
            if (revoked || changed || recheck || !old.librariesSupported) {
                loadGeneration++; loadJob?.cancel(); albumNavigationJob?.cancel()
                invalidateCatalog(owner)
                if (revoked || forbidden.isNotEmpty()) {
                    withContext(Dispatchers.IO) { repository.cache.clear(owner) }
                    requireOwner(owner)
                    imageLoader.memoryCache?.clear()
                }
                tabs.clear(); history.clear()
                mutable.update { it.copy(tracks = emptyList(), albums = emptyList(), artists = emptyList(), total = 0, hasContent = false,
                    collection = null, collectionId = null, albumFilter = null) }
                load()
            }
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { /* Older servers retain their single-library UI. */ }
    }

    fun togglePodcastFollow(podcast: PodcastSummary) = viewModelScope.launch {
        val owner = repository.session.cacheScope()
        try {
            val followed = repository.followPodcast(podcast.id, !podcast.followed)
            requireOwner(owner)
            podcastBrowser.followed(podcast.id, followed)
            notify(if (followed) AppLanguage.string(R.string.vm_followed_podcast) else AppLanguage.string(R.string.vm_unfollowed_podcast))
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { notify(friendlyError(e)) }
    }

    fun selectLibrary(id: String) = viewModelScope.launch {
        if (id != "all" && mutable.value.libraries.none { it.id == id }) return@launch
        if (repository.selectedLibraryId == id) return@launch
        repository.selectLibrary(id)
        loadGeneration++; loadJob?.cancel(); albumNavigationJob?.cancel()
        invalidateCatalog()
        tabs.clear(); history.clear()
        mutable.update { it.copy(selectedLibraryId = id, tracks = emptyList(), albums = emptyList(), artists = emptyList(), hasContent = false,
            collection = null, collectionId = null, albumFilter = null, query = "", offset = 0) }
        load()
    }
    fun browseAlbums() {
        if (mutable.value.tab != "library") tabs[mutable.value.tab] = query()
        history.remove("library")
        show(CatalogQuery(tab = "library", kind = "albums", title = AppLanguage.string(R.string.vm_title_library)))
    }
    private fun show(target: CatalogQuery, delayMs: Long = 0) {
        val context = catalogSortContext(target.kind, target.collection, target.albumFilter)
        val preference = context?.let { settings.catalogSort(repository.session.cacheScope(), it) }
        val target = target.copy(offset = 0, sort = preference?.sort ?: target.sort, order = preference?.order ?: target.order, libraryId = repository.selectedLibraryId)
        val savedWindow = windows[target.key] ?: pages[target.key]?.let { CatalogWindow(mapOf(0 to it)) }
        mutable.update { current ->
            val next = current.copy(tab = target.tab, kind = target.kind, title = target.title, query = target.query, offset = target.offset,
                collection = target.collection, collectionId = target.collectionId, activePlaylist = target.playlist, role = target.role, sort = target.sort, order = target.order, albumFilter = target.albumFilter, discs = emptyList(),
                contentKey = target.key, canGoBack = history[target.tab]?.isNotEmpty() == true,
                navigationDepth = history[target.tab]?.size ?: 0, error = null,
                window = CatalogWindow(), rangeLoading = emptySet(), rangeErrors = emptyMap(), browseIndex = browseIndices[target.key],
                tracks = emptyList(), albums = emptyList(), artists = emptyList(), playlists = emptyList(), total = 0, hasContent = false, loading = true)
            if (savedWindow == null) next else next.withWindow(savedWindow)
        }
        load(delayMs, preserveWindow = true)
    }
    fun back() {
        if (mutable.value.tab == "podcast" && mutable.value.podcastId != null) mutable.update { it.copy(podcastId = null) }
        else history[mutable.value.tab]?.removeLastOrNull()?.let { show(it) }
    }
    fun openPodcast(id: String) {
        navigate("podcast")
        mutable.update { it.copy(podcastId = id) }
    }
    fun openPlayingPodcast() {
        val track = mutable.value.current ?: return
        track.podcast?.podcastId?.let { openPodcast(it); return }
        val episodeId = track.podcastEpisodeId ?: return
        val owner = repository.session.cacheScope()
        viewModelScope.launch {
            try {
                val episode = repository.podcastEpisode(episodeId)
                requireOwner(owner)
                openPodcast(episode.podcastId)
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { notify(friendlyError(error)) }
        }
    }
    /** Contract §5: podcasts never inherit music shuffle/repeat; either would block auto-advance. */
    private fun preparePodcastAdvance() {
        val c = controller ?: return
        if (podcastAdvanceBlocked(c.repeatMode == Player.REPEAT_MODE_ONE, c.repeatMode == Player.REPEAT_MODE_ALL, c.shuffleModeEnabled)) {
            c.repeatMode = Player.REPEAT_MODE_OFF
            c.shuffleModeEnabled = false
        }
    }

    /** STATE_ENDED: the player queue is empty, so remove the episode and auto-continue only then. */
    private fun onPodcastPlaybackEnded() {
        val c = controller ?: return
        if (c.hasNextMediaItem()) return
        val episodeId = podcastEpisodeId(c.currentMediaItem?.mediaMetadata?.extras?.getString("track_id")) ?: return
        podcastQueues.onEpisodeFinished(episodeId, advanceLocally = true)
    }

    fun refreshPodcastCloud() = podcastQueues.refresh()
    fun refreshPodcastQueuePreferences() = podcastQueues.refreshPreferences()
    fun refreshPodcastAutoPreview() = podcastQueues.refreshAutoPreview()
    fun retryPodcastQueueSync() = podcastQueues.retry()
    fun resolvePodcastQueueConflict(choice: PodcastQueueConflictChoice) = podcastQueues.resolveConflict(choice)
    fun addPodcastEpisodeToInbox(episode: PodcastEpisode) = podcastQueues.addInbox(episode)
    fun removePodcastInboxEpisode(episodeId: String) = podcastQueues.removeInbox(episodeId)
    fun removePodcastQueueEpisode(episodeId: String) = podcastQueues.removeQueued(episodeId)
    fun reorderPodcastPending(rows: List<PodcastQueueRow>) = podcastQueues.reorderPending(rows)
    fun movePodcastInboxToQueue(episodeId: String) = podcastQueues.moveInboxToQueue(episodeId)
    fun updatePodcastShowPreference(podcastId: String, action: String, autoLimit: Int = 3) = podcastQueues.updateShow(podcastId, action, autoLimit)
    fun updatePodcastAutoContinue(enabled: Boolean) = podcastQueues.updateAutoContinue(enabled)
    fun clearPodcastQueueNotice() = podcastQueues.clearNotice()

    fun togglePodcastEpisodeFavorite(episodeId: String, loved: Boolean) = viewModelScope.launch {
        try {
            repository.favoritePodcastEpisode(episodeId, loved)
            val episode = repository.cachedPodcastEpisode(episodeId)
            val podcastId = episode?.podcastId
            if (podcastId != null) {
                val detail = repository.cachedPodcastDetail(podcastId)
                if (detail != null) {
                    podcastBrowser.remember(detail.copy(episodes = detail.episodes.map {
                        if (it.id == episodeId) it.copy(loved = loved, favorite = loved) else it
                    }))
                }
            }
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { notify(friendlyError(e)) }
    }

    fun markPodcastEpisodeCompleted(episodeId: String, completed: Boolean, durationSeconds: Int = 0) = viewModelScope.launch {
        try {
            val progress = repository.savePodcastProgress(episodeId, completed, durationSeconds)
            podcastProgress.recordManualProgress(episodeId, progress)
            val episode = repository.cachedPodcastEpisode(episodeId)
            val podcastId = episode?.podcastId
            if (podcastId != null) {
                val detail = repository.cachedPodcastDetail(podcastId)
                if (detail != null) {
                    podcastBrowser.remember(detail.copy(episodes = detail.episodes.map {
                        if (it.id == episodeId) it.copy(completed = completed, positionSeconds = progress.positionSeconds.toInt()) else it
                    }))
                }
            }
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { notify(friendlyError(e)) }
    }

    fun refreshPodcastFavoriteIds() = viewModelScope.launch {
        try { repository.getPodcastFavoriteIds() } catch (_: Exception) {}
    }

    fun playPodcastPendingQueue() = viewModelScope.launch {
        val cloud = podcastCloud.value
        val firstQueueId = cloud.queue.firstOrNull()?.episodeId
        val targetId = firstQueueId ?: cloud.inbox.minByOrNull { it.addedAt }?.episodeId ?: return@launch
        try {
            val episode = repository.podcastEpisode(targetId)
            val detail = repository.podcastDetail(episode.podcastId)
            playPodcastEpisode(episode, detail.podcast)
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { notify(friendlyError(e)) }
    }

    /** Inserts the episode at the head of the cloud queue and plays that queue. [preserveQueue] is retained for callers; the show is never bulk-loaded. */
    fun playPodcastEpisode(episode: PodcastEpisode, podcast: PodcastSummary, positionMs: Long? = null, @Suppress("UNUSED_PARAMETER") preserveQueue: Boolean = true) {
        podcastQueues.playEpisode(episode, podcast, positionMs)
    }

    /** Player previous / next episode buttons: adjacent episodes of the same show, FOLLOW order. */
    fun skipPodcastEpisode(offset: Int) = viewModelScope.launch {
        val owner = repository.session.cacheScope()
        try {
            val id = mutable.value.current?.podcastEpisodeId ?: return@launch
            val episode = repository.cachedPodcastEpisode(id) ?: return@launch
            val detail = repository.cachedPodcastDetail(episode.podcastId) ?: return@launch
            requireOwner(owner)
            val (previous, next) = podcastAdjacentEpisodes(episode, detail)
            val target = (if (offset < 0) previous else next) ?: return@launch
            playPodcastEpisode(target, detail.podcast)
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { notify(friendlyError(error)) }
    }

    /** Adds to the cloud queue only. Does not follow the show. */
    fun addPodcastEpisodeToQueue(episode: PodcastEpisode, podcast: PodcastSummary, next: Boolean = false) {
        viewModelScope.launch { runCatching { repository.rememberPodcastEpisode(episode, podcast) } }
        podcastQueues.enqueue(episode, next)
    }
    private fun open(target: CatalogQuery) {
        history.getOrPut(mutable.value.tab) { ArrayDeque() }.apply { if (size >= 20) removeFirst(); addLast(query()) }
        show(target)
    }
    fun kind(kind: String) { if (kind != mutable.value.kind) show(query().copy(kind = kind, offset = 0, sort = "title")) }
    fun role(value: String) { show(query().copy(role = value, offset = 0)) }
    fun sort(value: String) {
        val current = query()
        val context = catalogSortContext(current.kind, current.collection, current.albumFilter) ?: return
        settings.catalogSort(repository.session.cacheScope(), context, CatalogSort(value, if (value in listOf("title", "name", "track_number", "artist")) "asc" else "desc"))
        show(current)
    }
    fun toggleSortOrder() {
        val current = query()
        val context = catalogSortContext(current.kind, current.collection, current.albumFilter) ?: return
        settings.catalogSort(repository.session.cacheScope(), context, CatalogSort(current.sort, if (current.order == "asc") "desc" else "asc"))
        show(current)
    }
    fun search(query: String) {
        show(this.query().copy(kind = if (query.isBlank()) "discover" else "tracks", query = query.take(256), offset = 0,
            title = AppLanguage.string(R.string.vm_title_discover), collection = null, collectionId = null, playlist = null), 300)
    }
    fun openAlbum(album: Album) = open(if (mutable.value.collection == "artists") query().copy(kind = "tracks", albumFilter = album.id, title = album.title, query = "", offset = 0, sort = "title")
        else query().copy(kind = "tracks", collection = "albums", collectionId = album.id, title = album.title, query = "", offset = 0, playlist = null, albumFilter = null, sort = "title"))
    fun cancelAlbumNavigation() { albumNavigationJob?.cancel() }
    fun openTrackAlbum(track: Track, fromPlayer: Boolean = false, onOpened: () -> Unit = {}) {
        albumNavigationJob?.cancel()
        mutable.update { it.copy(error = null) }
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
                    mutable.update { it.copy(error = AppLanguage.string(R.string.vm_cannot_read_album)) }
                    return@launch
                }
                // Open the whole album, clearing any artist/playlist/search constraints.
                val preference = settings.catalogSort(owner, "album-tracks")
                val destination = query().copy(kind = "tracks", collection = "albums", collectionId = id,
                    title = current.album ?: AppLanguage.string(R.string.vm_unknown_album), query = "", offset = 0, playlist = null,
                    albumFilter = null, sort = preference.sort, order = preference.order)
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
    fun openArtist(artist: Artist) = open(query().copy(kind = "albums", albumFilter = null, collection = "artists", collectionId = artist.id, title = artist.name, query = "", offset = 0, playlist = null))
    fun openArtistName(name: String, onOpened: () -> Unit = {}) {
        val query = name.trim()
        if (query.isBlank()) return
        viewModelScope.launch {
            try {
                val result = repository.api().artists(query, limit = 20, offset = 0)
                val item = result.items.firstOrNull { it.name == query }
                    ?: result.items.firstOrNull { it.name.equals(query, ignoreCase = true) }
                    ?: result.items.singleOrNull()
                if (item == null) {
                    mutable.update { it.copy(error = AppLanguage.string(R.string.vm_artist_not_found, query)) }
                    return@launch
                }
                open(query().copy(kind = "albums", role = "artist", albumFilter = null, collection = "artists", collectionId = item.id, title = item.name, query = "", offset = 0, playlist = null))
                onOpened()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                mutable.update { it.copy(error = friendlyError(error)) }
            }
        }
    }
    fun openPlaylist(playlist: Playlist) = open(query().copy(kind = "tracks", collection = "playlists", collectionId = playlist.id, playlist = playlist, title = playlist.name, query = "", offset = 0))
    fun recent() = open(query().copy(kind = "recent", title = AppLanguage.string(R.string.vm_title_recent_played), collection = null, collectionId = null, offset = 0, query = "",
        sort = "last_played_at", playlist = null, albumFilter = null))

    fun recentlyAdded(kind: String) {
        settings.catalogSort(repository.session.cacheScope(), kind, CatalogSort("added_at", "desc"))
        open(query().copy(kind = kind, title = if (kind == "albums") AppLanguage.string(R.string.vm_title_recent_albums) else AppLanguage.string(R.string.vm_title_recent_tracks),
            collection = null, collectionId = null, query = "", playlist = null, albumFilter = null, sort = "added_at", order = "desc"))
    }

    fun load(delayMs: Long = 0, preserveWindow: Boolean = false) {
        loadJob?.cancel(); cancelRanges()
        val generation = ++loadGeneration
        val request = query().copy(offset = 0)
        val owner = repository.session.cacheScope()
        val sameRoute = mutable.value.contentKey == request.key
        val keepVisualState = preserveWindow || sameRoute
        if (!preserveWindow) {
            browseIndices.remove(request.key)
            if (!sameRoute) windows.remove(request.key)
        }
        loadJob = viewModelScope.launch {
            if (!mutable.value.connected) return@launch
            if (request.tab in listOf("podcast", "assistant")) {
                mutable.update {
                    it.copy(
                        tab = request.tab,
                        kind = request.kind,
                        title = request.title,
                        loading = false,
                        hasContent = true,
                        error = null,
                        contentKey = request.key,
                    )
                }
                return@launch
            }
            mutable.update {
                it.copy(
                    loading = true,
                    error = null,
                    rangeErrors = emptyMap(),
                    rangeLoading = emptySet(),
                    browseIndex = if (keepVisualState && request.indexed) it.browseIndex else browseIndices[request.key],
                    contentKey = request.key,
                )
            }
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
                require(page.total == mutable.value.total) { AppLanguage.string(R.string.vm_library_changed_refresh) }
                require(page.itemCount == minOf(CATALOG_PAGE_SIZE, page.total - offset)) { AppLanguage.string(R.string.vm_list_read_incomplete) }
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
        if (c.isPlaying || c.playWhenReady || mutable.value.current?.podcastEpisodeId != null) return@withContext
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
        val c = controller ?: throw IOException(AppLanguage.string(R.string.vm_player_not_connected))
        val snapshot = SharedPlayback(trackIds = queueSnapshot.map { it.trackId }, index = c.currentMediaItemIndex.coerceAtLeast(0),
            positionMs = c.currentPosition.coerceAtLeast(0), playbackState = if (c.playbackState == Player.STATE_ENDED) "ended" else if (c.playWhenReady) "playing" else "paused", mode = if (c.shuffleModeEnabled) "shuffle" else when(c.repeatMode) {
                Player.REPEAT_MODE_ONE -> "repeat_one"; Player.REPEAT_MODE_ALL -> "repeat_all"; else -> "sequential"
            })
        sharing.publish(snapshot, claim = true) ?: throw IOException(AppLanguage.string(R.string.vm_no_syncable_playback))
    }
    suspend fun resumeShared(saved: SharedPlayback, requirePausedHandoff: Boolean = false): Unit = withContext(Dispatchers.Main.immediate) {
        require(saved.trackIds.none { podcastEpisodeId(it) != null }) { AppLanguage.string(R.string.vm_podcast_resume_hint) }
        require(saved.trackIds.size <= 5000) { AppLanguage.string(R.string.vm_shared_queue_limit_exceeded) }
        val owner = repository.session.cacheScope()
        val epoch = localPlaybackEpoch
        val tracks = saved.trackIds.chunked(8).flatMap { batch -> coroutineScope { batch.map { async { repository.track(it) } }.awaitAll() } }
        check(owner != null && owner == repository.session.cacheScope()) { AppLanguage.string(R.string.vm_session_changed) }
        requireOwner(owner)
        val latest = repository.api().sharedPlayback(RequestOwner(owner)); requireOwner(owner)
        if (requirePausedHandoff && (!latest.isRecentPausedHandoff() || latest.pauseEvent() != saved.pauseEvent())) {
            mutable.update { it.copy(handoff = null) }
            throw IOException(AppLanguage.string(R.string.vm_other_device_resumed_or_expired))
        }
        if (latest.version != saved.version) throw IOException(AppLanguage.string(R.string.vm_other_device_updated))
        check(epoch == localPlaybackEpoch && controller?.playWhenReady != true) { AppLanguage.string(R.string.vm_local_playback_changed) }
        sharing.pauseOffered(saved)
        sharing.acceptRemote(saved.version)
        play(tracks, saved.index, autoplay = false, positionMs = saved.positionMs)
        controller?.shuffleModeEnabled = saved.mode == "shuffle"
        controller?.repeatMode = when(saved.mode) { "repeat_one" -> Player.REPEAT_MODE_ONE; "repeat_all", "shuffle" -> Player.REPEAT_MODE_ALL; else -> Player.REPEAT_MODE_OFF }
    }
    fun play(tracks: List<Track>, index: Int? = null, autoplay: Boolean = true, positionMs: Long? = null, preserveQueue: Boolean = false) {
        val c = controller ?: return
        if (tracks.isEmpty()) return
        val selected = index ?: tracks.indexOfFirst { it.isAvailable }.takeIf { it >= 0 } ?: 0
        val target = tracks.getOrNull(selected) ?: return
        if (!target.isAvailable) {
            mutable.update { it.copy(error = AppLanguage.string(R.string.vm_track_unavailable_format, target.title, target.unavailableReason.orEmpty())) }
            return
        }
        val index = tracks.take(selected).count { it.isAvailable }
        val tracks = tracks.filter { it.isAvailable }
        require(tracks.size <= 5000) { AppLanguage.string(R.string.vm_queue_limit_exceeded) }
        // Media3 transports bundle lists with a retriever; smaller additions also bound each transaction.
        tracks.forEach { repository.rememberPlaybackTrack(it) }
        val startPos = (positionMs ?: target.podcast?.resumePositionMs?.takeIf { it > 0L } ?: 0L).coerceAtLeast(0L)
        val items = tracks.mapIndexed { itemIndex, track -> track.mediaItem(repository).let { item ->
            if (itemIndex == index && track.podcastEpisodeId != null && positionMs != null) {
                val extras = android.os.Bundle(item.mediaMetadata.extras).apply { putLong("podcast_requested_position", positionMs) }
                item.buildUpon().setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(extras).build()).build()
            } else item
        } }
        val previous = (0 until c.mediaItemCount).map { c.getMediaItemAt(it) }
        localPlaybackEpoch++
        pendingSeekTargetMs = if (startPos > 0L) startPos else null
        pendingSeekAtElapsedMs = if (startPos > 0L) android.os.SystemClock.elapsedRealtime() else 0L
        val previousIndex = c.currentMediaItemIndex; val position = c.currentPosition; val previousAutoplay = c.playWhenReady
        try {
            if (preserveQueue) {
                // Contract §2.5 (see podcastQueueOnDemand): put the on-demand episode at the
                // head and keep every existing entry. addMediaItems + seekTo never replaces
                // the playlist, so manually queued items survive.
                c.pause()
                c.addMediaItems(0, items)
                c.seekTo(0, startPos)
                c.prepare(); c.playWhenReady = autoplay; refreshPlayer()
                return
            }
            val batches = items.chunked(100)
            c.pause()
            c.setMediaItems(batches.first(), index.coerceIn(batches.first().indices), startPos)
            batches.drop(1).forEach { c.addMediaItems(it) }
            if (index >= 100) c.seekTo(index.coerceIn(tracks.indices), startPos)
            c.prepare(); c.playWhenReady = autoplay; refreshPlayer()
        } catch (e: Exception) {
            if (previous.isNotEmpty()) { c.setMediaItems(previous.take(100), 0, 0); previous.drop(100).chunked(100).forEach { c.addMediaItems(it) }; c.seekTo(previousIndex, position); c.prepare(); c.playWhenReady = previousAutoplay }
            else c.clearMediaItems()
            mutable.update { it.copy(error = AppLanguage.string(R.string.vm_queue_update_failed)) }
        }
    }
    fun playCollection(startId: String? = null, onStarted: () -> Unit = {}) = viewModelScope.launch {
        if (mutable.value.collecting) return@launch
        val request = query()
        val profile = repository.session.cacheScope()
        mutable.update { it.copy(collecting = true) }
        try {
            val tracks = repository.collectionTracks(request)
            if (profile != repository.session.cacheScope()) return@launch
            if (tracks.isEmpty()) { mutable.update { it.copy(mutationMessage = AppLanguage.string(R.string.vm_collection_empty_music)) }; return@launch }
            play(tracks, startId?.let { id -> tracks.indexOfFirst { it.id == id }.coerceAtLeast(0) })
            onStarted()
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { mutable.update { it.copy(error = friendlyError(error), mutationMessage = null) } }
        finally { mutable.update { it.copy(collecting = false) } }
    }
    fun download(tracks: List<Track>): Boolean = runCatching {
        repository.downloads.enqueue(tracks); startDownloads(); notify(AppLanguage.string(R.string.vm_download_task_enqueued)); true
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
        notify(if (enabled) AppLanguage.string(R.string.vm_auto_download_enabled) else AppLanguage.string(R.string.vm_auto_download_disabled))
        viewModelScope.launch { runCatching { syncOfflinePlaylists() } }
    }
    suspend fun syncOfflinePlaylists() {
        if (!offlineSyncLock.tryLock()) return
        try {
            val owner = repository.session.cacheScope(); requireOwner(owner)
            if (!repository.downloads.networkAllowed()) {
                mutableOfflineSync.value = AppLanguage.string(R.string.vm_waiting_wifi); return
            }
            repository.downloads.resumeNetworkWaiting()
            val selected = repository.downloads.followedPlaylists()
            if (selected.isNotEmpty()) mutableOfflineSync.value = AppLanguage.string(R.string.vm_syncing_selected_playlists)
            for (id in selected) {
                val tracks = try { repository.collectionTracks(CatalogQuery(collection = "playlists", collectionId = id)) }
                    catch (e: HttpException) { if (e.code() == 404) { requireOwner(owner); repository.downloads.followPlaylist(id, false); continue } else throw e }
                requireOwner(owner)
                if (id in repository.downloads.followedPlaylists()) repository.downloads.enqueue(tracks, automatic = true)
            }
            requireOwner(owner)
            if (repository.downloads.entries.value.any { it.state == "queued" }) startDownloads()
            mutableOfflineSync.value = if (selected.isEmpty()) "" else AppLanguage.string(R.string.vm_playlists_checked)
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { mutableOfflineSync.value = friendlyError(e); throw e }
        finally { offlineSyncLock.unlock() }
    }
    fun downloadCollection() = viewModelScope.launch {
        if (mutable.value.collecting) return@launch
        mutable.update { it.copy(collecting = true) }
        try { download(repository.collectionTracks(query())) }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { mutable.update { it.copy(error = friendlyError(e)) } }
        finally { mutable.update { it.copy(collecting = false) } }
    }
    fun notify(message: String) { mutable.update { it.copy(mutationMessage = message) } }
    fun acknowledgeMessage(message: String) { mutable.update { if (it.mutationMessage == message) it.copy(mutationMessage = null) else it } }
    fun toggle() { localPlaybackEpoch++; controller?.let { if (it.playWhenReady) it.pause() else { if (it.playbackState == Player.STATE_IDLE) it.prepare(); it.play() } } }
    fun seek(ms: Long) {
        val target = ms.coerceAtLeast(0L)
        localPlaybackEpoch++
        pendingSeekTargetMs = target
        pendingSeekAtElapsedMs = android.os.SystemClock.elapsedRealtime()
        mutablePosition.value = target
        controller?.seekTo(target)
    }
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
    fun addToQueue(tracks: List<Track>, next: Boolean = false): Boolean {
        val c = controller ?: return false
        val tracks = tracks.filter { it.isAvailable }
        if (tracks.isEmpty()) {
            mutable.update { it.copy(error = AppLanguage.string(R.string.vm_no_playable_tracks_rescan)) }
            return false
        }
        if (c.mediaItemCount + tracks.size > 5000) { mutable.update { it.copy(error = AppLanguage.string(R.string.vm_queue_max_limit)) }; return false }
        localPlaybackEpoch++
        tracks.forEach { repository.rememberPlaybackTrack(it) }
        val items = tracks.map { it.mediaItem(repository) }
        if (c.mediaItemCount == 0) play(tracks)
        else if (next) c.addMediaItems(c.currentMediaItemIndex + 1, items)
        else c.addMediaItems(items)
        return true
    }
    fun addToQueue(track: Track, next: Boolean = false) = addToQueue(listOf(track), next)
    fun playQueue(index: Int) { localPlaybackEpoch++; controller?.let { it.seekToDefaultPosition(index); it.prepare(); it.play() } }
    fun removeQueue(index: Int) { localPlaybackEpoch++; controller?.removeMediaItem(index) }
    fun clearQueue() { localPlaybackEpoch++; controller?.let { it.stop(); it.clearMediaItems(); rebuildQueue(); refreshPlayer() } }
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
                mutable.update { it.copy(error = AppLanguage.string(R.string.vm_favorite_not_saved, friendlyError(e))) }
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
        try {
            repository.api().createPlaylist(PlaylistRequest(name.trim()))
            if (generation == authGeneration && profile == repository.session.cacheScope()) {
                invalidateCatalog(); tabs.remove("mine")
                mutable.update { it.copy(mutationMessage = AppLanguage.string(R.string.vm_playlist_created)) }
                if (mutable.value.tab == "mine") load() else navigate("mine")
            }
        }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { if (generation == authGeneration && profile == repository.session.cacheScope()) mutable.update { it.copy(mutationMessage = null, error = friendlyError(e)) } }
        finally { playlistJobs.remove("create") }
    }
    suspend fun createPlaylistAndAdd(name: String, tracks: List<Track>) {
        val owner = repository.session.cacheScope(); requireOwner(owner)
        val created = repository.api().createPlaylist(PlaylistRequest(name.trim(), "manual"))
        requireOwner(owner)
        if (tracks.isNotEmpty()) {
            repository.api().addTracks(repository.url("api", "v1", "playlists", created.id, "tracks"), AddTracks(created.version, tracks.map { it.id }.distinct()))
            requireOwner(owner)
        }
        invalidateCatalog(owner); tabs.remove("mine")
        if (mutable.value.tab == "mine") load()
        notify(AppLanguage.string(R.string.vm_added_to_playlist, created.name))
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
        catch (e: Exception) { if (generation == authGeneration && profile == repository.session.cacheScope()) { apply(playlist); mutable.update { it.copy(error = AppLanguage.string(R.string.vm_playlist_not_saved, friendlyError(e))) } } }
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
        requireOwner(owner); invalidateCatalog(owner); load(); notify(AppLanguage.string(R.string.vm_added_to_playlist, playlist.name))
    }
    suspend fun savePlaylist(name: String, definition: com.google.gson.JsonObject?, existing: Playlist?) {
        val owner = repository.session.cacheScope(); requireOwner(owner)
        if (existing == null) repository.api().createPlaylist(PlaylistRequest(name, if (definition == null) "manual" else "smart", definition))
        else repository.api().updatePlaylist(repository.url("api", "v1", "playlists", existing.id), PlaylistUpdate(name, existing.version, definition, existing.kind))
        requireOwner(owner); invalidateCatalog(owner); load(); notify(AppLanguage.string(R.string.vm_playlist_saved))
    }
    suspend fun deletePlaylist(playlist: Playlist) {
        val owner = repository.session.cacheScope(); requireOwner(owner)
        repository.api().deletePlaylist(repository.url("api", "v1", "playlists", playlist.id), playlist.version).let { if (!it.isSuccessful) throw HttpException(it) }
        requireOwner(owner); repository.downloads.followPlaylist(playlist.id, false); invalidateCatalog(owner)
        if (mutable.value.collectionId == playlist.id) back() else load()
        notify(AppLanguage.string(R.string.vm_playlist_deleted))
    }
    suspend fun removePlaylistTrack(track: Track, playlist: Playlist) {
        val owner = repository.session.cacheScope(); requireOwner(owner)
        repository.api().removeTrack(repository.url("api", "v1", "playlists", playlist.id, "tracks", track.id), playlist.version).close()
        requireOwner(owner)
        val fresh = repository.api().playlist(repository.url("api", "v1", "playlists", playlist.id))
        requireOwner(owner); mutable.update { if (it.collectionId == playlist.id) it.copy(activePlaylist = fresh) else it }; invalidateCatalog(owner); load(); notify(AppLanguage.string(R.string.vm_removed_from_playlist))
    }
    suspend fun playlistTracks(playlist: Playlist) = repository.collectionTracks(CatalogQuery(collection = "playlists", collectionId = playlist.id))
    suspend fun reorderPlaylist(playlist: Playlist, ids: List<String>) {
        val owner = repository.session.cacheScope(); requireOwner(owner)
        val fresh = repository.api().reorderPlaylist(repository.url("api", "v1", "playlists", playlist.id, "order"), AddTracks(playlist.version, ids))
        requireOwner(owner); mutable.update { it.copy(activePlaylist = fresh) }; invalidateCatalog(owner); load(); notify(AppLanguage.string(R.string.vm_playlist_order_saved))
    }
    fun addToPlaylist(track: Track, playlist: Playlist) = viewModelScope.launch {
        if (!playlistJobs.add(playlist.id)) return@launch
        val generation = authGeneration
        val profile = repository.session.cacheScope()
        try {
            repository.api().addTracks(repository.url("api", "v1", "playlists", playlist.id, "tracks"), AddTracks(playlist.version, listOf(track.id)))
            if (generation == authGeneration && profile == repository.session.cacheScope()) {
                invalidateCatalog(); mutable.update { it.copy(mutationMessage = AppLanguage.string(R.string.vm_added_to_playlist, playlist.name)) }
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
        val rawPos = c.currentPosition.coerceAtLeast(0L)
        val now = android.os.SystemClock.elapsedRealtime()
        val seekTarget = pendingSeekTargetMs
        val currentEntry = item?.mediaId
        val resolvedPos = when {
            seekTarget != null && now - pendingSeekAtElapsedMs < 1500L && kotlin.math.abs(rawPos - seekTarget) > 500L -> seekTarget
            else -> {
                if (seekTarget != null) pendingSeekTargetMs = null
                val prevPos = mutablePosition.value
                if (currentEntry != null && currentEntry == lastPositionEntryId && c.isPlaying && rawPos < prevPos && prevPos - rawPos < 1500L) prevPos
                else rawPos
            }
        }
        lastPositionEntryId = currentEntry
        mutablePosition.value = resolvedPos
        mutable.update { it.copy(current = track, playing = c.isPlaying, buffering = c.playbackState == Player.STATE_BUFFERING,
            duration = c.duration.takeIf { d -> d > 0 } ?: track?.durationMs ?: 0,
            queue = queue, playbackQuality = c.mediaMetadata.description?.toString().orEmpty(), entryId = item?.mediaId, repeatMode = c.repeatMode, shuffle = c.shuffleModeEnabled,
            playbackError = c.playerError?.let { error -> com.wildstring.app.playback.playbackErrorMessage(error, podcast = id?.let(::podcastEpisodeId) != null) }) }
        if (id != lyricTrack) {
            lyricTrack = id; lyricJob?.cancel()
            mutable.update { it.copy(lyrics = Lyrics(), lyricsLoading = id != null && track?.isPodcast != true, lyricsError = null) }
            if (id != null && podcastEpisodeId(id) == null) lyricJob = viewModelScope.launch {
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
