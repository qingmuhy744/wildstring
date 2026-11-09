package com.wildstring.app.playback

import androidx.media3.common.PlaybackException
import androidx.media3.datasource.HttpDataSource
import com.wildstring.app.AppLanguage
import com.wildstring.app.R

private val PODCAST_GENERIC get() = AppLanguage.string(R.string.pb_err_podcast_generic)
private val TRACK_GENERIC get() = AppLanguage.string(R.string.pb_err_track_generic)
private val PODCAST_UPSTREAM get() = AppLanguage.string(R.string.pb_err_podcast_upstream)
private val PODCAST_FAKE_IP get() = AppLanguage.string(R.string.pb_err_podcast_fake_ip)

/** Turns a player error into user text, using the server's error code when the stream returned one. */
fun playbackErrorMessage(error: PlaybackException, podcast: Boolean): String {
    val chain = generateSequence<Throwable>(error) { it.cause }
    chain.filterIsInstance<PlaybackResolutionException>().firstOrNull()?.message?.let { return it }
    val http = chain.filterIsInstance<HttpDataSource.InvalidResponseCodeException>().firstOrNull()
    if (!podcast) return trackPlaybackMessage(http?.responseCode, http?.responseBody?.decodeToString().orEmpty())
    return podcastPlaybackMessage(http?.responseCode, http?.responseBody?.decodeToString().orEmpty(),
        http == null && error.errorCode == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS)
}

/** Pure mapping so JVM tests can cover it without Media3's Android clock. */
fun podcastPlaybackMessage(responseCode: Int?, body: String, badHttpStatus: Boolean): String = when {
    "remote_url_fake_ip" in body -> PODCAST_FAKE_IP
    "podcast_audio_upstream_failed" in body || responseCode == 502 -> PODCAST_UPSTREAM
    responseCode == 416 -> AppLanguage.string(R.string.pb_err_podcast_range_exceeded)
    badHttpStatus -> PODCAST_UPSTREAM
    else -> PODCAST_GENERIC
}

/** Network failures never imply a permanently missing track. */
fun trackPlaybackMessage(responseCode: Int?, body: String): String = when {
    "audio_not_found" in body -> AppLanguage.string(R.string.pb_err_track_file_missing)
    "track_unavailable" in body -> AppLanguage.string(R.string.pb_err_track_unavailable)
    "file_changed_rescan_required" in body -> AppLanguage.string(R.string.pb_err_track_file_changed)
    "audio_unavailable" in body -> AppLanguage.string(R.string.pb_err_track_storage_unreadable)
    responseCode == 401 -> AppLanguage.string(R.string.pb_err_login_expired)
    responseCode == 404 -> AppLanguage.string(R.string.pb_err_track_not_found)
    responseCode == 409 -> AppLanguage.string(R.string.pb_err_track_changed_or_unreadable)
    else -> TRACK_GENERIC
}
