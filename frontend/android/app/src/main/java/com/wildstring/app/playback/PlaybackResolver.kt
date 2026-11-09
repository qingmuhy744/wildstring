@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
package com.wildstring.app.playback

import android.net.Uri
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import com.google.gson.Gson
import com.wildstring.app.AppLanguage
import com.wildstring.app.R
import com.wildstring.app.data.*
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request

class PlaybackResolutionException(message: String) : IOException(message)

/** Resolves on Media3's loader thread, including when the next queue item starts in the background. */
@Singleton
class PlaybackResolver @Inject constructor(private val session: SessionStore, private val client: OkHttpClient, private val cache: ClientCache, private val downloads: OfflineDownloads) {
    private val gson = Gson()
    private data class Resolved(val value: PlaybackPlan, val at: Long)
    private val plans = object : LinkedHashMap<String, Resolved>(32, .75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Resolved>?) = size > 128
    }
    private val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.IO)
    init {
        scope.launch { session.profiles.collect { owner -> synchronized(this@PlaybackResolver) {
            plans.keys.removeAll { owner == null || !it.startsWith("$owner:") }
        } } }
    }
    private val changed = MutableSharedFlow<Unit>(extraBufferCapacity = 16)
    val changes = changed.asSharedFlow()
    @Synchronized internal fun plan(uri: String): PlaybackPlan? = if (downloads.fileForStream(uri) != null)
        PlaybackPlan("original", null, AudioOutput(downloads.formatForStream(uri) ?: "original"), 0, 0, uri)
        else session.cacheScope()?.let { plans["$it:$uri"]?.value }

    private fun resolve(uri: String): PlaybackPlan {
        val profile = session.cacheScope() ?: throw PlaybackResolutionException(AppLanguage.string(R.string.pb_res_login_expired))
        val base = session.endpoint ?: throw PlaybackResolutionException(AppLanguage.string(R.string.pb_res_not_connected))
        val target = uri.toHttpUrl()
        if (!ServerAddress.contains(base, target) || !target.encodedPath.endsWith("/stream")) throw PlaybackResolutionException(AppLanguage.string(R.string.pb_res_foreign_source_rejected))
        val key = "playback:$uri"
        val recent = synchronized(this) { plans["$profile:$uri"] }
        if (recent != null && android.os.SystemClock.elapsedRealtime() - recent.at < 15_000) return recent.value
        val cached = recent?.value ?: cache.read(key)?.let {
            runCatching { gson.fromJson(String(it.bytes, Charsets.UTF_8), PlaybackPlan::class.java) }.getOrNull()
        }
        val info = try {
            val probe = target.newBuilder().encodedPath(target.encodedPath.removeSuffix("/stream") + "/playback").build()
            client.newCall(Request.Builder().url(probe).build()).execute().use { response ->
                if (!response.isSuccessful) throw PlaybackResolutionException(when (response.code) {
                    401 -> AppLanguage.string(R.string.pb_res_login_expired_relogin)
                    404, 409 -> trackPlaybackMessage(response.code, response.peekBody(8192).string())
                    429 -> AppLanguage.string(R.string.pb_res_transcode_busy)
                    503 -> AppLanguage.string(R.string.pb_res_transcode_unavailable)
                    else -> AppLanguage.string(R.string.pb_res_info_failed)
                })
                val bytes = response.peekBody(128 * 1024L + 1).bytes()
                if (bytes.size > 128 * 1024) throw PlaybackResolutionException(AppLanguage.string(R.string.pb_res_info_too_large))
                runCatching { gson.fromJson(String(bytes, Charsets.UTF_8), PlaybackPlan::class.java) }
                    .getOrElse { throw PlaybackResolutionException(AppLanguage.string(R.string.pb_res_invalid_info)) }
            }
        } catch (error: IOException) {
            if (error is javax.net.ssl.SSLException || error is PlaybackResolutionException || session.cacheScope() != profile) throw error
            cached ?: throw error
        }
        if (profile != session.cacheScope()) throw PlaybackResolutionException(AppLanguage.string(R.string.pb_res_login_expired))
        try {
            require(info.mode in listOf("original", "transcode") && info.startMs >= 0)
            require(info.mode != "transcode" || (info.output.codec == "aac" && info.durationMs > info.startMs && info.output.bitrateKbps in listOf(128, 192, 256, 320)))
            PlaybackRequest.stream(base, target, info.streamUrl)
        } catch (_: Exception) { throw PlaybackResolutionException(AppLanguage.string(R.string.pb_res_invalid_info)) }
        synchronized(this) { plans["$profile:$uri"] = Resolved(info, android.os.SystemClock.elapsedRealtime()) }
        cache.put(key, gson.toJson(info).toByteArray(), profile)
        changed.tryEmit(Unit)
        return info
    }

    fun factory(upstream: DataSource.Factory): DataSource.Factory = DataSource.Factory {
        var source = upstream.createDataSource()
        object : DataSource {
            override fun addTransferListener(listener: TransferListener) = source.addTransferListener(listener)
            override fun open(spec: DataSpec): Long {
                val uri = spec.uri.toString()
                downloads.playableFile(uri)?.let { file ->
                    source = androidx.media3.datasource.FileDataSource()
                    return source.open(spec.withUri(Uri.fromFile(file)))
                }
                if (!PlaybackRequest.isAac(uri)) return source.open(spec)
                val plan = resolve(uri)
                val base = session.endpoint ?: throw PlaybackResolutionException(AppLanguage.string(R.string.pb_res_not_connected))
                val target = PlaybackRequest.stream(base, uri.toHttpUrl(), plan.streamUrl)
                return source.open(spec.withUri(Uri.parse(target.toString())))
            }
            override fun read(buffer: ByteArray, offset: Int, length: Int) = source.read(buffer, offset, length)
            override fun getUri(): Uri? = source.uri
            override fun getResponseHeaders(): Map<String, List<String>> = source.responseHeaders
            override fun close() = source.close()
        }
    }
}
