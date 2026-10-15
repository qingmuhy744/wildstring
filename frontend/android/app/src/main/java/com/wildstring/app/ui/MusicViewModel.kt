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
    val connected: Boolean = false, val connecting: Boolean = false, val loading: Boolean = false,
    val server: String = "", val localHttp: Boolean = false, val error: String? = null,
    val tab: String = "library", val kind: String = "albums", val title: String = "曲库",
    val query: String = "", val offset: Int = 0, val total: Int = 0,
    val collection: String? = null, val collectionId: String? = null, val activePlaylist: Playlist? = null,
    val tracks: List<Track> = emptyList(), val albums: List<Album> = emptyList(),
    val artists: List<Artist> = emptyList(), val playlists: List<Playlist> = emptyList(),
    val current: Track? = null, val playing: Boolean = false, val buffering: Boolean = false,
    val position: Long = 0, val duration: Long = 0, val queue: List<QueueRow> = emptyList(),
    val entryId: String? = null, val repeatMode: Int = Player.REPEAT_MODE_OFF, val shuffle: Boolean = false,
    val playbackError: String? = null, val lyrics: Lyrics = Lyrics(), val lyricsLoading: Boolean = false,
    val lyricsError: String? = null, val offline: Boolean = false, val hasContent: Boolean = false,
    val contentKey: String = "", val canGoBack: Boolean = false,
)

@HiltViewModel
class MusicViewModel @Inject constructor(
    val repository: Repository, val imageLoader: ImageLoader, val settings: AppSettings,
    val audioCache: AudioCache, val playbackHealth: com.wildstring.app.playback.PlaybackHealth, @ApplicationContext context: Context,
) : ViewModel() {
    private val mutable = MutableStateFlow(MusicState(server = repository.session.endpoint?.toString().orEmpty(), localHttp = repository.session.localHttp))
    val state = mutable.asStateFlow()
    private val mutablePosition = MutableStateFlow(0L)
    val position = mutablePosition.asStateFlow()
    var controller: MediaController? = null
        private set
    private val controllerFuture = MediaController.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java))).buildAsync()
    private var loadJob: Job? = null
    private var lyricJob: Job? = null
    private var progressJob: Job? = null
    private var lyricTrack: String? = null
    private var loadGeneration = 0L
    private val tabs = mutableMapOf<String, CatalogQuery>()
    private val history = mutableMapOf<String, ArrayDeque<CatalogQuery>>()
    private val favoriteJobs = mutableSetOf<String>()
    private var queueSnapshot: List<QueueRow> = emptyList()
    private val pages = object : LinkedHashMap<String, CatalogPage>(24, .75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, CatalogPage>?) = size > 24
    }
    private fun query() = mutable.value.let { CatalogQuery(it.tab, it.kind, it.title, it.query, it.offset, it.collection, it.collectionId, it.activePlaylist) }
    private fun MusicState.withPage(page: CatalogPage) = copy(tracks = page.tracks, albums = page.albums, artists = page.artists,
        playlists = page.playlists, total = page.total, hasContent = true)
    suspend fun cacheUsage(): Triple<Long, Long, Long> = withContext(Dispatchers.IO) { val (metadata, art) = repository.cache.usage(); Triple(metadata, art, audioCache.bytes()) }
    fun clearCache() = viewModelScope.launch {
        withContext(Dispatchers.IO) { repository.cache.clear(); audioCache.clear() }
        pages.clear(); imageLoader.memoryCache?.clear()
    }
    private suspend fun invalidateCatalog() { pages.clear(); withContext(Dispatchers.IO) { repository.cache.invalidateCatalog() } }

    private val playerListener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
            if (events.contains(Player.EVENT_TIMELINE_CHANGED) || events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION) || events.contains(Player.EVENT_MEDIA_METADATA_CHANGED)) {
                rebuildQueue()
            }
            refreshPlayer()
        }
    }

    init {
        controllerFuture.addListener({
            runCatching { controllerFuture.get() }.onSuccess { c -> controller = c; c.addListener(playerListener); rebuildQueue(); refreshPlayer() }
                .onFailure { mutable.update { it.copy(error = "播放器连接失败，请重新打开应用。") } }
        }, ContextCompat.getMainExecutor(context))
        viewModelScope.launch { repository.session.invalidations.collect {
            loadGeneration++; loadJob?.cancel(); lyricJob?.cancel(); lyricTrack = null; pages.clear(); tabs.clear(); history.clear(); repository.knownTracks.clear(); controller?.stop(); controller?.clearMediaItems()
            mutable.update { MusicState(server = it.server, localHttp = it.localHttp, error = "登录已失效，请重新登录。") }
            imageLoader.memoryCache?.clear()
        } }
        if (repository.session.endpoint != null) viewModelScope.launch {
            val saved = repository.cachedCatalog(CatalogQuery())
            if (saved != null && repository.session.cacheScope() != null) {
                mutable.update { it.withPage(saved).copy(connected = true, offline = true, contentKey = query().key) }
                pages[query().key] = saved
            } else mutable.update { it.copy(connecting = true) }
            try {
                if (repository.api().status().authenticated) { mutable.update { it.copy(connected = true, offline = false) }; load() }
                else repository.session.invalidate()
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { mutable.update { it.copy(error = if (it.connected && e is IOException) null else friendlyError(e), offline = it.connected) } }
            finally { mutable.update { it.copy(connecting = false) } }
        }
    }

    fun observeProgress(visible: Boolean) {
        progressJob?.cancel()
        if (visible) progressJob = viewModelScope.launch { while (isActive) { refreshPlayer(); delay(500) } }
    }
    fun connect(server: String, username: String, password: String, localHttp: Boolean) = viewModelScope.launch {
        if (mutable.value.connecting) return@launch
        mutable.update { it.copy(connecting = true, error = null) }
        try {
            repository.client.dispatcher.cancelAll()
            repository.session.configure(server, localHttp)
            val status = repository.api().status()
            check(status.configured) { "请先在服务端初始化管理员。" }
            if (!status.authenticated) repository.api().login(LoginRequest(username.trim(), password)).close()
            mutable.update { MusicState(connected = true, server = repository.session.endpoint.toString(), localHttp = localHttp) }
            load()
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { mutable.update { it.copy(error = if (e is HttpException && e.code() == 401) "账号或密码不正确。" else if (e is IllegalStateException) e.message else friendlyError(e)) } }
        finally { mutable.update { it.copy(connecting = false) } }
    }
    fun logout() = viewModelScope.launch {
        loadGeneration++; loadJob?.cancel(); lyricJob?.cancel(); lyricTrack = null; pages.clear(); tabs.clear(); history.clear(); repository.knownTracks.clear(); controller?.stop(); controller?.clearMediaItems()
        runCatching { repository.logout() }
        imageLoader.memoryCache?.clear()
        mutable.update { MusicState(server = it.server, localHttp = it.localHttp) }
    }

    fun navigate(tab: String) {
        if (tab == mutable.value.tab) return
        tabs[mutable.value.tab] = query()
        val target = tabs[tab] ?: CatalogQuery(tab = tab, kind = if (tab == "mine") "playlists" else if (tab == "search") "tracks" else "albums",
            title = when (tab) { "mine" -> "我的"; "search" -> "找歌"; else -> "曲库" })
        show(target)
    }
    private fun show(target: CatalogQuery, delayMs: Long = 0) {
        val saved = pages[target.key]
        mutable.update { current ->
            val next = current.copy(tab = target.tab, kind = target.kind, title = target.title, query = target.query, offset = target.offset,
                collection = target.collection, collectionId = target.collectionId, activePlaylist = target.playlist,
                contentKey = target.key, canGoBack = history[target.tab]?.isNotEmpty() == true, error = null,
                tracks = emptyList(), albums = emptyList(), artists = emptyList(), playlists = emptyList(), total = 0, hasContent = false, loading = true)
            if (saved == null) next else next.withPage(saved)
        }
        load(delayMs)
    }
    fun back() { history[mutable.value.tab]?.removeLastOrNull()?.let { show(it) } }
    private fun open(target: CatalogQuery) {
        history.getOrPut(mutable.value.tab) { ArrayDeque() }.apply { if (size >= 20) removeFirst(); addLast(query()) }
        show(target)
    }
    fun kind(kind: String) { if (kind != mutable.value.kind) show(query().copy(kind = kind, offset = 0)) }
    fun search(query: String) { show(this.query().copy(query = query.take(256), offset = 0), 300) }
    fun page(direction: Int) { show(query().copy(offset = (mutable.value.offset + direction * 50).coerceAtLeast(0))) }
    fun openAlbum(album: Album) = open(query().copy(kind = "tracks", collection = "albums", collectionId = album.id, title = album.title, query = "", offset = 0, playlist = null))
    fun openArtist(artist: Artist) = open(query().copy(kind = "tracks", collection = "artists", collectionId = artist.id, title = artist.name, query = "", offset = 0, playlist = null))
    fun openPlaylist(playlist: Playlist) = open(query().copy(kind = "tracks", collection = "playlists", collectionId = playlist.id, playlist = playlist, title = playlist.name, query = "", offset = 0))
    fun recent() = open(query().copy(kind = "recent", title = "最近听过", collection = null, collectionId = null, offset = 0, query = ""))

    fun load(delayMs: Long = 0) {
        loadJob?.cancel()
        val generation = ++loadGeneration
        val request = query()
        loadJob = viewModelScope.launch {
            if (!mutable.value.connected) return@launch
            mutable.update { it.copy(loading = true, error = null, contentKey = request.key) }
            try {
                if (!mutable.value.hasContent) repository.cachedCatalog(request)?.let { cached ->
                    if (generation == loadGeneration) { pages[request.key] = cached; mutable.update { it.withPage(cached) } }
                }
                delay(delayMs)
                val result = repository.catalog(request)
                if (generation == loadGeneration) {
                    pages[request.key] = result
                    mutable.update { it.withPage(result).copy(offline = false) }
                }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (generation == loadGeneration) mutable.update { it.copy(offline = e is IOException,
                    error = if (e is IOException && e !is javax.net.ssl.SSLException && it.hasContent) null else friendlyError(e)) }
            } finally { if (generation == loadGeneration) mutable.update { it.copy(loading = false) } }
        }
    }

    fun play(tracks: List<Track>, index: Int = 0) {
        val c = controller ?: return
        if (tracks.isEmpty()) return
        c.setMediaItems(tracks.map { it.mediaItem(repository) }, index.coerceIn(tracks.indices), 0)
        c.prepare(); c.play(); refreshPlayer()
    }
    fun toggle() { controller?.let { if (it.isPlaying) it.pause() else { if (it.playbackState == Player.STATE_IDLE) it.prepare(); it.play() } } }
    fun seek(ms: Long) { controller?.seekTo(ms.coerceAtLeast(0)) }
    fun next() { controller?.seekToNextMediaItem() }
    fun previous() { controller?.seekToPreviousMediaItem() }
    fun cycleMode() { controller?.let { c ->
        when { c.shuffleModeEnabled -> { c.shuffleModeEnabled = false; c.repeatMode = Player.REPEAT_MODE_OFF }
            c.repeatMode == Player.REPEAT_MODE_OFF -> c.repeatMode = Player.REPEAT_MODE_ONE
            else -> { c.repeatMode = Player.REPEAT_MODE_ALL; c.shuffleModeEnabled = true } }
    } }
    fun addToQueue(track: Track, next: Boolean = false) {
        controller?.let { c ->
            if (c.mediaItemCount >= 5000) { mutable.update { it.copy(error = "播放队列最多 5000 项。") }; return }
            if (c.mediaItemCount == 0) play(listOf(track))
            else if (next) c.addMediaItem(c.currentMediaItemIndex + 1, track.mediaItem(repository))
            else c.addMediaItem(track.mediaItem(repository))
        }
    }
    fun playQueue(index: Int) { controller?.let { it.seekToDefaultPosition(index); it.prepare(); it.play() } }
    fun removeQueue(index: Int) { controller?.removeMediaItem(index) }
    fun moveQueue(entryId: String, toIndex: Int) {
        controller?.let { c ->
            val from = (0 until c.mediaItemCount).firstOrNull { c.getMediaItemAt(it).mediaId == entryId } ?: return
            if (toIndex in 0 until c.mediaItemCount && from != toIndex) c.moveMediaItem(from, toIndex)
        }
    }
    fun favorite(track: Track) = viewModelScope.launch {
        if (!favoriteJobs.add(track.id)) return@launch
        try { val updated = repository.favorite(track); invalidateCatalog(); mutable.update { s -> s.copy(current = if (s.current?.id == track.id) updated else s.current, tracks = s.tracks.map { if (it.id == track.id) updated else it }) } }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { mutable.update { it.copy(error = friendlyError(e)) } }
        finally { favoriteJobs.remove(track.id) }
    }
    fun createPlaylist(name: String) = viewModelScope.launch {
        try { repository.api().createPlaylist(PlaylistRequest(name.trim())); invalidateCatalog(); tabs.remove("mine"); if (mutable.value.tab == "mine") load() else navigate("mine") }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { mutable.update { it.copy(error = friendlyError(e)) } }
    }
    fun renamePlaylist(playlist: Playlist, name: String) = viewModelScope.launch {
        try { val updated = repository.api().renamePlaylist(repository.url("api", "v1", "playlists", playlist.id), RenamePlaylist(name.trim(), playlist.version)); invalidateCatalog(); show(query().copy(playlist = updated, title = updated.name)) }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { mutable.update { it.copy(error = friendlyError(e)) }; load() }
    }
    suspend fun playlistsForAdd(): List<Playlist> = repository.api().playlists().items.filter { it.kind == "manual" }
    fun addToPlaylist(track: Track, playlist: Playlist) = viewModelScope.launch {
        try { repository.api().addTracks(repository.url("api", "v1", "playlists", playlist.id, "tracks"), AddTracks(playlist.version, listOf(track.id))); invalidateCatalog(); if (mutable.value.tab == "mine") load() }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { mutable.update { it.copy(error = friendlyError(e)) } }
    }
    private fun rebuildQueue() {
        val c = controller
        queueSnapshot = if (c == null) emptyList() else (0 until c.mediaItemCount).map { i -> val m = c.getMediaItemAt(i); QueueRow(m.mediaId, m.mediaMetadata.extras?.getString("track_id").orEmpty(), m.mediaMetadata.title?.toString().orEmpty(), m.mediaMetadata.artist?.toString().orEmpty(), i) }
    }
    private fun refreshPlayer() {
        val c = controller ?: return
        val item = c.currentMediaItem
        val id = item?.mediaMetadata?.extras?.getString("track_id")
        val track = id?.let { repository.knownTracks[it] }
        val queue = queueSnapshot
        mutablePosition.value = c.currentPosition.coerceAtLeast(0)
        mutable.update { it.copy(current = track, playing = c.isPlaying, buffering = c.playbackState == Player.STATE_BUFFERING,
            duration = c.duration.takeIf { d -> d > 0 } ?: track?.durationMs ?: 0,
            queue = queue, entryId = item?.mediaId, repeatMode = c.repeatMode, shuffle = c.shuffleModeEnabled,
            playbackError = c.playerError?.let { "无法播放这首歌，请检查连接或音频编码后重试。" }) }
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
    override fun onCleared() { controller?.removeListener(playerListener); MediaController.releaseFuture(controllerFuture); super.onCleared() }
}
