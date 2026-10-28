package com.wildstring.app.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.io.IOException
import com.google.gson.Gson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton
import dagger.hilt.android.qualifiers.ApplicationContext
import okhttp3.OkHttpClient
import okhttp3.CookieJar
import okhttp3.Request
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.asSharedFlow
import retrofit2.HttpException
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

data class CatalogQuery(val tab: String = "search", val kind: String = "discover", val title: String = "发现",
    val query: String = "", val offset: Int = 0, val collection: String? = null, val collectionId: String? = null,
    val playlist: Playlist? = null, val role: String = "album_artist", val sort: String = "title", val albumFilter: String? = null, val order: String = "asc",
    val libraryId: String = "all") {
    val indexed: Boolean get() = kind in listOf("tracks", "albums", "artists") && sort in listOf("title", "name") && order == "asc" &&
        collection != "playlists" && collection != "albums" && albumFilter == null
    val key: String get() = Gson().toJson(listOf(tab, kind, query, offset, collection, collectionId, role, sort, albumFilter, order, libraryId))
}
data class CatalogPage(val tracks: List<Track> = emptyList(), val albums: List<Album> = emptyList(),
    val artists: List<Artist> = emptyList(), val playlists: List<Playlist> = emptyList(), val total: Int = 0, val discs: List<DiscSummary>? = null)

@Singleton
class Repository @Inject constructor(@param:ApplicationContext private val context: Context, val session: SessionStore, val client: OkHttpClient, val database: QueueDatabase, val cache: ClientCache, val settings: AppSettings, val downloads: OfflineDownloads) {
    private val preferenceScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + Dispatchers.Main.immediate)
    init {
        settings.bindAccount(session.activeServerId, session.account?.id)
        preferenceScope.launch {
            session.profiles.collect { settings.bindAccount(session.activeServerId, session.account?.id) }
        }
    }
    private val gson = Gson()
    private val libraryPrefs = context.getSharedPreferences("music-libraries", Context.MODE_PRIVATE)
    val selectedLibraryId: String get() = libraryPrefs.getString("selected:${session.storageScope()}", "all") ?: "all"
    fun selectLibrary(id: String) { session.storageScope()?.let { libraryPrefs.edit().putString("selected:$it", id).apply() } }
    private val accessChanges = kotlinx.coroutines.flow.MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val libraryAccessChanges = accessChanges.asSharedFlow()
    @Volatile private var libraryAccessFingerprint = ""
    @Volatile private var fingerprintOwner: String? = null
    private fun libraryInterceptor(owner: String, selection: String) = okhttp3.Interceptor { chain ->
        val response = chain.proceed(chain.request().newBuilder().header("X-Wildstring-Library", selection).build())
        if (owner == session.cacheScope()) response.header("X-Wildstring-Library-Access")?.let { fingerprint ->
            synchronized(this) {
                if (fingerprintOwner == owner && libraryAccessFingerprint.isNotEmpty() && libraryAccessFingerprint != fingerprint) accessChanges.tryEmit(Unit)
                libraryAccessFingerprint = fingerprint; fingerprintOwner = owner
            }
        }
        response
    }
    private var cachedUrl: String? = null
    private var cachedApi: Api? = null
    private var cachedAgentKey: String? = null
    private var cachedAgentApi: Api? = null
    val knownTracks = java.util.concurrent.ConcurrentHashMap<String, Track>()
    private val favoriteClock = java.util.concurrent.atomic.AtomicLong()
    private val favoriteVersions = java.util.concurrent.ConcurrentHashMap<String, Long>()
    @Synchronized private fun rememberTrack(track: Track, snapshot: Long? = null): Track {
        val previous = knownTracks[track.id]
        val merged = if (previous != null && (snapshot == null || (favoriteVersions[track.id] ?: 0L) > snapshot))
            track.copy(loved = previous.loved) else track
        knownTracks[track.id] = merged
        return merged
    }
    fun rememberPlaybackTrack(track: Track): Track = rememberTrack(track)
    @Synchronized private fun favoriteChanged(id: String) { favoriteVersions[id] = favoriteClock.incrementAndGet() }
    @Synchronized fun publishFavorite(track: Track): Track {
        favoriteChanged(track.id)
        return (knownTracks[track.id] ?: track).copy(loved = track.loved).also { knownTracks[track.id] = it }
    }
    @Synchronized fun api(): Api {
        val request = session.requestState() ?: throw IOException("请先连接服务器。")
        val base = request.endpoint
        val selection = request.selection
        val library = selectedLibraryId
        val key = "$base|$selection|$library"
        if (cachedUrl != key) {
            val scoped = client.newBuilder().apply {
                interceptors().add(0, SelectionRequestInterceptor(selection) { session.requestState()?.selection })
                addInterceptor(libraryInterceptor(session.cacheScope().orEmpty(), library))
            }.build()
            cachedApi = Retrofit.Builder().baseUrl(base).client(scoped).addConverterFactory(GsonConverterFactory.create(networkGson())).build().create(Api::class.java)
            cachedUrl = key
        }
        return checkNotNull(cachedApi)
    }
    /** A lost assistant response can already have consumed model budget; do not resend POSTs. */
    @Synchronized fun agentApi(): Api {
        val request = session.requestState() ?: throw IOException("请先连接服务器。")
        val library = selectedLibraryId
        val key = "${request.endpoint}|${request.selection}|$library"
        if (cachedAgentKey != key) {
            val scoped = client.newBuilder().retryOnConnectionFailure(false).apply {
                interceptors().add(0, SelectionRequestInterceptor(request.selection) { session.requestState()?.selection })
                addInterceptor(libraryInterceptor(session.cacheScope().orEmpty(), library))
            }.build()
            cachedAgentApi = Retrofit.Builder().baseUrl(request.endpoint).client(scoped)
                .addConverterFactory(GsonConverterFactory.create(networkGson())).build().create(Api::class.java)
            cachedAgentKey = key
        }
        return checkNotNull(cachedAgentApi)
    }
    fun url(vararg segments: String): String {
        val builder = (session.endpoint ?: throw IOException("请先连接服务器。")).newBuilder()
        segments.forEach { builder.addPathSegment(it) }
        return builder.build().toString()
    }
    val podcastImageClient: OkHttpClient = podcastArtworkClient().newBuilder()
        .addInterceptor(CoverCacheInterceptor(cache, session) { true }).build()
    fun cover(id: String): String =
        knownTracks[id]?.podcast?.coverUrl?.let(::podcastArtworkUrl)
            ?: (url("api", "v1", "tracks", id, "cover") + "?size=768")
    fun imageClient(uri: String): OkHttpClient = if (knownTracks.values.any {
        it.podcast?.coverUrl?.let(::podcastArtworkUrl) == uri
    }) podcastImageClient else client
    suspend fun coverImage(id: String): ByteArray = withContext(Dispatchers.IO) {
        val owner = session.cacheScope(); requireProfile(owner)
        val bytes = api().coverImage(cover(id), RequestOwner(owner!!)).use { body ->
            body.byteStream().use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (output.size() + count > 4 * 1024 * 1024) throw IOException("封面图片过大。")
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
        }
        requireProfile(owner)
        if (bytes.size < 3 || bytes[0] != 0xff.toByte() || bytes[1] != 0xd8.toByte()) throw IOException("封面图片不可用。")
        bytes
    }
    private fun podcastNetwork(): String {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val caps = manager.getNetworkCapabilities(manager.activeNetwork)
        return when {
            caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true || caps?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true -> "wifi"
            caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> "cellular"
            else -> "unknown"
        }
    }
    fun originalStream(id: String): String =
        if (id.startsWith("podcast_ep_")) {
            url("api", "v1", "podcasts", "episodes", id.removePrefix("podcast_ep_"), "stream") + "?proxy=1&cache=1&network=${podcastNetwork()}"
        } else {
            url("api", "v1", "tracks", id, "stream")
        }
    fun stream(id: String): String = PlaybackRequest.url(originalStream(id), if (podcastEpisodeId(id) != null || downloads.file(id) != null) 0 else settings.state.value.aacBitrate)

    suspend fun podcasts(): List<PodcastSummary> = api().podcasts(if (session.account?.profile in listOf("owner", "librarian")) null else true)
    suspend fun libraries(includeDisabled: Boolean = false): List<MusicLibrary> {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().libraries(includeDisabled).also { requireProfile(owner) }
    }
    suspend fun followPodcast(id: String, followed: Boolean): Boolean {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().followPodcast(id, PodcastFollow(followed), RequestOwner(owner)).also { requireProfile(owner) }.followed
    }
    suspend fun podcastPublishers(): List<PodcastPublisher> {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().podcastPublishers(RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun podcastPublisher(id: String): PodcastPublisherDetail {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().podcastPublisher(id, RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun assignPodcastPublisher(id: String, body: PodcastPublisherAssignment): PodcastDetail {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().assignPodcastPublisher(id, body, RequestOwner(owner)).also {
            requireProfile(owner); save("podcast:$id", it, owner)
        }
    }
    suspend fun savePodcastEpisode(id: String, saved: Boolean): PodcastSaveResult {
        val owner = session.cacheScope()
        return (if (saved) api().savePodcastEpisode(id, RequestOwner(owner)) else api().releasePodcastEpisode(id, RequestOwner(owner))).also { requireProfile(owner) }
    }
    suspend fun podcastCatalogPolicy(): PodcastCatalogPolicy {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().podcastCatalogPolicy(RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun subscribePodcast(feedUrl: String): PodcastDetail {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().subscribePodcast(PodcastSubscribeRequest(feedUrl), RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun podcastDetail(id: String): PodcastDetail {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().podcastDetail(id).also { detail ->
            requireProfile(owner); save("podcast:$id", detail, owner)
        }
    }
    suspend fun cachedPodcastDetail(id: String): PodcastDetail? = saved("podcast:$id", PodcastDetail::class.java)
    suspend fun cachedPodcastEpisode(id: String): PodcastEpisode? = saved("podcast-episode:$id", PodcastEpisode::class.java)
    suspend fun podcastEpisode(id: String): PodcastEpisode {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().podcastEpisode(id).also { episode ->
            requireProfile(owner); save("podcast-episode:$id", episode, owner)
        }
    }
    suspend fun rememberPodcastEpisode(episode: PodcastEpisode, podcast: PodcastSummary): Track {
        val owner = session.cacheScope(); requireProfile(owner)
        val track = episode.toTrack(podcast)
        save("track:${track.id}", track, owner)
        save("podcast-episode:${episode.id}", episode, owner)
        requireProfile(owner)
        return rememberTrack(track)
    }
    suspend fun refreshPodcast(id: String): PodcastDetail {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().refreshPodcast(id).also { detail ->
            requireProfile(owner); save("podcast:$id", detail, owner)
        }
    }
    suspend fun refreshAllPodcasts(): Boolean = try { api().refreshAllPodcasts(); true }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { false }
    suspend fun deletePodcast(id: String): Boolean = api().deletePodcast(id).isSuccessful
    suspend fun podcastDownloadSettings(id: String): PodcastDownloadSettings {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().podcastDownloadSettings(id, RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun updatePodcastDownloadSettings(id: String, settings: PodcastDownloadSettings, expectedOwner: String? = session.cacheScope()): PodcastDownloadSettings {
        val owner = expectedOwner; requireProfile(owner)
        return api().updatePodcastDownloadSettings(id, PodcastDownloadSettingsUpdate(settings.version, settings.downloadPolicy, settings.retentionPolicy), RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun podcastPlaybackSettings(): PodcastPlaybackSettings {
        val owner = session.cacheScope(); requireProfile(owner)
        return api().podcastPlaybackSettings(RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun updatePodcastPlaybackSettings(settings: PodcastPlaybackSettings, expectedOwner: String? = session.cacheScope()): PodcastPlaybackSettings {
        val owner = expectedOwner; requireProfile(owner)
        if (settings.userId != session.account?.id) throw CancellationException("会话已变化。")
        return api().updatePodcastPlaybackSettings(PodcastPlaybackSettingsUpdate(settings.version, settings.autoCacheCurrent, settings.prefetchNext, settings.networkPolicy), RequestOwner(owner)).also { requireProfile(owner) }
    }
    suspend fun checkCatalogGaps(artist: String, limit: Int = 10): com.google.gson.JsonObject {
        val payload = com.google.gson.JsonObject().apply {
            addProperty("artist", artist)
            addProperty("limit", limit)
        }
        return api().catalogGaps(payload)
    }
    suspend fun status(): AuthStatus {
        val owner = session.cacheScope()
        val endpoint = session.endpoint
        return api().status().also {
            if (owner != session.cacheScope() || endpoint != session.endpoint) throw CancellationException("会话已变化。")
        }
    }
    suspend fun acceptAccount(account: Account?): Boolean {
        val changed = session.bindAccount(account)
        settings.bindAccount(session.activeServerId, session.account?.id)
        if (changed) {
            knownTracks.clear()
            val owner = session.cacheScope()
            withContext(Dispatchers.IO) { if (owner == session.cacheScope()) { database.queue().clear(); cache.clear(owner) } }
        }
        return changed
    }
    suspend fun updateProfile(username: String, displayName: String, email: String): Account {
        val owner = session.cacheScope() ?: throw IOException("登录已失效。")
        val endpoint = session.endpoint
        val account = session.account ?: throw IOException("尚未获取账号信息。")
        val updated = api().updateProfile(ProfileUpdate(version = account.version, username = username, displayName = displayName, email = email))
        if (owner != session.cacheScope() || endpoint != session.endpoint) throw CancellationException("会话已变化。")
        session.bindAccount(updated)
        return updated
    }
    suspend fun changePassword(current: String, next: String) {
        val owner = session.cacheScope() ?: throw IOException("登录已失效。")
        val request = session.requestState() ?: throw IOException("尚未连接服务器。")
        val base = request.endpoint
        val cookie = session.cookieFor(request)?.substringBefore(';') ?: throw IOException("登录已失效。")
        // A late password response must never clear cookies belonging to a newer login.
        val isolated = Retrofit.Builder().baseUrl(base).client(client.newBuilder().apply { interceptors().removeAll { it is ScopedSessionInterceptor }; interceptors().add(0, SelectionRequestInterceptor(request.selection) { session.requestState()?.selection }) }.cookieJar(CookieJar.NO_COOKIES).build())
            .addConverterFactory(GsonConverterFactory.create(networkGson())).build().create(Api::class.java)
        val response = isolated.changePassword(cookie, PasswordChange(current, next))
        if (owner != session.cacheScope() || base != session.endpoint) throw CancellationException("会话已变化。")
        if (!response.isSuccessful) throw HttpException(response)
    }
    suspend fun tracks(query: String = "", offset: Int = 0, collection: String? = null, collectionId: String? = null, recent: Boolean = false, role: String = "artist", sort: String = if (recent) "last_played_at" else "title", limit: Int = 50, albumFilter: String? = null, order: String? = null): Page<Track> {
        val profile = session.cacheScope()
        val snapshot = favoriteClock.get()
        val resource = if (collection != null && collectionId != null) url("api", "v1", collection, collectionId, "tracks") else url("api", "v1", "tracks")
        val target = resource.toHttpUrl().newBuilder().apply {
            addQueryParameter("sort", sort)
            if (order != null) addQueryParameter("order", order)
            if (recent) addQueryParameter("played_only", "true")
            if (collection == "artists") { addQueryParameter("role", role); if (albumFilter != null) addQueryParameter("album_id", albumFilter) }
        }.build().toString()
        return api().tracks(target, query, limit = limit, offset = offset).let { page -> requireProfile(profile); page.copy(items = page.items.map { rememberTrack(it, snapshot) }) }
    }
    private fun requireProfile(profile: String?) { if (profile == null || session.cacheScope() != profile) throw CancellationException("会话已变化。") }
    private suspend fun <T> saved(key: String, type: Class<T>): T? {
        val owner = session.cacheScope() ?: return null
        val result = withContext(Dispatchers.IO) { cache.read(key)?.let { runCatching { gson.fromJson(String(it.bytes, Charsets.UTF_8), type) }.getOrNull() } }
        requireProfile(owner); return result
    }
    private suspend fun save(key: String, value: Any, profile: String?, revision: Long? = null) = withContext(Dispatchers.IO) { cache.put(key, gson.toJson(value).toByteArray(), profile, revision = revision) }
    suspend fun playbackGain(id: String): com.google.gson.JsonObject {
        val owner = session.cacheScope(); requireProfile(owner)
        val value = api().objectGet(url("api", "v1", "tracks", id, "playback-gain"))
        requireProfile(owner); save("playback-gain:$id", value, owner); return value
    }
    suspend fun cachedPlaybackGain(id: String): com.google.gson.JsonObject? = saved("playback-gain:$id", com.google.gson.JsonObject::class.java)
    suspend fun feature(path: String, method: String = "GET", body: com.google.gson.JsonObject = com.google.gson.JsonObject(), query: Map<String, String> = emptyMap()): com.google.gson.JsonObject {
        val owner = session.cacheScope(); requireProfile(owner)
        val target = url("api", "v1", *path.split('/').toTypedArray()).toHttpUrl().newBuilder().apply { query.forEach { (key, value) -> addQueryParameter(key, value) } }.build().toString()
        val response = when (method) {
            "POST" -> api().agentPost(target, body, if (path.endsWith("/test")) AgentRequestPolicy() else null, RequestOwner(owner!!)); "PUT" -> api().agentPut(target, body, RequestOwner(owner!!))
            "DELETE" -> api().agentDelete(target, RequestOwner(owner!!)); else -> api().agentGet(target, RequestOwner(owner!!))
        }
        requireProfile(owner)
        if (!response.isSuccessful) {
            val code = response.errorBody()?.use { runCatching { gson.fromJson(it.string(), com.google.gson.JsonObject::class.java).text("detail") }.getOrDefault("") }.orEmpty()
            throw AgentApiException(response.code(), code, diagnosticId(response.headers()["X-Wildstring-Trace-Id"]))
        }
        return response.body() ?: com.google.gson.JsonObject()
    }
    suspend fun saveAvatar(bytes: ByteArray, owner: String) {
        requireProfile(owner)
        require(bytes.size <= 5 * 1024 * 1024) { "头像图片超过 5 MiB，请压缩后重试。" }
        val response = api().uploadAvatar(url("api", "v1", "auth", "avatar"), bytes.toRequestBody("application/octet-stream".toMediaType()), RequestOwner(owner))
        requireProfile(owner)
        if (!response.isSuccessful) {
            val code = response.errorBody()?.use { runCatching { gson.fromJson(it.string(), com.google.gson.JsonObject::class.java).text("detail") }.getOrDefault("") }.orEmpty()
            throw AgentApiException(response.code(), code, diagnosticId(response.headers()["X-Wildstring-Trace-Id"]))
        }
    }
    suspend fun cachedCatalog(query: CatalogQuery): CatalogPage? = saved("catalog:${query.key}", CatalogPage::class.java)?.let { it.copy(tracks = it.tracks.map { track -> rememberTrack(track) }) }
    private fun <T> Page<T>.checked(query: CatalogQuery): Page<T> {
        require(offset == query.offset && limit == CATALOG_PAGE_SIZE && total >= 0) { "列表位置发生变化，请刷新重试。" }
        require(items.size == minOf(CATALOG_PAGE_SIZE, (total - offset).coerceAtLeast(0))) { "列表读取不完整，请重试。" }
        return this
    }
    suspend fun catalog(query: CatalogQuery): CatalogPage {
        if (query.libraryId != selectedLibraryId) throw CancellationException("音乐库已切换。")
        val profile = session.cacheScope()
        val revision = cache.catalogRevision
        val page = when (query.kind) {
            "discover" -> coroutineScope {
                val albums = async { api().albums("", limit = 12) }
                val recent = async { tracks(recent = true) }
                val albumPage = albums.await()
                CatalogPage(albums = albumPage.items, tracks = recent.await().items, total = albumPage.total)
            }
            "albums" -> (if (query.collection == "artists" && query.collectionId != null) api().artistAlbums(url("api", "v1", "artists", query.collectionId, "albums"), query.query, offset = query.offset, role = query.role, sort = query.sort, order = query.order) else api().albums(query.query, offset = query.offset, sort = query.sort, order = query.order)).checked(query).let { CatalogPage(albums = it.items, total = it.total) }
            "artists" -> api().artists(query.query, offset = query.offset, role = query.role).checked(query).let { CatalogPage(artists = it.items, total = it.total) }
            "playlists" -> api().playlists(limit = 50, offset = query.offset).checked(query).let { CatalogPage(playlists = it.items, total = it.total) }
            else -> tracks(query.query, query.offset, query.collection, query.collectionId, query.kind == "recent", query.role, query.sort, albumFilter = query.albumFilter, order = query.order).checked(query).let { CatalogPage(tracks = it.items, total = it.total, discs = it.discs) }
        }
        requireProfile(profile)
        if (query.libraryId != selectedLibraryId) throw CancellationException("音乐库已切换。")
        if (revision != cache.catalogRevision) throw CancellationException("曲库已更新。")
        save("catalog:${query.key}", page, profile, revision)
        page.tracks.forEach { save("track:${it.id}", it, profile, revision) }
        if (revision != cache.catalogRevision) throw CancellationException("曲库已更新。")
        return page
    }
    suspend fun browseIndex(query: CatalogQuery): BrowseIndex? {
        if (query.libraryId != selectedLibraryId) throw CancellationException("音乐库已切换。")
        if (!query.indexed) return null
        val owner = session.cacheScope()
        val result = api().browseIndex(query.kind, query.query,
            query.collectionId.takeIf { query.collection == "artists" }, query.role.takeIf { query.collection == "artists" || query.kind == "artists" }, query.albumFilter)
        requireProfile(owner)
        if (query.libraryId != selectedLibraryId) throw CancellationException("音乐库已切换。")
        // An older server or incomplete response must not create fabricated positions.
        require(result.kind == query.kind && result.total >= 0 && result.groups.size == 28)
        require(result.groups.map { it.key } == listOf("0–9") + ('A'..'Z').map { it.toString() } + "#")
        require(result.groups.all { it.count >= 0 && (it.offset == null || it.offset in 0 until result.total) })
        return result
    }
    /** Build the complete snapshot before touching playback. Any failed page preserves the old queue. */
    suspend fun collectionTracks(query: CatalogQuery): List<Track> {
        val owner = session.cacheScope() ?: throw IOException("登录已失效。")
        val library = selectedLibraryId
        val revision = cache.catalogRevision
        val result = linkedMapOf<String, Track>()
        var offset = 0
        var expected = -1
        while (true) {
            val page = tracks(query.query, offset, query.collection, query.collectionId, query.kind == "recent", query.role, query.sort, 200, query.albumFilter, query.order)
            requireProfile(owner)
            if (library != selectedLibraryId || revision != cache.catalogRevision) throw CancellationException("音乐库或权限已变化，请重新读取。")
            if (expected == -1) { expected = page.total; require(expected <= 5000) { "集合超过 5000 首，请筛选后播放。" } }
            require(expected == page.total) { "集合已变化，请重试。" }
            if (page.items.isEmpty()) { require(offset >= expected) { "集合读取不完整，请重试。" }; break }
            page.items.forEach { result[it.id] = it }
            offset += page.items.size
            if (offset >= expected) break
        }
        require(result.size == expected) { "集合已变化，请重试。" }
        return result.values.toList()
    }
    suspend fun cachedTrack(id: String): Track? = saved("track:$id", Track::class.java)?.let { rememberTrack(it) }
    suspend fun track(id: String): Track {
        val profile = session.cacheScope()
        val snapshot = favoriteClock.get()
        podcastEpisodeId(id)?.let { episodeId ->
            return try {
                val episode = podcastEpisode(episodeId)
                val podcast = podcasts().firstOrNull { it.id == episode.podcastId } ?: throw IOException("节目已移除。")
                requireProfile(profile)
                rememberPodcastEpisode(episode, podcast)
            } catch (error: IOException) {
                if (error is javax.net.ssl.SSLException || profile != session.cacheScope()) throw error
                cachedTrack(id) ?: throw error
            }
        }
        return try { api().track(url("api", "v1", "tracks", id)).let { requireProfile(profile); val merged = rememberTrack(it, snapshot); downloads.refreshTrack(merged); save("track:$id", merged, profile); requireProfile(profile); rememberTrack(merged, snapshot) } }
        catch (error: HttpException) { if (profile == session.cacheScope() && error.code() in listOf(401, 403, 404)) downloads.remove(id); throw error }
        catch (error: IOException) {
            if (error is javax.net.ssl.SSLException || session.cacheScope() != profile) throw error
            (downloads.track(id) ?: saved("track:$id", Track::class.java) ?: throw error).let { requireProfile(profile); rememberTrack(it) }
        }
    }
    suspend fun cachedLyrics(id: String): Lyrics? = saved("lyrics:$id", Lyrics::class.java)
    suspend fun lyrics(id: String): Lyrics {
        val profile = session.cacheScope()
        return api().lyrics(url("api", "v1", "tracks", id, "lyrics")).also { requireProfile(profile); save("lyrics:$id", it, profile); requireProfile(profile) }
    }
    suspend fun favorite(track: Track): Track {
        val profile = session.cacheScope()
        favoriteChanged(track.id)
        api().favorite(url("api", "v1", "tracks", track.id, "favorite"), FavoriteRequest(!track.loved)).close()
        requireProfile(profile)
        val updated = publishFavorite(track.copy(loved = !track.loved))
        save("track:${updated.id}", updated, profile)
        requireProfile(profile)
        return publishFavorite(updated)
    }
    suspend fun feedback(body: RecommendationFeedback): okhttp3.ResponseBody {
        val profile = session.cacheScope()
        return api().recommendationFeedback(body, RequestOwner(profile)).also { response ->
            if (profile == null || profile != session.cacheScope()) { response.close(); throw CancellationException("会话已变化。") }
        }
    }
    suspend fun logout() {
        val target = url("api", "v1", "auth", "logout")
        val cookie = session.read()?.substringBefore(';')
        client.dispatcher.cancelAll()
        cache.clear(); session.invalidate(); knownTracks.clear(); database.queue().clear()
        settings.bindAccount(session.activeServerId, session.account?.id)
        withContext(Dispatchers.IO) {
            if (cookie != null) client.newBuilder().apply { interceptors().clear(); networkInterceptors().clear() }.cookieJar(CookieJar.NO_COOKIES).build().newCall(
                Request.Builder().url(target).header("Cookie", cookie).post("".toRequestBody()).build()
            ).execute().close()
        }
    }
}
fun friendlyError(error: Throwable): String = (when (error) {
    is AgentApiException -> error.message ?: "操作未完成，请重试。"
    is HttpException -> when (error.code()) {
        400 -> when {
            error.response()?.errorBody()?.string()?.contains("current_password_incorrect") == true -> "当前密码不正确。"
            else -> "服务器拒绝此访问地址，请检查域名白名单或输入内容。"
        }
        422 -> "输入不符合服务器要求，请检查后重试。"
        401 -> "登录已失效，请重新登录。"
        403 -> "服务器拒绝请求，请检查服务版本与权限。"
        404 -> "内容不存在或已经移除。"
        409 -> "内容已变化，请刷新后重试。"
        429 -> "尝试次数较多，请稍后一分钟重试。"
        503 -> "服务暂不可用，请确认已在服务端初始化管理员。"
        else -> "服务器请求未完成（${error.code()}），请重试。"
    }
    is javax.net.ssl.SSLException -> "HTTPS 证书校验失败，请检查服务器证书。"
    is IllegalArgumentException -> error.message ?: "输入无效。"
    is IOException -> "无法连接服务器，请检查地址和网络。"
    else -> "操作未完成，请重试。"
}) + (if (error is HttpException) diagnosticId(error.response()?.headers()?.get("X-Wildstring-Trace-Id"))?.let { "\n诊断编号：$it" }.orEmpty() else "")
