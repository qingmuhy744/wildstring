package com.wildstring.app.playback

import androidx.media3.common.PlaybackException
import androidx.media3.datasource.HttpDataSource

private const val PODCAST_GENERIC = "无法播放本期播客，请检查连接或音频格式后重试。"
private const val TRACK_GENERIC = "无法播放这首歌，请检查连接或音频编码后重试。"
private const val PODCAST_UPSTREAM = "播客源站暂时无法连接，请稍后重试；若持续失败请检查服务端网络或出站代理。"
private const val PODCAST_FAKE_IP = "服务端 DNS 处于 fake-ip 模式，请在服务端配置出站代理或开启 WILDSTRING_PODCAST_ALLOW_FAKE_IP。"

/** Turns a player error into user text, using the server's error code when the stream returned one. */
fun playbackErrorMessage(error: PlaybackException, podcast: Boolean): String {
    val chain = generateSequence<Throwable>(error) { it.cause }
    chain.filterIsInstance<PlaybackResolutionException>().firstOrNull()?.message?.let { return it }
    if (!podcast) return TRACK_GENERIC
    val http = chain.filterIsInstance<HttpDataSource.InvalidResponseCodeException>().firstOrNull()
    return podcastPlaybackMessage(http?.responseCode, http?.responseBody?.decodeToString().orEmpty(),
        http == null && error.errorCode == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS)
}

/** Pure mapping so JVM tests can cover it without Media3's Android clock. */
fun podcastPlaybackMessage(responseCode: Int?, body: String, badHttpStatus: Boolean): String = when {
    "remote_url_fake_ip" in body -> PODCAST_FAKE_IP
    "podcast_audio_upstream_failed" in body || responseCode == 502 -> PODCAST_UPSTREAM
    responseCode == 416 -> "播放位置超出了本期音频的范围，请从头播放。"
    badHttpStatus -> PODCAST_UPSTREAM
    else -> PODCAST_GENERIC
}
