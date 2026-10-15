package com.wildstring.app.data

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Interceptor
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody

@Singleton
class ClientCache @Inject constructor(@ApplicationContext context: Context, private val session: SessionStore, private val settings: AppSettings) {
    private val metadata = BoundedFileStore(File(context.cacheDir, "private-metadata-v1"))
    private val artwork = BoundedFileStore(File(context.cacheDir, "private-artwork-v1"))
    private val prefs = context.getSharedPreferences("cache_owner", Context.MODE_PRIVATE)
    @Volatile var catalogRevision: Long = prefs.getLong("catalog_revision", 0)
        private set
    private fun scopedKey(profile: String, key: String) = if (key.startsWith("catalog:")) "$profile:$catalogRevision:$key" else "$profile:$key"
    private var owner: String? = prefs.getString("scope", null)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    init {
        scope.launch { session.profiles.collectLatest { synchronized(this@ClientCache) { ensureOwner() } } }
        scope.launch { settings.state.collectLatest { trim() } }
    }
    @Synchronized private fun ensureOwner(): String? {
        val current = session.cacheScope()
        if (owner != current) {
            metadata.clear(); artwork.clear(); owner = current
            prefs.edit().putString("scope", current).apply()
        }
        return current
    }
    @Synchronized fun read(key: String, cover: Boolean = false): CachedBlob? {
        val profile = ensureOwner() ?: return null
        val limit = if (cover) settings.state.value.artworkMb else settings.state.value.metadataMb
        val saved = if (limit == 0) null else (if (cover) artwork else metadata).read(scopedKey(profile, key))
        return saved.takeIf { session.cacheScope() == profile }
    }
    @Synchronized fun put(key: String, bytes: ByteArray, profile: String?, cover: Boolean = false, revision: Long? = null) {
        if (profile == null || ensureOwner() != profile || (revision != null && revision != catalogRevision)) return
        val limit = if (cover) settings.state.value.artworkMb else settings.state.value.metadataMb
        if (bytes.size <= 2 * 1024 * 1024) runCatching { (if (cover) artwork else metadata).put(scopedKey(profile, key), bytes, limit * 1024L * 1024) }
    }
    @Synchronized fun clear() { metadata.clear(); artwork.clear() }
    @Synchronized fun invalidateCatalog() { catalogRevision++; prefs.edit().putLong("catalog_revision", catalogRevision).apply() }
    @Synchronized fun trim() { metadata.trim(settings.state.value.metadataMb * 1024L * 1024); artwork.trim(settings.state.value.artworkMb * 1024L * 1024) }
    fun usage(): Pair<Long, Long> = metadata.size() to artwork.size()
}

/** Covers use the same authenticated client; no cookie, login or error response is persisted. */
class CoverCacheInterceptor(private val cache: ClientCache, private val session: SessionStore) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.method != "GET" || !request.url.encodedPath.endsWith("/cover")) return chain.proceed(request)
        val profile = session.cacheScope()
        val saved = cache.read(request.url.toString(), cover = true)
        fun cached(): Response = Response.Builder().request(request).protocol(okhttp3.Protocol.HTTP_1_1).code(200).message("Private cover cache")
            .body(saved!!.bytes.toResponseBody("image/*".toMediaTypeOrNull())).build()
        if (saved != null && System.currentTimeMillis() - saved.writtenAt < 24 * 60 * 60_000 && session.cacheScope() == profile) return cached()
        val response = try { chain.proceed(request) } catch (error: IOException) {
            if (saved != null && profile != null && session.cacheScope() == profile && error !is javax.net.ssl.SSLException) return cached()
            throw error
        }
        if (!response.isSuccessful || response.body == null) return response
        val bytes = response.peekBody(2 * 1024L * 1024 + 1).bytes()
        if (bytes.size <= 2 * 1024 * 1024) cache.put(request.url.toString(), bytes, profile, cover = true)
        return response
    }
}
