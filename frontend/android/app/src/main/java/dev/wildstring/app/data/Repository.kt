package dev.wildstring.app.data

import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import okhttp3.OkHttpClient
import retrofit2.HttpException
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

@Singleton
class Repository @Inject constructor(val session: SessionStore, val client: OkHttpClient, val database: QueueDatabase) {
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
        val resource = if (collection != null && collectionId != null) url("api", "v1", collection, collectionId, "tracks") else url("api", "v1", "tracks")
        val target = if (recent) "$resource?played_only=true&sort=last_played_at" else resource
        return api().tracks(target, query, offset = offset).also { page -> page.items.forEach { knownTracks[it.id] = it } }
    }
    suspend fun track(id: String): Track = api().track(url("api", "v1", "tracks", id)).also { knownTracks[it.id] = it }
    suspend fun lyrics(id: String): Lyrics = api().lyrics(url("api", "v1", "tracks", id, "lyrics"))
    suspend fun favorite(track: Track): Track {
        api().favorite(url("api", "v1", "tracks", track.id, "favorite"), FavoriteRequest(!track.loved)).close()
        return track.copy(loved = !track.loved).also { knownTracks[it.id] = it }
    }
    suspend fun logout() {
        try { api().logout() } finally {
            session.invalidate(); client.dispatcher.cancelAll(); knownTracks.clear(); database.queue().clear()
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
