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
import okhttp3.RequestBody.Companion.toRequestBody
import kotlinx.coroutines.CancellationException
import retrofit2.HttpException
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

data class CatalogQuery(val tab: String = "library", val kind: String = "albums", val title: String = "曲库",
    val query: String = "", val offset: Int = 0, val collection: String? = null, val collectionId: String? = null,
    val playlist: Playlist? = null) {
    val key: String get() = Gson().toJson(listOf(tab, kind, query, offset, collection, collectionId))
}
data class CatalogPage(val tracks: List<Track> = emptyList(), val albums: List<Album> = emptyList(),
    val artists: List<Artist> = emptyList(), val playlists: List<Playlist> = emptyList(), val total: Int = 0)

@Singleton
class Repository @Inject constructor(val session: SessionStore, val client: OkHttpClient, val database: QueueDatabase, val cache: ClientCache) {
    private val gson = Gson()
    private var cachedUrl: String? = null
    private var cachedApi: Api? = null
    val knownTracks = java.util.concurrent.ConcurrentHashMap<String, Track>()
    @Synchronized fun api(): Api {
        val base = session.endpoint ?: throw IOException("请先连接服务器。")
        if (cachedUrl != base.toString()) {
            cachedApi = Retrofit.Builder().baseUrl(base).client(client).addConverterFactory(GsonConverterFactory.create()).build().create(Api::class.java)
            cachedUrl = base.toString()
        }
        return checkNotNull(cachedApi)
    }
    fun url(vararg segments: String): String {
        val builder = (session.endpoint ?: throw IOException("请先连接服务器。")).newBuilder()
        segments.forEach { builder.addPathSegment(it) }
        return builder.build().toString()
    }
    fun cover(id: String): String = url("api", "v1", "tracks", id, "cover") + "?size=768"
    fun stream(id: String): String = url("api", "v1", "tracks", id, "stream")
    suspend fun tracks(query: String = "", offset: Int = 0, collection: String? = null, collectionId: String? = null, recent: Boolean = false): Page<Track> {
        val profile = session.cacheScope()
        val resource = if (collection != null && collectionId != null) url("api", "v1", collection, collectionId, "tracks") else url("api", "v1", "tracks")
        val target = if (recent) "$resource?played_only=true&sort=last_played_at" else resource
        return api().tracks(target, query, offset = offset).also { page -> requireProfile(profile); page.items.forEach { knownTracks[it.id] = it } }
    }
    private fun requireProfile(profile: String?) { if (profile == null || session.cacheScope() != profile) throw CancellationException("会话已变化。") }
    private suspend fun <T> saved(key: String, type: Class<T>): T? = withContext(Dispatchers.IO) {
        cache.read(key)?.let { runCatching { gson.fromJson(String(it.bytes, Charsets.UTF_8), type) }.getOrNull() }
    }
    private suspend fun save(key: String, value: Any, profile: String?, revision: Long? = null) = withContext(Dispatchers.IO) { cache.put(key, gson.toJson(value).toByteArray(), profile, revision = revision) }
    suspend fun cachedCatalog(query: CatalogQuery): CatalogPage? = saved("catalog:${query.key}", CatalogPage::class.java)?.also { remember(it.tracks) }
    private suspend fun remember(tracks: List<Track>) {
        tracks.forEach { knownTracks[it.id] = it }
    }
    suspend fun catalog(query: CatalogQuery): CatalogPage {
        val profile = session.cacheScope()
        val revision = cache.catalogRevision
        val page = when (query.kind) {
            "albums" -> api().albums(query.query, offset = query.offset).let { CatalogPage(albums = it.items, total = it.total) }
            "artists" -> api().artists(query.query, offset = query.offset).let { CatalogPage(artists = it.items, total = it.total) }
            "playlists" -> api().playlists(limit = 50, offset = query.offset).let { CatalogPage(playlists = it.items, total = it.total) }
            else -> tracks(query.query, query.offset, query.collection, query.collectionId, query.kind == "recent").let { CatalogPage(tracks = it.items, total = it.total) }
        }
        requireProfile(profile)
        if (revision != cache.catalogRevision) throw CancellationException("曲库已更新。")
        save("catalog:${query.key}", page, profile, revision)
        page.tracks.forEach { save("track:${it.id}", it, profile, revision) }
        if (revision != cache.catalogRevision) throw CancellationException("曲库已更新。")
        return page
    }
    suspend fun cachedTrack(id: String): Track? = saved("track:$id", Track::class.java)?.also { knownTracks[it.id] = it }
    suspend fun track(id: String): Track {
        val profile = session.cacheScope()
        return try { api().track(url("api", "v1", "tracks", id)).also { requireProfile(profile); save("track:$id", it, profile); requireProfile(profile); knownTracks[it.id] = it } }
        catch (error: IOException) {
            if (error is javax.net.ssl.SSLException || session.cacheScope() != profile) throw error
            (saved("track:$id", Track::class.java) ?: throw error).also { requireProfile(profile); knownTracks[it.id] = it }
        }
    }
    suspend fun cachedLyrics(id: String): Lyrics? = saved("lyrics:$id", Lyrics::class.java)
    suspend fun lyrics(id: String): Lyrics {
        val profile = session.cacheScope()
        return api().lyrics(url("api", "v1", "tracks", id, "lyrics")).also { save("lyrics:$id", it, profile) }
    }
    suspend fun favorite(track: Track): Track {
        val profile = session.cacheScope()
        api().favorite(url("api", "v1", "tracks", track.id, "favorite"), FavoriteRequest(!track.loved)).close()
        requireProfile(profile)
        return track.copy(loved = !track.loved).also { save("track:${it.id}", it, profile); requireProfile(profile); knownTracks[it.id] = it }
    }
    suspend fun logout() {
        val target = url("api", "v1", "auth", "logout")
        val cookie = session.read()?.substringBefore(';')
        client.dispatcher.cancelAll()
        session.invalidate(); knownTracks.clear(); database.queue().clear()
        withContext(Dispatchers.IO) {
            cache.clear()
            if (cookie != null) client.newBuilder().cookieJar(CookieJar.NO_COOKIES).build().newCall(
                Request.Builder().url(target).header("Cookie", cookie).post("".toRequestBody()).build()
            ).execute().close()
        }
    }
}
fun friendlyError(error: Throwable): String = when (error) {
    is HttpException -> when (error.code()) {
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
