package com.wildstring.app.data

import java.io.IOException
import com.google.gson.Gson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton
import okhttp3.OkHttpClient
import okhttp3.CookieJar
import okhttp3.Request
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.RequestBody.Companion.toRequestBody
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import retrofit2.HttpException
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

data class CatalogQuery(val tab: String = "search", val kind: String = "discover", val title: String = "发现",
    val query: String = "", val offset: Int = 0, val collection: String? = null, val collectionId: String? = null,
    val playlist: Playlist? = null, val role: String = "artist", val sort: String = "title", val albumFilter: String? = null) {
    val indexed: Boolean get() = kind in listOf("tracks", "albums", "artists") && sort == "title" &&
        collection != "playlists" && collection != "albums" && albumFilter == null
    val key: String get() = Gson().toJson(listOf(tab, kind, query, offset, collection, collectionId, role, sort, albumFilter))
}
data class CatalogPage(val tracks: List<Track> = emptyList(), val albums: List<Album> = emptyList(),
    val artists: List<Artist> = emptyList(), val playlists: List<Playlist> = emptyList(), val total: Int = 0)

@Singleton
class Repository @Inject constructor(val session: SessionStore, val client: OkHttpClient, val database: QueueDatabase, val cache: ClientCache, val settings: AppSettings, val downloads: OfflineDownloads) {
    private val gson = Gson()
    private var cachedUrl: String? = null
    private var cachedApi: Api? = null
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
        val key = "$base|$selection"
        if (cachedUrl != key) {
            val scoped = client.newBuilder().apply { interceptors().add(0, SelectionRequestInterceptor(selection) { session.requestState()?.selection }) }.build()
            cachedApi = Retrofit.Builder().baseUrl(base).client(scoped).addConverterFactory(GsonConverterFactory.create(networkGson())).build().create(Api::class.java)
            cachedUrl = key
        }
        return checkNotNull(cachedApi)
    }
    fun url(vararg segments: String): String {
        val builder = (session.endpoint ?: throw IOException("请先连接服务器。")).newBuilder()
        segments.forEach { builder.addPathSegment(it) }
        return builder.build().toString()
    }
    fun cover(id: String): String = url("api", "v1", "tracks", id, "cover") + "?size=768"
    fun originalStream(id: String): String = url("api", "v1", "tracks", id, "stream")
    fun stream(id: String): String = PlaybackRequest.url(originalStream(id), if (downloads.file(id) != null) 0 else settings.state.value.aacBitrate)
    suspend fun status(): AuthStatus {
        val owner = session.cacheScope()
        val endpoint = session.endpoint
        return api().status().also {
            if (owner != session.cacheScope() || endpoint != session.endpoint) throw CancellationException("会话已变化。")
        }
    }
    suspend fun acceptAccount(account: Account?): Boolean {
        val changed = session.bindAccount(account)
        if (changed) {
            knownTracks.clear()
            val owner = session.cacheScope()
            withContext(Dispatchers.IO) { if (owner == session.cacheScope()) { database.queue().clear(); cache.clear(owner) } }
        }
        return changed
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
    suspend fun tracks(query: String = "", offset: Int = 0, collection: String? = null, collectionId: String? = null, recent: Boolean = false, role: String = "artist", sort: String = if (recent) "last_played_at" else "title", limit: Int = 50, albumFilter: String? = null): Page<Track> {
        val profile = session.cacheScope()
        val snapshot = favoriteClock.get()
        val resource = if (collection != null && collectionId != null) url("api", "v1", collection, collectionId, "tracks") else url("api", "v1", "tracks")
        val target = resource.toHttpUrl().newBuilder().apply {
            addQueryParameter("sort", sort)
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
    suspend fun cachedCatalog(query: CatalogQuery): CatalogPage? = saved("catalog:${query.key}", CatalogPage::class.java)?.let { it.copy(tracks = it.tracks.map { track -> rememberTrack(track) }) }
    private fun <T> Page<T>.checked(query: CatalogQuery): Page<T> {
        require(offset == query.offset && limit == CATALOG_PAGE_SIZE && total >= 0) { "列表位置发生变化，请刷新重试。" }
        require(items.size == minOf(CATALOG_PAGE_SIZE, (total - offset).coerceAtLeast(0))) { "列表读取不完整，请重试。" }
        return this
    }
    suspend fun catalog(query: CatalogQuery): CatalogPage {
        val profile = session.cacheScope()
        val revision = cache.catalogRevision
        val page = when (query.kind) {
            "discover" -> coroutineScope {
                val albums = async { api().albums("", limit = 12) }
                val recent = async { tracks(recent = true) }
                val albumPage = albums.await()
                CatalogPage(albums = albumPage.items, tracks = recent.await().items, total = albumPage.total)
            }
            "albums" -> (if (query.collection == "artists" && query.collectionId != null) api().artistAlbums(url("api", "v1", "artists", query.collectionId, "albums"), query.query, offset = query.offset, role = query.role) else api().albums(query.query, offset = query.offset)).checked(query).let { CatalogPage(albums = it.items, total = it.total) }
            "artists" -> api().artists(query.query, offset = query.offset, role = query.role).checked(query).let { CatalogPage(artists = it.items, total = it.total) }
            "playlists" -> api().playlists(limit = 50, offset = query.offset).checked(query).let { CatalogPage(playlists = it.items, total = it.total) }
            else -> tracks(query.query, query.offset, query.collection, query.collectionId, query.kind == "recent", query.role, query.sort, albumFilter = query.albumFilter).checked(query).let { CatalogPage(tracks = it.items, total = it.total) }
        }
        requireProfile(profile)
        if (revision != cache.catalogRevision) throw CancellationException("曲库已更新。")
        save("catalog:${query.key}", page, profile, revision)
        page.tracks.forEach { save("track:${it.id}", it, profile, revision) }
        if (revision != cache.catalogRevision) throw CancellationException("曲库已更新。")
        return page
    }
    suspend fun browseIndex(query: CatalogQuery): BrowseIndex? {
        if (!query.indexed) return null
        val owner = session.cacheScope()
        val result = api().browseIndex(query.kind, query.query,
            query.collectionId.takeIf { query.collection == "artists" }, query.role.takeIf { query.collection == "artists" || query.kind == "artists" }, query.albumFilter)
        requireProfile(owner)
        // An older server or incomplete response must not create fabricated positions.
        require(result.kind == query.kind && result.total >= 0 && result.groups.size == 28)
        require(result.groups.map { it.key } == listOf("0–9") + ('A'..'Z').map { it.toString() } + "#")
        require(result.groups.all { it.count >= 0 && (it.offset == null || it.offset in 0 until result.total) })
        return result
    }
    /** Build the complete snapshot before touching playback. Any failed page preserves the old queue. */
    suspend fun collectionTracks(query: CatalogQuery): List<Track> {
        val owner = session.cacheScope() ?: throw IOException("登录已失效。")
        val result = linkedMapOf<String, Track>()
        var offset = 0
        var expected = -1
        while (true) {
            val page = tracks(query.query, offset, query.collection, query.collectionId, query.kind == "recent", query.role, query.sort, 200, query.albumFilter)
            requireProfile(owner)
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
        withContext(Dispatchers.IO) {
            if (cookie != null) client.newBuilder().apply { interceptors().clear(); networkInterceptors().clear() }.cookieJar(CookieJar.NO_COOKIES).build().newCall(
                Request.Builder().url(target).header("Cookie", cookie).post("".toRequestBody()).build()
            ).execute().close()
        }
    }
}
fun friendlyError(error: Throwable): String = when (error) {
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
}
