package dev.wildstring.app.ui

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
import dev.wildstring.app.data.*
import dev.wildstring.app.playback.PlaybackService
import dev.wildstring.app.playback.mediaItem
import javax.inject.Inject
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import retrofit2.HttpException

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
    val lyricsError: String? = null,
)

@HiltViewModel
class MusicViewModel @Inject constructor(
    val repository: Repository, val imageLoader: ImageLoader, @ApplicationContext context: Context,
) : ViewModel() {
    private val mutable = MutableStateFlow(MusicState(server = repository.session.endpoint?.toString().orEmpty(), localHttp = repository.session.localHttp))
    val state = mutable.asStateFlow()
    var controller: MediaController? = null
        private set
    private val controllerFuture = MediaController.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java))).buildAsync()
    private var loadJob: Job? = null
    private var lyricJob: Job? = null
    private var progressJob: Job? = null
    private var lyricTrack: String? = null
    private val playerListener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) { refreshPlayer() }
    }

    init {
        controllerFuture.addListener({
            runCatching { controllerFuture.get() }.onSuccess { c -> controller = c; c.addListener(playerListener); refreshPlayer() }
                .onFailure { mutable.update { it.copy(error = "播放器连接失败，请重新打开应用。") } }
        }, ContextCompat.getMainExecutor(context))
        viewModelScope.launch { repository.session.invalidations.collect {
            loadJob?.cancel(); lyricJob?.cancel(); controller?.stop(); controller?.clearMediaItems()
            mutable.update { MusicState(server = it.server, localHttp = it.localHttp, error = "登录已失效，请重新登录。") }
            imageLoader.memoryCache?.clear()
        } }
        if (repository.session.endpoint != null) viewModelScope.launch {
            mutable.update { it.copy(connecting = true) }
            try {
                if (repository.api().status().authenticated) { mutable.update { it.copy(connected = true) }; load() }
                else repository.session.invalidate()
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { mutable.update { it.copy(error = friendlyError(e)) } }
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
        loadJob?.cancel(); lyricJob?.cancel(); controller?.stop(); controller?.clearMediaItems()
        runCatching { repository.logout() }
        imageLoader.memoryCache?.clear()
        mutable.update { MusicState(server = it.server, localHttp = it.localHttp) }
    }

    fun navigate(tab: String) {
        loadJob?.cancel()
        mutable.update { it.copy(tab = tab, kind = if (tab == "mine") "playlists" else if (tab == "search") "tracks" else "albums",
            title = when (tab) { "mine" -> "我的"; "search" -> "找歌"; else -> "曲库" },
            collection = null, collectionId = null, activePlaylist = null, offset = 0, query = "", error = null) }
        load()
    }
    fun kind(kind: String) { mutable.update { it.copy(kind = kind, collection = null, collectionId = null, activePlaylist = null, offset = 0) }; load() }
    fun search(query: String) { mutable.update { it.copy(query = query, offset = 0) }; load(delayMs = 300) }
    fun page(direction: Int) { mutable.update { it.copy(offset = (it.offset + direction * 50).coerceAtLeast(0)) }; load() }
    fun openAlbum(album: Album) { mutable.update { it.copy(kind = "tracks", collection = "albums", collectionId = album.id, title = album.title, query = "", offset = 0, activePlaylist = null) }; load() }
    fun openArtist(artist: Artist) { mutable.update { it.copy(kind = "tracks", collection = "artists", collectionId = artist.id, title = artist.name, query = "", offset = 0, activePlaylist = null) }; load() }
    fun openPlaylist(playlist: Playlist) { mutable.update { it.copy(kind = "tracks", collection = "playlists", collectionId = playlist.id, activePlaylist = playlist, title = playlist.name, query = "", offset = 0) }; load() }
    fun recent() { mutable.update { it.copy(kind = "recent", title = "最近听过", collection = null, collectionId = null, offset = 0, query = "") }; load() }

    fun load(delayMs: Long = 0) {
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            delay(delayMs)
            val request = mutable.value
            if (!request.connected) return@launch
            mutable.update { it.copy(loading = true, error = null) }
            try {
                when (request.kind) {
                    "albums" -> { val p = repository.api().albums(request.query, offset = request.offset); mutable.update { it.copy(albums = p.items, total = p.total, tracks = emptyList()) } }
                    "artists" -> { val p = repository.api().artists(request.query, offset = request.offset); mutable.update { it.copy(artists = p.items, total = p.total, tracks = emptyList()) } }
                    "playlists" -> { val p = repository.api().playlists(limit = 50, offset = request.offset); mutable.update { it.copy(playlists = p.items, total = p.total, tracks = emptyList()) } }
                    else -> { val p = repository.tracks(request.query, request.offset, request.collection, request.collectionId, request.kind == "recent"); mutable.update { it.copy(tracks = p.items, total = p.total) } }
                }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { mutable.update { it.copy(error = friendlyError(e)) } }
            finally { mutable.update { it.copy(loading = false) } }
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
    fun moveQueue(index: Int, direction: Int) { controller?.let { val to = index + direction; if (to in 0 until it.mediaItemCount) it.moveMediaItem(index, to) } }
    fun favorite(track: Track) = viewModelScope.launch {
        try { val updated = repository.favorite(track); mutable.update { s -> s.copy(current = if (s.current?.id == track.id) updated else s.current, tracks = s.tracks.map { if (it.id == track.id) updated else it }) } }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { mutable.update { it.copy(error = friendlyError(e)) } }
    }
    fun createPlaylist(name: String) = viewModelScope.launch {
        try { repository.api().createPlaylist(PlaylistRequest(name.trim())); navigate("mine") }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { mutable.update { it.copy(error = friendlyError(e)) } }
    }
    fun renamePlaylist(playlist: Playlist, name: String) = viewModelScope.launch {
        try { val updated = repository.api().renamePlaylist(repository.url("api", "v1", "playlists", playlist.id), RenamePlaylist(name.trim(), playlist.version)); openPlaylist(updated) }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { mutable.update { it.copy(error = friendlyError(e)) }; load() }
    }
    suspend fun playlistsForAdd(): List<Playlist> = repository.api().playlists().items.filter { it.kind == "manual" }
    fun addToPlaylist(track: Track, playlist: Playlist) = viewModelScope.launch {
        try { repository.api().addTracks(repository.url("api", "v1", "playlists", playlist.id, "tracks"), AddTracks(playlist.version, listOf(track.id))); load() }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { mutable.update { it.copy(error = friendlyError(e)) } }
    }
    private fun refreshPlayer() {
        val c = controller ?: return
        val item = c.currentMediaItem
        val id = item?.mediaMetadata?.extras?.getString("track_id")
        val track = id?.let { repository.knownTracks[it] }
        val queue = (0 until c.mediaItemCount).map { i -> val m = c.getMediaItemAt(i); QueueRow(m.mediaId, m.mediaMetadata.extras?.getString("track_id").orEmpty(), m.mediaMetadata.title?.toString().orEmpty(), m.mediaMetadata.artist?.toString().orEmpty(), i) }
        mutable.update { it.copy(current = track, playing = c.isPlaying, buffering = c.playbackState == Player.STATE_BUFFERING,
            position = c.currentPosition.coerceAtLeast(0), duration = c.duration.takeIf { d -> d > 0 } ?: track?.durationMs ?: 0,
            queue = queue, entryId = item?.mediaId, repeatMode = c.repeatMode, shuffle = c.shuffleModeEnabled,
            playbackError = c.playerError?.let { "无法播放这首歌，请检查连接或音频编码后重试。" }) }
        if (id != lyricTrack) {
            lyricTrack = id; lyricJob?.cancel()
            mutable.update { it.copy(lyrics = Lyrics(), lyricsLoading = id != null, lyricsError = null) }
            if (id != null) lyricJob = viewModelScope.launch {
                try { val lyrics = repository.lyrics(id); mutable.update { it.copy(lyrics = lyrics) } }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) { mutable.update { it.copy(lyricsError = friendlyError(e)) } }
                finally { mutable.update { it.copy(lyricsLoading = false) } }
            }
        }
    }
    override fun onCleared() { controller?.removeListener(playerListener); MediaController.releaseFuture(controllerFuture); super.onCleared() }
}
