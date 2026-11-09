package com.wildstring.app.data

import com.wildstring.app.AppLanguage
import com.wildstring.app.R
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Wire format is shared with the backend; a zero bitrate always means original audio. */
object PlaybackRequest {
    val bitrates = listOf(0, 128, 192, 256, 320)
    fun url(original: String, bitrate: Int, startMs: Long = 0): String {
        require(bitrate in bitrates && startMs >= 0)
        val source = original.toHttpUrl()
        val podcast = source.encodedPath.contains("/podcasts/episodes/") && source.encodedPath.endsWith("/stream")
        return source.newBuilder().removeAllQueryParameters("format")
            .removeAllQueryParameters("bitrate_kbps").removeAllQueryParameters("start_ms").apply {
                if (bitrate != 0 && !podcast) { addQueryParameter("format", "aac"); addQueryParameter("bitrate_kbps", bitrate.toString()); addQueryParameter("start_ms", startMs.toString()) }
            }.build().toString()
    }
    fun isAac(url: String) = url.toHttpUrl().queryParameter("format") == "aac"
    fun offset(url: String) = url.toHttpUrl().queryParameter("start_ms")?.toLongOrNull()?.coerceAtLeast(0) ?: 0L
    fun stream(base: HttpUrl, requested: HttpUrl, returned: String): HttpUrl {
        val resolved = base.resolve(returned.removePrefix("/")) ?: throw IllegalArgumentException(AppLanguage.string(R.string.pb_req_invalid_stream_url))
        require(ServerAddress.contains(base, resolved) && resolved.username.isEmpty() && resolved.password.isEmpty() &&
            resolved.encodedPath == requested.encodedPath && resolved.fragment == null &&
            resolved.queryParameterNames.all { it in setOf("format", "bitrate_kbps", "start_ms") }) { AppLanguage.string(R.string.pb_req_unsafe_stream_url) }
        return resolved
    }
}
