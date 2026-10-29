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
    private val metadataRoot = File(context.cacheDir, "private-metadata-v2")
    private val artworkRoot = File(context.cacheDir, "private-artwork-v2")
    private var metadata = BoundedFileStore(File(metadataRoot, "unselected"))
    private var artwork = BoundedFileStore(File(artworkRoot, "unselected"))
    private val prefs = context.getSharedPreferences("cache_owner", Context.MODE_PRIVATE)
    @Volatile var catalogRevision: Long = 0
        private set
    private fun scopedKey(profile: String, key: String) = if (key.startsWith("catalog:")) "$profile:$catalogRevision:$key" else "$profile:$key"
    private var owner: String? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    init {
        // Preserve the old single-server cache keys and original ownership token.
        val previous = prefs.getString("scope", null)
        listOf(File(context.cacheDir, "private-metadata-v1") to metadataRoot, File(context.cacheDir, "private-artwork-v1") to artworkRoot).forEach { (old, root) ->
            if (old.exists()) {
                if (previous != null && previous in session.retainedStorageScopes()) {
                    val target = File(root, previous).apply { mkdirs() }
                    old.listFiles()?.forEach { it.renameTo(File(target, it.name)) }
                    prefs.edit().putLong("revision:$previous", prefs.getLong("catalog_revision", 0)).apply()
                }
                old.deleteRecursively()
            }
        }
        scope.launch { session.profiles.collectLatest { synchronized(this@ClientCache) { ensureOwner() } } }
        scope.launch { session.retainedScopes.collectLatest { synchronized(this@ClientCache) { prune(); ensureOwner() } } }
        scope.launch { settings.state.collectLatest { trim() } }
    }
    private fun prune() {
        val keep = session.retainedStorageScopes()
        listOf(metadataRoot, artworkRoot).forEach { root -> root.listFiles()?.filter { it.name !in keep }?.forEach { it.deleteRecursively() } }
    }
    @Synchronized private fun ensureOwner(): String? {
        val current = session.storageScope()
        if (owner != current) {
            owner = current
            metadata = BoundedFileStore(File(metadataRoot, current ?: "unselected"))
            artwork = BoundedFileStore(File(artworkRoot, current ?: "unselected"))
            catalogRevision = prefs.getLong("revision:$current", 0)
        }
        prune(); return current
    }
    @Synchronized fun read(key: String, cover: Boolean = false): CachedBlob? {
        val token = session.cacheScope()
        return session.withStorageScope(token) { profile ->
            ensureOwner()
            val limit = if (cover) settings.state.value.artworkMb else settings.state.value.metadataMb
            if (limit == 0) null else (if (cover) artwork else metadata).read(scopedKey(profile, key))
        }
    }
    @Synchronized fun put(key: String, bytes: ByteArray, profile: String?, cover: Boolean = false, revision: Long? = null) {
        session.withStorageScope(profile) { storage ->
            ensureOwner()
            if (revision == null || revision == catalogRevision) {
                val limit = if (cover) settings.state.value.artworkMb else settings.state.value.metadataMb
                if (bytes.size <= 2 * 1024 * 1024) runCatching { (if (cover) artwork else metadata).put(scopedKey(storage, key), bytes, limit * 1024L * 1024) }
            }
        }
    }
    @Synchronized fun clear(expected: String? = session.cacheScope()) {
        session.withStorageScope(expected) { ensureOwner(); metadata.clear(); artwork.clear() }
        ensureOwner()
    }
    @Synchronized fun invalidateCatalog(expected: String? = session.cacheScope()) {
        session.withStorageScope(expected) { ensureOwner(); catalogRevision++; prefs.edit().putLong("revision:$owner", catalogRevision).apply() }
    }
    @Synchronized fun trim() {
        session.withStorageScope(session.cacheScope()) { ensureOwner(); metadata.trim(settings.state.value.metadataMb * 1024L * 1024); artwork.trim(settings.state.value.artworkMb * 1024L * 1024) }
        ensureOwner()
    }
    @Synchronized fun usage(): Pair<Long, Long> = session.withStorageScope(session.cacheScope()) { ensureOwner(); metadata.size() to artwork.size() } ?: (0L to 0L)

}

/** Bounded per-account artwork cache; public podcast images use a separate cookie-free client. */
class CoverCacheInterceptor(private val cache: ClientCache, private val session: SessionStore,
    private val accepts: (okhttp3.Request) -> Boolean = { it.url.encodedPath.endsWith("/cover") }) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.method != "GET" || !accepts(request)) return chain.proceed(request)
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
