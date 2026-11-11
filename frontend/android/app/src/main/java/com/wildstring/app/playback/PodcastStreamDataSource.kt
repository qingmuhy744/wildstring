@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
package com.wildstring.app.playback

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.TransferListener
import com.wildstring.app.data.podcastArtworkUrl
import java.io.IOException
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Lives below the private audio cache, so switching transport keeps one cache and byte offset. */
internal class PodcastStreamDataSource(
    private val server: DataSource.Factory,
    private val public: DataSource.Factory,
    private val sourceUrl: (Uri) -> String?,
    private val serverFirst: () -> Boolean,
) : DataSource {
    private data class Attempt(val spec: DataSpec, val public: Boolean)
    private val listeners = mutableListOf<TransferListener>()
    private var current: DataSource? = null
    private var next: Attempt? = null
    private var original: DataSpec? = null
    private var consumed = 0L

    override fun addTransferListener(listener: TransferListener) {
        listeners += listener
        current?.addTransferListener(listener)
    }
    private fun replace(attempt: Attempt) {
        // A failed transport's cleanup must not suppress the alternative transport.
        try { current?.close() } catch (_: IOException) { }
        current = (if (attempt.public) public else server).createDataSource().also { source ->
            listeners.forEach(source::addTransferListener)
        }
    }
    private fun accessDenied(error: IOException) = error is HttpDataSource.InvalidResponseCodeException && error.responseCode in listOf(401, 403, 404)
    private fun open(attempt: Attempt): Long {
        replace(attempt)
        return try { checkNotNull(current).open(attempt.spec) }
        catch (error: IOException) {
            if (!attempt.public && accessDenied(error)) { next = null; throw error }
            val fallback = next ?: throw error
            next = null
            replace(fallback)
            checkNotNull(current).open(fallback.spec)
        }
    }
    private fun publicAttempt(spec: DataSpec, address: String) = Attempt(
        spec.buildUpon().setUri(address).setHttpRequestHeaders(emptyMap()).build(), true,
    )
    override fun open(dataSpec: DataSpec): Long {
        consumed = 0
        next = null
        original = null
        val uri = dataSpec.uri
        if (!uri.path.orEmpty().contains("/podcasts/episodes/") || uri.lastPathSegment != "stream") {
            return open(Attempt(dataSpec, false))
        }
        original = dataSpec
        val address = uri.toString().toHttpUrl()
        val proxy = Attempt(dataSpec.withUri(Uri.parse(address.newBuilder().setQueryParameter("proxy", "1").build().toString())), false)
        val direct = sourceUrl(uri)?.let { publicAttempt(dataSpec, it) }
        if (serverFirst()) {
            next = direct
            return open(proxy)
        }
        // This authenticated request reuses server-side files and preserves playback-cache
        // scheduling. Only the public 307 Location is opened with the cookie-free client.
        val probe = Attempt(dataSpec.withUri(Uri.parse(address.newBuilder().setQueryParameter("proxy", "0").build().toString())), false)
        replace(probe)
        try {
            val length = checkNotNull(current).open(probe.spec)
            next = direct
            return length
        } catch (error: IOException) {
            if (accessDenied(error)) throw error
            val location = (error as? HttpDataSource.InvalidResponseCodeException)
                ?.takeIf { it.responseCode == 307 }?.headerFields
                ?.entries?.firstOrNull { it.key.equals("Location", true) }?.value?.firstOrNull()
                ?.let(::podcastArtworkUrl)
            val preferred = location?.let { publicAttempt(dataSpec, it) } ?: direct
            next = if (preferred != null) proxy else null
            return open(preferred ?: proxy)
        }
    }
    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        val count = try { checkNotNull(current).read(buffer, offset, length) }
        catch (error: IOException) {
            val fallback = next ?: throw error
            next = null
            replace(fallback)
            checkNotNull(current).open(fallback.spec.subrange(consumed))
            checkNotNull(current).read(buffer, offset, length)
        }
        if (count != C.RESULT_END_OF_INPUT) consumed += count
        return count
    }
    override fun getUri(): Uri? = original?.uri ?: current?.uri
    override fun getResponseHeaders(): Map<String, List<String>> = current?.responseHeaders.orEmpty()
    override fun close() { next = null; current?.close(); current = null }
}
