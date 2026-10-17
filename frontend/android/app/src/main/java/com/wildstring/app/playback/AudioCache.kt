@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
package com.wildstring.app.playback

import android.content.Context
import android.net.Uri
import androidx.media3.common.C
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.*
import androidx.media3.datasource.cache.*
import androidx.media3.datasource.okhttp.OkHttpDataSource
import com.wildstring.app.data.*
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import java.io.IOException
import java.util.TreeSet
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/** Cache writes follow playback only: no downloads or speculative prefetch. */
@Singleton
class AudioCache @Inject constructor(@ApplicationContext context: Context, private val session: SessionStore, private val settings: AppSettings) {
    private val evictor = ResizableLruEvictor(settings.state.value.audioMb * 1024L * 1024) { key -> session.retainedStorageScopes().any { key.startsWith("$it:") } }
    val cache = SimpleCache(File(context.cacheDir, "recent-audio-v1"), evictor, StandaloneDatabaseProvider(context))
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    init {
        scope.launch { settings.state.collectLatest { synchronized(cache) { evictor.resize(cache, it.audioMb * 1024L * 1024) } } }
        scope.launch { session.retainedScopes.collectLatest { profiles ->
            synchronized(cache) { cache.keys.filter { key -> profiles.none { key.startsWith("$it:") } }.forEach(cache::removeResource) }
        } }
    }
    fun clear(expected: String? = session.cacheScope()) { synchronized(cache) { session.withStorageScope(expected) { owner -> cache.keys.filter { key -> key.startsWith("$owner:") }.forEach(cache::removeResource) } } }
    fun bytes(): Long = session.storageScope()?.let { owner -> cache.keys.filter { it.startsWith("$owner:") }.sumOf { key -> cache.getCachedSpans(key).sumOf { it.length } } } ?: 0
    private fun validateCached(key: String, url: String, client: OkHttpClient) {
        if (cache.getCachedSpans(key).isEmpty()) return
        val metadata = cache.getContentMetadata(key)
        if (System.currentTimeMillis() - metadata.get("wildstring-verified", 0L) < 6 * 60 * 60_000) return
        val response = try {
            client.newBuilder().connectTimeout(3, TimeUnit.SECONDS).readTimeout(3, TimeUnit.SECONDS).callTimeout(4, TimeUnit.SECONDS).build()
                .newCall(Request.Builder().url(url).head().build()).execute()
        } catch (error: IOException) { if (error is javax.net.ssl.SSLException) throw error; return }
        response.use {
            if (it.code in listOf(401, 403, 404, 409)) { cache.removeResource(key); throw IOException("音频已失效或无权访问。") }
            if (!it.isSuccessful) return
            val etag = it.header("ETag")
            if (etag == null || etag != metadata.get("wildstring-etag", "")) cache.removeResource(key)
            else cache.applyContentMetadataMutations(key, ContentMetadataMutations().set("wildstring-verified", System.currentTimeMillis()))
        }
    }
    fun factory(client: OkHttpClient): DataSource.Factory = DataSource.Factory {
        var profile: String? = null
        var storage: String? = null
        var key: String? = null
        val upstream = OkHttpDataSource.Factory(client)
        val cached = CacheDataSource.Factory().setCache(cache).setUpstreamDataSourceFactory(upstream)
            .setCacheKeyFactory { spec -> "${storage ?: throw IOException("登录已失效。")}:${spec.uri}" }
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
        val source = if (settings.state.value.audioMb == 0) upstream.createDataSource() else cached.createDataSource()
        object : DataSource {
            override fun addTransferListener(listener: TransferListener) = source.addTransferListener(listener)
            override fun open(dataSpec: DataSpec): Long {
                val base = session.endpoint ?: throw IOException("尚未连接服务器。")
                val target = dataSpec.uri.toString().toHttpUrlOrNull() ?: throw IOException("无效音频地址。")
                profile = session.cacheScope() ?: throw IOException("登录已失效。")
                if (!ServerAddress.contains(base, target) || !target.encodedPath.endsWith("/stream")) throw IOException("拒绝其他来源的音频。")
                storage = session.storageScope() ?: throw IOException("登录已失效。")
                key = "$storage:${dataSpec.uri}"
                if (settings.state.value.audioMb > 0) validateCached(key!!, dataSpec.uri.toString(), client)
                if (profile != session.cacheScope()) throw IOException("登录已失效。")
                val length = source.open(dataSpec)
                val etag = source.responseHeaders.entries.firstOrNull { it.key.equals("ETag", true) }?.value?.firstOrNull()
                if (etag != null && profile == session.cacheScope()) cache.applyContentMetadataMutations(key!!, ContentMetadataMutations()
                    .set("wildstring-etag", etag).set("wildstring-verified", System.currentTimeMillis()))
                return length
            }
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                if (profile == null || profile != session.cacheScope()) throw IOException("登录已失效。")
                return source.read(buffer, offset, length)
            }
            override fun getUri(): Uri? = source.uri
            override fun getResponseHeaders(): Map<String, List<String>> = source.responseHeaders
            override fun close() = source.close()
        }
    }
}

/** All callbacks and resize execute under the SimpleCache monitor. */
private class ResizableLruEvictor(private var limit: Long, private val allowed: (String) -> Boolean) : CacheEvictor {
    private val spans = TreeSet<CacheSpan>(compareBy<CacheSpan> { it.lastTouchTimestamp }.thenBy { it.key }.thenBy { it.position })
    private var size = 0L
    override fun requiresCacheSpanTouches() = true
    override fun onCacheInitialized() = Unit
    override fun onStartFile(cache: Cache, key: String, position: Long, length: Long) { if (length != C.LENGTH_UNSET.toLong()) evict(cache, length) }
    override fun onSpanAdded(cache: Cache, span: CacheSpan) { if (spans.add(span)) size += span.length; if (!allowed(span.key)) cache.removeSpan(span); evict(cache, 0) }
    override fun onSpanRemoved(cache: Cache, span: CacheSpan) { if (spans.remove(span)) size -= span.length }
    override fun onSpanTouched(cache: Cache, oldSpan: CacheSpan, newSpan: CacheSpan) { onSpanRemoved(cache, oldSpan); onSpanAdded(cache, newSpan) }
    fun resize(cache: Cache, bytes: Long) { limit = bytes; evict(cache, 0) }
    private fun evict(cache: Cache, incoming: Long) { while (size + incoming > limit && spans.isNotEmpty()) cache.removeSpan(spans.first()) }
}
